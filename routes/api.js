const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { postToSlack, getRecentMessages } = require('../services/slack');
const { runPipeline, refilterItems, getStatus } = require('../services/pipeline');
const { scrapeOgImages } = require('../services/og');

// --- NEWS (includes reserved items in wolne view) ---
router.get('/news', async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM news_items WHERE status IN ('free','reserved','produced','dismissed','slack_taken') ORDER BY published_at DESC"
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

// Produce - send to Make.com webhook, mark as produced
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

    await pool.query("UPDATE news_items SET status='produced' WHERE id=$1", [item.id]);
    res.json({ ok: true });
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

module.exports = router;
