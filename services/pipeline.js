const { pool } = require('../db');
const { fetchFeed } = require('./rss');
const { getSlackUrlMap } = require('./slack');
const { filterAndCluster, reclusterAndRescore } = require('./gemini');
const { scrapeOgImages } = require('./og');

let lastRun = null, isRunning = false, isRefiltering = false;

async function getInstructions() {
  const { rows } = await pool.query("SELECT key, value FROM settings WHERE key IN ('router_instructions','temperature_instructions','training_good','training_bad')");
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));

  let router = map.router_instructions || '';

  // Append training examples to router instructions
  try {
    const good = JSON.parse(map.training_good || '[]');
    const bad = JSON.parse(map.training_bad || '[]');
    if (good.length) {
      router += '\n\nPRZYKŁADY DOBRYCH NEWSÓW - ucz się z nich, podobne tematy oceniaj wysoko:\n' +
        good.map(e => `- "${e.title}" (temperatura: ${e.temperature}) - ${e.reason}`).join('\n');
    }
    if (bad.length) {
      router += '\n\nPRZYKŁADY ZŁYCH NEWSÓW - odrzucaj podobne tematy:\n' +
        bad.map(e => `- "${e.title}" - ${e.reason}`).join('\n');
    }
  } catch {}

  return { router, temperature: map.temperature_instructions || '' };
}

function cleanTitle(t) { if (!t) return ''; if (t.trim().startsWith('http') || /<[^>]+>/.test(t)) return ''; return t.trim(); }

function normUrl(url) {
  if (!url) return '';
  try { const u = new URL(url); u.hash = ''; return (u.origin + u.pathname.replace(/\/+$/, '') + u.search).toLowerCase(); }
  catch { return url.toLowerCase().replace(/\/+$/, ''); }
}

function buildUrlMap(items) {
  const m = new Map();
  for (const i of items) m.set(normUrl(i.url), i);
  return m;
}

function findOriginal(map, url) {
  const n = normUrl(url);
  if (map.has(n)) return map.get(n);
  for (const [k, v] of map) { if (k.includes(n) || n.includes(k)) return v; }
  return null;
}

