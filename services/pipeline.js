const { pool } = require('../db');
const { fetchFeed } = require('./rss');
const { getSlackUrlMap } = require('./slack');
const { filterAndCluster, reclusterAndRescore } = require('./gemini');

let lastRun = null;
let isRunning = false;
let isRefiltering = false;

async function getInstructions() {
  const { rows } = await pool.query(
    "SELECT key, value FROM settings WHERE key IN ('router_instructions','temperature_instructions')"
  );
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return { router: map.router_instructions || '', temperature: map.temperature_instructions || '' };
}

function cleanTitle(title) {
  if (!title) return '';
  if (title.trim().startsWith('http')) return '';
  if (/<[^>]+>/.test(title)) return '';
  return title.trim();
}

// Normalizacja URL do porównań - Gemini lubi modyfikować URLe
function normUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    // Usuń trailing slash, fragment, sortuj parametry
    u.hash = '';
    let path = u.pathname.replace(/\/+$/, '') || '/';
    return (u.origin + path + u.search).toLowerCase();
  } catch {
    return url.toLowerCase().replace(/\/+$/, '');
  }
}

// Buduje mapę normalizedUrl → original item dla szybkiego i odpornego matchowania
function buildUrlMap(items) {
  const map = new Map();
  for (const item of items) {
    map.set(normUrl(item.url), item);
  }
  return map;
}

function findOriginal(urlMap, geminiUrl) {
  // Dokładne dopasowanie po normalizacji
  const norm = normUrl(geminiUrl);
  if (urlMap.has(norm)) return urlMap.get(norm);
  // Fallback: szukaj po zawieraniu (Gemini czasem ucina query string)
  for (const [key, item] of urlMap) {
    if (key.includes(norm) || norm.includes(key)) return item;
  }
  return null;
}

async function runPipeline() {
  if (isRunning) { console.log('[Pipeline] Already running'); return; }
  isRunning = true;

  let runId = null;
  try {
    const { rows: [run] } = await pool.query('INSERT INTO pipeline_runs DEFAULT VALUES RETURNING id');
    runId = run.id;
  } catch (err) {
    console.error('[Pipeline] Cannot create run:', err.message);
    isRunning = false;
    return;
  }

  try {
    const { rows: feeds } = await pool.query('SELECT url, name FROM feeds WHERE active = true');
    if (!feeds.length) {
      console.log('[Pipeline] No active feeds');
      await closeRun(runId, 0, 0);
      return;
    }

    // Pobierz itemy z RSS
    let allItems = [];
    for (const feed of feeds) {
      try {
        const items = await fetchFeed(feed.url);
        allItems.push(...items);
      } catch (err) {
        console.error(`[Pipeline] Feed error ${feed.name}: ${err.message}`);
      }
    }
    console.log(`[Pipeline] Fetched ${allItems.length} items from ${feeds.length} feeds`);

    if (!allItems.length) {
      await closeRun(runId, 0, 0);
      return;
    }

    // Dedup - tylko ostatnie 30 dni zamiast całej tabeli
    const { rows: existingUrls } = await pool.query(
      "SELECT url FROM news_items WHERE published_at > NOW() - INTERVAL '30 days'"
    );
    const existingSet = new Set(existingUrls.map(r => r.url));
    let newItems = allItems.filter(i => !existingSet.has(i.url));

    // Slack dedup - ostatnie 7 dni
    let slackMap = new Map();
    try {
      slackMap = await getSlackUrlMap(7);
    } catch (err) {
      console.warn('[Pipeline] Slack fetch failed, skipping Slack dedup:', err.message);
    }

    // Zapisz itemy znalezione na Slacku
    for (const item of newItems) {
      if (slackMap.has(item.url)) {
        await pool.query(`
          INSERT INTO news_items (url, title, source, status, reserved_by, published_at)
          VALUES ($1, $2, $3, 'slack_taken', $4, $5)
          ON CONFLICT (url) DO NOTHING
        `, [item.url, cleanTitle(item.title), item.source, slackMap.get(item.url), item.published_at]).catch(() => {});
      }
    }

    newItems = newItems.filter(i => !slackMap.has(i.url));
    console.log(`[Pipeline] ${newItems.length} new items after dedup`);

    if (!newItems.length) {
      await closeRun(runId, 0, 0);
      return;
    }

    // Istniejące klastry z 48h
    const { rows: clusters } = await pool.query(`
      SELECT DISTINCT cluster_id, cluster_label FROM news_items
      WHERE fetched_at > NOW() - INTERVAL '48 hours' AND cluster_id IS NOT NULL
    `);

    const instr = await getInstructions();
    const processed = await filterAndCluster(newItems, clusters, instr.router, instr.temperature);
    console.log(`[Pipeline] Gemini returned ${processed.length} results`);

    const urlMap = buildUrlMap(newItems);
    let saved = 0, rejected = 0, unmatched = 0;

    for (const item of processed) {
      const original = findOriginal(urlMap, item.url);
      if (!original) {
        unmatched++;
        if (unmatched <= 3) console.warn(`[Pipeline] URL mismatch: "${item.url}"`);
        continue;
      }

      // Zawsze używaj oryginalnego URL z RSS, nie tego co zwrócił Gemini
      const url = original.url;

      if (!item.relevant) {
        await pool.query(`
          INSERT INTO news_items (url, title, summary, source, cluster_id, cluster_label, status, temperature, published_at)
          VALUES ($1, $2, $3, $4, 'odrzucone', 'Odrzucone', 'rejected', 1, $5)
          ON CONFLICT (url) DO NOTHING
        `, [url, cleanTitle(original.title), item.summary || '', original.source, original.published_at]).catch(() => {});
        rejected++;
        continue;
      }

      try {
        await pool.query(`
          INSERT INTO news_items (url, title, summary, source, cluster_id, cluster_label, temperature, published_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (url) DO NOTHING
        `, [
          url, cleanTitle(original.title), item.summary || '', original.source,
          item.cluster_id || 'inne-tematy', item.cluster_label || 'Inne tematy',
          Math.min(10, Math.max(1, item.temperature || 5)), original.published_at
        ]);
        saved++;
      } catch (e) { console.error('[Pipeline] Insert error:', e.message); }
    }

    if (unmatched > 0) console.warn(`[Pipeline] ${unmatched}/${processed.length} URL mismatches`);
    await closeRun(runId, newItems.length, saved);
    console.log(`[Pipeline] Done: ${saved} saved, ${rejected} rejected, ${unmatched} unmatched`);

  } catch (err) {
    console.error('[Pipeline] Fatal:', err.message);
    await closeRun(runId, 0, 0, err.message);
  } finally {
    lastRun = new Date();
    isRunning = false;
  }
}

