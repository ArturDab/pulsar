const { pool } = require('../db');
const { fetchFeed } = require('./rss');
const { getSlackUrlMap } = require('./slack');
const { filterAndCluster, getModelForTask } = require('./gemini');
const { callAI, parseJsonFromAI } = require('./ai');
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
    try {
      const rawMap = await getSlackUrlMap(7);
      // Normalize slack URLs for matching
      for (const [url, user] of rawMap) slackMap.set(normUrl(url), user);
    } catch {}

    for (const item of newItems) {
      const nurl = normUrl(item.url);
      if (slackMap.has(nurl)) {
        await pool.query(`INSERT INTO news_items (url, title, source, status, reserved_by, published_at)
          VALUES ($1,$2,$3,'slack_taken',$4,$5) ON CONFLICT (url) DO NOTHING`,
          [item.url, cleanTitle(item.title), item.source, slackMap.get(nurl), item.published_at]).catch(() => {});
      }
    }

    // Also mark existing free items that appeared on Slack since last run
    if (slackMap.size > 0) {
      const { rows: freeItems } = await pool.query("SELECT id, url FROM news_items WHERE status = 'free'");
      for (const fi of freeItems) {
        const nfi = normUrl(fi.url);
        if (slackMap.has(nfi)) {
          await pool.query("UPDATE news_items SET status='slack_taken', reserved_by=$1 WHERE id=$2",
            [slackMap.get(nfi), fi.id]).catch(() => {});
        }
      }
    }

    newItems = newItems.filter(i => !slackMap.has(normUrl(i.url)));
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
    if (saved > 0) refilterItems(3).catch(e => console.error('[AutoRefilter]', e.message));

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

async function refilterItems(days = 3) {
  if (isRefiltering) return;
  isRefiltering = true;
  try {
    const { rows: items } = await pool.query(
      "SELECT id, url, headline, summary FROM news_items WHERE status='free' AND published_at > NOW() - INTERVAL '"+days+" days' ORDER BY published_at DESC"
    );
    if (!items.length) { console.log('[Refilter] No items to rescore'); return; }
    console.log(`[Refilter] Rescoring temperature for ${items.length} items`);

    const { rows: sr } = await pool.query("SELECT value FROM settings WHERE key='temperature_instructions'");
    const tempInstructions = sr[0]?.value || '';
    const model = await getModelForTask('temperature');

    const BATCH = 10;
    let updated = 0;
    for (let i = 0; i < items.length; i += BATCH) {
      const batch = items.slice(i, i + BATCH);
      const ctx = JSON.stringify(batch.map((r, idx) => ({ idx, headline: r.headline || '', summary: r.summary || '' })));
      const prompt = `${tempInstructions}

Oceń potencjał redakcyjny każdego artykułu w skali 1-10.
8-10 = gorący news, 6-7 = mocny, 4-5 = solidny, 1-3 = niski potencjał

Artykuły (${batch.length} sztuk):
${ctx}

Odpowiedz TYLKO czystym JSON array z polami idx i temperature:
[{"idx":0,"temperature":7}]`;

      try {
        const raw = await callAI(prompt, { model, temperature: 0.1, maxTokens: 512 });
        const results = parseJsonFromAI(raw);
        if (Array.isArray(results)) {
          for (const r of results) {
            if (r.idx == null || !batch[r.idx]) continue;
            const temp = Math.min(10, Math.max(1, Number(r.temperature) || 5));
            await pool.query('UPDATE news_items SET temperature=$1 WHERE id=$2', [temp, batch[r.idx].id]);
            updated++;
          }
        }
      } catch (err) {
        console.error(`[Refilter] Batch ${Math.floor(i/BATCH)+1} failed: ${err.message}`);
      }
      if (i + BATCH < items.length) await new Promise(r => setTimeout(r, 800));
    }
    console.log(`[Refilter] Done: ${updated}/${items.length}`);
  } catch (err) { console.error('[Refilter]', err.message); }
  finally { isRefiltering = false; }
}

function getStatus() { return { lastRun, isRunning, isRefiltering }; }
module.exports = { runPipeline, refilterItems, getStatus };
