const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { postToSlack, getRecentMessages, deleteMessageByUrl } = require('../services/slack');
const { runPipeline, refilterItems, getStatus } = require('../services/pipeline');
const { scrapeOgImages } = require('../services/og');
const { fetchReviewFeed } = require('../services/reviews-feed');

// --- NEWS (all statuses for inline display) ---
router.get('/news', async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM news_items WHERE status IN ('free','reserved','produced','dismissed','rejected','slack_taken') ORDER BY published_at DESC"
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/news/taken', async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM news_items WHERE status IN ('reserved','produced','taken') ORDER BY fetched_at DESC LIMIT 50"
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/news/rejected', async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM news_items WHERE status='rejected' ORDER BY published_at DESC LIMIT 100"
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- ACTIONS ---

// Dismiss - gray out card, stays in view
router.post('/news/:id/dismiss', async (req, res) => {
  try {
    const { rows } = await pool.query(
      "UPDATE news_items SET status='dismissed' WHERE id=$1 AND status IN ('free','reserved') RETURNING *", [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Reserve - post to Slack, stays in wolne (green)
router.post('/news/:id/reserve', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM news_items WHERE id=$1', [req.params.id]);
    const item = rows[0];
    if (!item) return res.status(404).json({ error: 'Not found' });
    if (item.status === 'slack_taken') return res.status(409).json({ error: 'Zajęte przez: ' + (item.reserved_by || 'kogoś') });

    try { await postToSlack(item.url); } catch (e) {
      console.error('[Reserve] Slack failed:', e.message);
      return res.status(502).json({ error: 'Slack error: ' + e.message });
    }

    await pool.query("UPDATE news_items SET status='reserved' WHERE id=$1", [item.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Produce - send to Make.com webhook, increment counter
router.post('/news/:id/produce', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM news_items WHERE id=$1', [req.params.id]);
    const item = rows[0];
    if (!item) return res.status(404).json({ error: 'Not found' });

    const makeUrl = process.env.MAKE_WEBHOOK_URL;
    if (makeUrl) {
      const r = await fetch(makeUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: item.url })
      });
      if (!r.ok) console.error('[Make] Webhook returned:', r.status);
    }

    const { rows: updated } = await pool.query(
      "UPDATE news_items SET status='produced', produce_count = COALESCE(produce_count, 0) + 1 WHERE id=$1 RETURNING produce_count",
      [item.id]
    );
    res.json({ ok: true, produce_count: updated[0].produce_count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Restore rejected item back to free
router.post('/news/:id/restore', async (req, res) => {
  try {
    const { rows } = await pool.query(
      "UPDATE news_items SET status='free', rejection_reason=NULL WHERE id=$1 AND status='rejected' RETURNING *",
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found or not rejected' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/news/:id/unreserve', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM news_items WHERE id=$1", [req.params.id]);
    const item = rows[0];
    if (!item) return res.status(404).json({ error: 'Not found' });
    if (!['reserved', 'slack_taken'].includes(item.status)) return res.status(400).json({ error: 'Nie zarezerwowany' });

    // Try to delete the Slack message
    try { await deleteMessageByUrl(item.url); } catch (e) { console.warn('[Unreserve] Slack delete failed:', e.message); }

    await pool.query("UPDATE news_items SET status='free', reserved_by=NULL WHERE id=$1", [item.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manual URL send
router.post('/manual-send', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
  const makeUrl = process.env.MAKE_WEBHOOK_URL;
  if (!makeUrl) return res.status(501).json({ error: 'MAKE_WEBHOOK_URL not set' });
  try {
    const r = await fetch(makeUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    if (!r.ok) throw new Error(`Make: ${r.status}`);
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// --- FEEDS ---
router.get('/feeds', async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM feeds ORDER BY created_at')).rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/feeds', async (req, res) => {
  try {
    const { url, name } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });
    const { rows } = await pool.query('INSERT INTO feeds (url,name) VALUES ($1,$2) RETURNING *', [url, name || new URL(url).hostname]);
    res.json(rows[0]);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.patch('/feeds/:id/toggle', async (req, res) => {
  try { res.json((await pool.query('UPDATE feeds SET active=NOT active WHERE id=$1 RETURNING *', [req.params.id])).rows[0]); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/feeds/:id', async (req, res) => {
  try { await pool.query('DELETE FROM feeds WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// --- SETTINGS ---
router.get('/settings/:key', async (req, res) => {
  try { const { rows } = await pool.query('SELECT value FROM settings WHERE key=$1', [req.params.key]); res.json({ value: rows[0]?.value || '' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/settings/:key', async (req, res) => {
  try {
    await pool.query('INSERT INTO settings (key,value,updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (key) DO UPDATE SET value=$2,updated_at=NOW()', [req.params.key, req.body.value]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- PIPELINE ---
router.post('/pipeline/run', (req, res) => { runPipeline(); res.json({ ok: true }); });
router.post('/pipeline/refilter', (req, res) => { refilterItems(); res.json({ ok: true }); });
router.post('/pipeline/scrape-og', (req, res) => { scrapeOgImages(); res.json({ ok: true }); });
router.get('/pipeline/status', async (req, res) => {
  try {
    const status = getStatus();
    const { rows } = await pool.query('SELECT * FROM pipeline_runs ORDER BY started_at DESC LIMIT 1');
    res.json({ ...status, lastRun: rows[0] || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- STATS ---
router.get('/stats', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT
      COUNT(*) FILTER (WHERE status='free') AS free,
      COUNT(*) FILTER (WHERE status='reserved') AS reserved,
      COUNT(*) FILTER (WHERE status IN ('produced','taken')) AS produced,
      COUNT(*) FILTER (WHERE status='slack_taken') AS slack_taken,
      COUNT(*) FILTER (WHERE status='rejected') AS rejected,
      COUNT(*) AS total FROM news_items`);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- SLACK ---
router.get('/slack/messages', async (req, res) => {
  try { res.json(await getRecentMessages(40)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Quick Slack sync - check free items against Slack URLs without running full pipeline
router.post('/slack/sync', async (req, res) => {
  try {
    const { getSlackUrlMap } = require('../services/slack');
    const rawMap = await getSlackUrlMap(7);
    if (!rawMap.size) return res.json({ synced: 0 });

    // Normalize slack URLs
    const slackMap = new Map();
    for (const [url, user] of rawMap) {
      const n = url.toLowerCase().replace(/\/+$/, '');
      slackMap.set(n, user);
    }

    const { rows: freeItems } = await pool.query("SELECT id, url FROM news_items WHERE status IN ('free','reserved','produced')");
    let synced = 0;
    for (const item of freeItems) {
      const n = item.url.toLowerCase().replace(/\/+$/, '');
      if (slackMap.has(n)) {
        await pool.query("UPDATE news_items SET status='slack_taken', reserved_by=$1 WHERE id=$2", [slackMap.get(n), item.id]);
        synced++;
      }
    }
    console.log(`[Slack sync] Marked ${synced} items as taken`);
    res.json({ synced });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- REVIEWS ---
router.get('/reviews', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM review_projects ORDER BY created_at DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/reviews', async (req, res) => {
  try {
    const { game_title, links, notes } = req.body;
    if (!game_title) return res.status(400).json({ error: 'Tytuł gry wymagany' });
    const { rows } = await pool.query(
      'INSERT INTO review_projects (game_title, links, notes) VALUES ($1, $2, $3) RETURNING *',
      [game_title, links || [], notes || '']
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/reviews/:id', async (req, res) => {
  try {
    const { game_title, links, notes } = req.body;
    const { rows } = await pool.query(
      'UPDATE review_projects SET game_title=COALESCE($1,game_title), links=COALESCE($2,links), notes=COALESCE($3,notes) WHERE id=$4 RETURNING *',
      [game_title, links, notes, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/reviews/:id', async (req, res) => {
  try { await pool.query('DELETE FROM review_projects WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/reviews/:id/produce', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM review_projects WHERE id=$1', [req.params.id]);
    const item = rows[0];
    if (!item) return res.status(404).json({ error: 'Not found' });

    const makeUrl = process.env.MAKE_REVIEW_WEBHOOK_URL || process.env.MAKE_WEBHOOK_URL;
    if (makeUrl && item.links && item.links.length) {
      // Send each link as a separate webhook call (like news)
      for (const link of item.links) {
        await fetch(makeUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: link })
        }).catch(e => console.error('[Make] Review webhook failed:', e.message));
      }
    }

    const { rows: updated } = await pool.query(
      "UPDATE review_projects SET status='produced', produce_count = produce_count + 1 WHERE id=$1 RETURNING *",
      [item.id]
    );
    res.json(updated[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- METACRITIC ---
router.get('/metacritic', async (req, res) => {
  try { res.json(await fetchReviewFeed()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// --- FELIETONY ---
router.get('/felietony', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM felieton_ideas ORDER BY created_at DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/felietony/generate', async (req, res) => {
  try {
    const { direction, current_events } = req.body;
    const { callAI, parseJsonFromAI, isGeminiModel } = require('../services/ai');
    const { getModelForTask } = require('../services/gemini');

    const { rows: settingsRows } = await pool.query("SELECT value FROM settings WHERE key='felieton_instructions'");
    const instructions = settingsRows[0]?.value || '';
    const model = await getModelForTask('felieton');

    const currentCtx = current_events
      ? `\nWAŻNE: Propozycje MUSZĄ nawiązywać do bieżących wydarzeń w branży gier. Najpierw przeszukaj internet, sprawdź co się dzieje w gamingu w ostatnich dniach (premiery, kontrowersje, ogłoszenia, trendy), a potem zaproponuj felietony powiązane z aktualnymi tematami. Każdy brief powinien odwoływać się do konkretnego, świeżego wydarzenia.`
      : '';

    const prompt = `${instructions}
${currentCtx}
${direction ? '\nKierunek tematyczny wskazany przez redaktora: ' + direction : '\nRedaktor nie podał kierunku - zaproponuj kreatywnie różnorodne tematy.'}

Wygeneruj DOKŁADNIE 10 propozycji felietonów. Dla każdej podaj:
- title: chwytliwy, prowokujący tytuł roboczy (po polsku)
- brief: 2-3 zdania opisujące kąt, ton i główną tezę felietonu (po polsku)

Odpowiedz TYLKO czystym JSON array, bez żadnego tekstu przed ani po:
[{"title":"...","brief":"..."}]`;

    // Google Search grounding only works with Gemini models
    const tools = (current_events && isGeminiModel(model)) ? [{ google_search: {} }] : null;
    const raw = await callAI(prompt, { model, temperature: 0.9, maxTokens: 4096, tools });
    const ideas = parseJsonFromAI(raw);

    if (!Array.isArray(ideas)) throw new Error('AI nie zwróciło tablicy');

    const saved = [];
    for (const idea of ideas.slice(0, 10)) {
      if (!idea.title) continue;
      const { rows } = await pool.query(
        'INSERT INTO felieton_ideas (title, brief, direction) VALUES ($1, $2, $3) RETURNING *',
        [idea.title, idea.brief || '', direction || '']
      );
      saved.push(rows[0]);
    }

    res.json(saved);
  } catch (e) {
    console.error('[Felietony] Generate error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.put('/felietony/:id', async (req, res) => {
  try {
    const { title, brief } = req.body;
    const { rows } = await pool.query(
      'UPDATE felieton_ideas SET title=COALESCE($1,title), brief=COALESCE($2,brief) WHERE id=$3 RETURNING *',
      [title, brief, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/felietony/:id', async (req, res) => {
  try { await pool.query('DELETE FROM felieton_ideas WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/felietony/:id/produce', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM felieton_ideas WHERE id=$1', [req.params.id]);
    const item = rows[0];
    if (!item) return res.status(404).json({ error: 'Not found' });

    const { rows: settingsRows } = await pool.query("SELECT value FROM settings WHERE key='felieton_instructions'");
    const instructions = settingsRows[0]?.value || '';

    const makeUrl = process.env.MAKE_FELIETON_WEBHOOK_URL || process.env.MAKE_WEBHOOK_URL;
    if (makeUrl) {
      await fetch(makeUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'felieton',
          title: item.title,
          brief: item.brief,
          instructions: instructions
        })
      }).catch(e => console.error('[Make] Felieton webhook failed:', e.message));
    }

    const { rows: updated } = await pool.query(
      "UPDATE felieton_ideas SET status='sent', produce_count = produce_count + 1 WHERE id=$1 RETURNING *",
      [item.id]
    );
    res.json(updated[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