async function closeRun(runId, fetched, saved, error = null) {
  if (!runId) return;
  try {
    if (error) {
      await pool.query(
        'UPDATE pipeline_runs SET finished_at=NOW(), items_fetched=$1, items_saved=$2, error=$3 WHERE id=$4',
        [fetched, saved, error, runId]
      );
    } else {
      await pool.query(
        'UPDATE pipeline_runs SET finished_at=NOW(), items_fetched=$1, items_saved=$2 WHERE id=$3',
        [fetched, saved, runId]
      );
    }
  } catch (e) {
    console.error('[Pipeline] Cannot close run:', e.message);
  }
}

async function refilterItems() {
  if (isRefiltering) { console.log('[Refilter] Already running'); return; }
  isRefiltering = true;
  console.log('[Refilter] Starting...');
  try {
    const { rows: items } = await pool.query(
      "SELECT * FROM news_items WHERE status = 'free' ORDER BY published_at DESC"
    );
    if (!items.length) {
      console.log('[Refilter] No free items to refilter');
      isRefiltering = false;
      return;
    }

    const { rows: clusters } = await pool.query(
      "SELECT DISTINCT cluster_id, cluster_label FROM news_items WHERE cluster_id IS NOT NULL AND cluster_id != 'inne-tematy'"
    );

    const instr = await getInstructions();
    const processed = await reclusterAndRescore(items, clusters, instr.router, instr.temperature);

    let updated = 0;
    const urlMap = buildUrlMap(items);
    for (const item of processed) {
      const original = findOriginal(urlMap, item.url);
      if (!original) continue;
      try {
        await pool.query(`
          UPDATE news_items SET
            summary = COALESCE(NULLIF($1,''), summary),
            cluster_id = $2,
            cluster_label = $3,
            temperature = $4
          WHERE id = $5
        `, [
          item.summary || '',
          item.cluster_id || 'inne-tematy',
          item.cluster_label || 'Inne tematy',
          Math.min(10, Math.max(1, item.temperature || 5)),
          original.id
        ]);
        updated++;
      } catch (e) {
        console.error('[Refilter] Update error:', e.message);
      }
    }
    console.log(`[Refilter] Done: ${updated}/${items.length} items updated`);
  } catch (err) {
    console.error('[Refilter] Fatal:', err.message);
  } finally { isRefiltering = false; }
}

function getStatus() { return { lastRun, isRunning, isRefiltering }; }
module.exports = { runPipeline, refilterItems, getStatus };