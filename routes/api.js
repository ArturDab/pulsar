const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { postToSlack, getRecentMessages } = require('../services/slack');
const { runPipeline, refilterItems, getStatus } = require('../services/pipeline');

router.get('/news', async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM news_items WHERE status IN ('free','slack_taken') ORDER BY published_at DESC"
    );
    const clustersMap = {};
    for (const item of rows) {
      const cid = item.cluster_id || 'inne-tematy';
      if (!clustersMap[cid]) {
        clustersMap[cid] = {
          cluster_id: cid, cluster_label: item.cluster_label || 'Inne tematy',
          newest_at: item.published_at, items: []
        };
      }
      if (!clustersMap[cid].newest_at || new Date(item.published_at) > new Date(clustersMap[cid].newest_at))
        clustersMap[cid].newest_at = item.published_at;
      clustersMap[cid].items.push(item);
    }
    res.json(Object.values(clustersMap).sort((a, b) => new Date(b.newest_at) - new Date(a.newest_at)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/news/taken', async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM news_items WHERE status='taken' ORDER BY fetched_at DESC LIMIT 30"
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

router.post('/news/:id/take', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM news_items WHERE id=$1', [req.params.id]);
    const item = rows[0];
    if (!item) return res.status(404).json({ error: 'Not found' });
    if (item.status === 'taken') return res.status(409).json({ error: 'Already taken' });
    if (item.status === 'slack_taken') return res.status(409).json({ error: 'Zajęte przez: ' + (item.reserved_by || 'kogoś') });

    try {
      await postToSlack(item.url);
    } catch (slackErr) {
      console.error('[Take] Slack post failed:', slackErr.message);
      return res.status(502).json({ error: 'Nie udało się wysłać na Slacka: ' + slackErr.message });
    }

    const makeUrl = process.env.MAKE_WEBHOOK_URL;
    if (makeUrl) {
      fetch(makeUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: item.url })
      }).catch(e => console.error('[Make] Webhook failed:', e.message));
    }
    await pool.query("UPDATE news_items SET status='taken' WHERE id=$1", [item.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manual URL send - webhook via backend
router.post('/manual-send', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  try { new URL(url); } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  const makeUrl = process.env.MAKE_WEBHOOK_URL;
  if (!makeUrl) return res.status(501).json({ error: 'MAKE_WEBHOOK_URL not configured' });
  try {
    const r = await fetch(makeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    if (!r.ok) throw new Error(`Make responded with ${r.status}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: 'Make webhook failed: ' + e.message });
  }
});

router.get('/feeds', async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM feeds ORDER BY created_at')).rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/feeds', async (req, res) => {
  try {
    const { url, name } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    const { rows } = await pool.query(
      'INSERT INTO feeds (url,name) VALUES ($1,$2) RETURNING *',
      [url, name || new URL(url).hostname]
    );
    res.json(rows[0]);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.patch('/feeds/:id/toggle', async (req, res) => {
  try {
    const { rows } = await pool.query('UPDATE feeds SET active=NOT active WHERE id=$1 RETURNING *', [req.params.id]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/feeds/:id', async (req, res) => {
  try { await pool.query('DELETE FROM feeds WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/settings/:key', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT value FROM settings WHERE key=$1', [req.params.key]);
    res.json({ value: rows[0]?.value || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/settings/:key', async (req, res) => {
  try {
    await pool.query(
      'INSERT INTO settings (key,value,updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (key) DO UPDATE SET value=$2,updated_at=NOW()',
      [req.params.key, req.body.value]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/pipeline/run', (req, res) => { runPipeline(); res.json({ ok: true }); });
router.post('/pipeline/refilter', (req, res) => { refilterItems(); res.json({ ok: true }); });

router.get('/pipeline/status', async (req, res) => {
  try {
    const status = getStatus();
    const { rows } = await pool.query('SELECT * FROM pipeline_runs ORDER BY started_at DESC LIMIT 1');
    res.json({ ...status, lastRun: rows[0] || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/stats', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status='free') AS free,
        COUNT(*) FILTER (WHERE status='taken') AS taken,
        COUNT(*) FILTER (WHERE status='slack_taken') AS slack_taken,
        COUNT(*) FILTER (WHERE status='rejected') AS rejected,
        COUNT(*) AS total
      FROM news_items
    `);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/slack/messages', async (req, res) => {
  try {
    const messages = await getRecentMessages(40);
    res.json(messages);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;