async function runPipeline() {
  if (isRunning) return;
  isRunning = true;
  let runId = null;

  try {
    const { rows: [run] } = await pool.query('INSERT INTO pipeline_runs DEFAULT VALUES RETURNING id');
    runId = run.id;

    const { rows: feeds } = await pool.query('SELECT url, name FROM feeds WHERE active = true');
    if (!feeds.length) { await closeRun(runId, 0, 0); return; }

    let allItems = [];
    for (const feed of feeds) {
      try { allItems.push(...await fetchFeed(feed.url)); } catch (e) { console.error(`[Pipeline] Feed error: ${e.message}`); }
    }
    console.log(`[Pipeline] Fetched ${allItems.length} items from ${feeds.length} feeds`);

    const { rows: existingUrls } = await pool.query("SELECT url FROM news_items WHERE published_at > NOW() - INTERVAL '30 days'");
    const existingSet = new Set(existingUrls.map(r => r.url));
    let newItems = allItems.filter(i => !existingSet.has(i.url));

    let slackMap = new Map();
    try { slackMap = await getSlackUrlMap(7); } catch {}

    for (const item of newItems) {
      if (slackMap.has(item.url)) {
        await pool.query(`INSERT INTO news_items (url, title, source, status, reserved_by, published_at)
          VALUES ($1,$2,$3,'slack_taken',$4,$5) ON CONFLICT (url) DO NOTHING`,
          [item.url, cleanTitle(item.title), item.source, slackMap.get(item.url), item.published_at]).catch(() => {});
      }
    }

    newItems = newItems.filter(i => !slackMap.has(i.url));
    console.log(`[Pipeline] ${newItems.length} new items after dedup`);
    if (!newItems.length) { await closeRun(runId, 0, 0); return; }

    const { rows: clusters } = await pool.query(`SELECT DISTINCT cluster_id, cluster_label FROM news_items WHERE fetched_at > NOW() - INTERVAL '48 hours' AND cluster_id IS NOT NULL`);
    const instr = await getInstructions();
    const processed = await filterAndCluster(newItems, clusters, instr.router, instr.temperature);
    console.log(`[Pipeline] Gemini returned ${processed.length} results`);

    const urlMap = buildUrlMap(newItems);
    let saved = 0, rejected = 0, unmatched = 0;

    for (const item of processed) {
      const orig = findOriginal(urlMap, item.url);
      if (!orig) { unmatched++; continue; }
      const url = orig.url;

      if (!item.relevant) {
        await pool.query(`INSERT INTO news_items (url, title, headline, summary, source, cluster_id, cluster_label, status, temperature, rejection_reason, published_at)
          VALUES ($1,$2,$3,$4,$5,'odrzucone','Odrzucone','rejected',1,$6,$7) ON CONFLICT (url) DO NOTHING`,
          [url, cleanTitle(orig.title), item.headline || '', item.summary || '', orig.source, item.rejection_reason || '', orig.published_at]).catch(() => {});
        rejected++;
        continue;
      }

      try {
        await pool.query(`INSERT INTO news_items (url, title, headline, summary, source, cluster_id, cluster_label, temperature, published_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (url) DO NOTHING`,
          [url, cleanTitle(orig.title), item.headline || '', item.summary || '', orig.source,
           item.cluster_id || 'inne-tematy', item.cluster_label || 'Inne tematy',
           Math.min(10, Math.max(1, item.temperature || 5)), orig.published_at]);
        saved++;
      } catch (e) { console.error('[Pipeline] Insert error:', e.message); }
    }

    if (unmatched > 0) console.warn(`[Pipeline] ${unmatched} URL mismatches`);
    await closeRun(runId, newItems.length, saved);
    console.log(`[Pipeline] Done: ${saved} saved, ${rejected} rejected, ${unmatched} unmatched`);
    scrapeOgImages().catch(e => console.error('[OG]', e.message));

  } catch (err) {
    console.error('[Pipeline] Fatal:', err.message);
    await closeRun(runId, 0, 0, err.message);
  } finally { lastRun = new Date(); isRunning = false; }
}

async function closeRun(id, fetched, saved, error = null) {
  if (!id) return;
  try {
    await pool.query('UPDATE pipeline_runs SET finished_at=NOW(), items_fetched=$1, items_saved=$2, error=$3 WHERE id=$4',
      [fetched, saved, error, id]);
  } catch {}
}

async function refilterItems() {
  if (isRefiltering) return;
  isRefiltering = true;
  try {
    const { rows: items } = await pool.query("SELECT * FROM news_items WHERE status = 'free' ORDER BY published_at DESC");
    if (!items.length) { isRefiltering = false; return; }
    const { rows: clusters } = await pool.query("SELECT DISTINCT cluster_id, cluster_label FROM news_items WHERE cluster_id IS NOT NULL AND cluster_id != 'inne-tematy'");
    const instr = await getInstructions();
    const processed = await reclusterAndRescore(items, clusters, instr.router, instr.temperature);
    const urlMap = buildUrlMap(items);
    let updated = 0;
    for (const item of processed) {
      const orig = findOriginal(urlMap, item.url);
      if (!orig) continue;
      await pool.query(`UPDATE news_items SET headline=COALESCE(NULLIF($1,''),headline), summary=COALESCE(NULLIF($2,''),summary),
        cluster_id=$3, cluster_label=$4, temperature=$5 WHERE id=$6`,
        [item.headline || '', item.summary || '', item.cluster_id || 'inne-tematy', item.cluster_label || 'Inne tematy',
         Math.min(10, Math.max(1, item.temperature || 5)), orig.id]).catch(() => {});
      updated++;
    }
    console.log(`[Refilter] Done: ${updated}/${items.length}`);
  } catch (err) { console.error('[Refilter]', err.message); }
  finally { isRefiltering = false; }
}

function getStatus() { return { lastRun, isRunning, isRefiltering }; }
module.exports = { runPipeline, refilterItems, getStatus };
