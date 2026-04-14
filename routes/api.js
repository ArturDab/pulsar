const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { postToSlack, getRecentMessages, deleteMessageByUrl } = require('../services/slack');
const { runPipeline, refilterItems, getStatus, getLog } = require('../services/pipeline');
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

    const { rows: sr } = await pool.query("SELECT value FROM settings WHERE key='news_webhook_url'");
    const makeUrl = sr[0]?.value || process.env.MAKE_WEBHOOK_URL;
    if (!makeUrl) return res.status(400).json({ error: 'Brak URL webhooka. Dodaj go w Ustawieniach → Konfiguracja.' });

    const r = await fetch(makeUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: item.url })
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      getLog().unshift({ ts: new Date().toISOString(), type: 'error', msg: `Webhook news błąd ${r.status}`, detail: item.headline || item.url });
      return res.status(502).json({ error: `Make.com webhook błąd ${r.status}: ${txt}` });
    }
    getLog().unshift({ ts: new Date().toISOString(), type: 'webhook', msg: `News wysłany do Make.com`, detail: item.headline || item.url });

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
  const { rows: sr } = await pool.query("SELECT value FROM settings WHERE key='news_webhook_url'");
  const makeUrl = sr[0]?.value || process.env.MAKE_WEBHOOK_URL;
  if (!makeUrl) return res.status(400).json({ error: 'Brak URL webhooka. Dodaj go w Ustawieniach → Newsy.' });
  try {
    const r = await fetch(makeUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    if (!r.ok) throw new Error(`Make: ${r.status}`);
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Clear free news (keeps reserved/produced/slack_taken)
router.post('/news/clear', async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      "DELETE FROM news_items WHERE status IN ('free','dismissed','rejected')"
    );
    res.json({ ok: true, deleted: rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  try {
    const msgs = await getRecentMessages(60);
    // Collect all URLs from all messages
    const allUrls = [...new Set(msgs.flatMap(m => m.urls || []))];
    let newsMap = {};
    if (allUrls.length) {
      // Normalize URLs for matching
      const norm = u => u.replace(/\/$/, '').toLowerCase();
      const { rows } = await pool.query(
        'SELECT id, url, headline, summary, temperature, status, produce_count FROM news_items WHERE url = ANY($1)',
        [allUrls]
      );
      // Also try normalized match
      const normRows = rows.length < allUrls.length
        ? (await pool.query(
            "SELECT id, url, headline, summary, temperature, status, produce_count FROM news_items WHERE lower(rtrim(url,'/')) = ANY($1)",
            [allUrls.map(norm)]
          )).rows
        : [];
      [...rows, ...normRows].forEach(r => {
        newsMap[norm(r.url)] = r;
      });
    }
    // Attach matched news to each message
    const enriched = msgs.map(m => ({
      ...m,
      news: (m.urls || []).map(u => newsMap[u.replace(/\/$/, '').toLowerCase()]).filter(Boolean)
    }));
    res.json(enriched);
  } catch (e) { res.status(500).json({ error: e.message }); }
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

    const { rows: sr } = await pool.query("SELECT value FROM settings WHERE key='review_webhook_url'");
    const makeUrl = sr[0]?.value || process.env.MAKE_REVIEW_WEBHOOK_URL;
    if (!makeUrl) return res.status(400).json({ error: 'Brak URL webhooka. Dodaj go w Ustawieniach → Recenzje.' });

    if (item.links && item.links.length) {
      for (const link of item.links) {
        const r = await fetch(makeUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: link, title: item.game_title, notes: item.notes || '' })
        });
        if (!r.ok) { const txt = await r.text().catch(() => ''); return res.status(502).json({ error: `Make.com webhook błąd ${r.status}: ${txt}` }); }
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

    const { rows: settingsRows } = await pool.query("SELECT key, value FROM settings WHERE key IN ('felieton_instructions','felieton_search_days')");
    const smap = Object.fromEntries(settingsRows.map(r => [r.key, r.value]));
    const instructions = smap['felieton_instructions'] || '';
    const searchDays = parseInt(smap['felieton_search_days'] || '7', 10);
    const model = await getModelForTask('felieton');

    // Pass existing titles so AI avoids repetitions
    const { rows: existing } = await pool.query('SELECT title FROM felieton_ideas ORDER BY created_at DESC LIMIT 60');
    const existingCtx = existing.length
      ? `\nISNIEJĄCE TEMATY (nie powtarzaj tych ani podobnych):\n${existing.map((r, i) => `${i + 1}. ${r.title}`).join('\n')}`
      : '';

    const today = new Date().toLocaleDateString('pl-PL', { day: 'numeric', month: 'long', year: 'numeric' });
    const currentCtx = current_events
      ? `\nDzisiaj jest ${today}. WYMÓG: każda propozycja MUSI bazować na konkretnym wydarzeniu z ostatnich ${searchDays} dni. Przeszukaj internet - sprawdź co wydarzyło się w gamingu w tym okresie: premiery, zwiastuny, kontrowersje, wyniki finansowe, zwolnienia, patche. Każdy brief musi zawierać nazwę konkretnego wydarzenia/gry/firmy i informację jak dawno temu (np. "kilka dni temu", "w tym tygodniu"). Jeśli nie znajdziesz świeżego wydarzenia pasującego do tematu - nie generuj tej propozycji.`
      : '';

    const prompt = `${instructions}
${currentCtx}
${existingCtx}
${direction ? '\nKierunek tematyczny wskazany przez redaktora: ' + direction : '\nRedaktor nie podał kierunku - zaproponuj kreatywnie różnorodne tematy.'}

Wygeneruj DOKŁADNIE 10 propozycji felietonów. Dla każdej podaj:
- title: chwytliwy, prowokujący tytuł roboczy (po polsku)
- brief: 2-3 zdania opisujące kąt, ton i główną tezę felietonu (po polsku)

Odpowiedz TYLKO czystym JSON array, bez żadnego tekstu przed ani po:
[{"title":"...","brief":"..."}]`;

    // Gemini: native Google Search grounding
    // OpenRouter models: :online suffix adds web search
    const tools = (current_events && isGeminiModel(model)) ? [{ google_search: {} }] : null;
    const online = current_events && !isGeminiModel(model);
    const raw = await callAI(prompt, { model, temperature: 0.9, maxTokens: 16000, tools, online });
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

    const { rows: settingsRows } = await pool.query(
      "SELECT key, value FROM settings WHERE key IN ('felieton_instructions','felieton_webhook_url')"
    );
    const smap = {};
    settingsRows.forEach(r => { smap[r.key] = r.value; });
    const instructions = smap['felieton_instructions'] || '';
    const makeUrl = smap['felieton_webhook_url'] || process.env.MAKE_FELIETON_WEBHOOK_URL;

    if (!makeUrl) return res.status(400).json({ error: 'Brak URL webhooka Make.com. Dodaj go w Ustawieniach → Felietony.' });

    const hookRes = await fetch(makeUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'felieton',
        title: item.title,
        brief: item.brief
      })
    });
    if (!hookRes.ok) {
      const txt = await hookRes.text().catch(() => '');
      return res.status(502).json({ error: `Make.com webhook błąd ${hookRes.status}: ${txt}` });
    }

    const { rows: updated } = await pool.query(
      "UPDATE felieton_ideas SET status='sent', produce_count = produce_count + 1 WHERE id=$1 RETURNING *",
      [item.id]
    );
    res.json(updated[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- MODELS ---
let _modelsCache = null, _modelsCacheTs = 0;
router.get('/models', async (req, res) => {
  const TTL = 6 * 3600 * 1000;
  if (_modelsCache && Date.now() - _modelsCacheTs < TTL) return res.json(_modelsCache);
  try {
    const { rows: sr } = await pool.query("SELECT value FROM settings WHERE key='openrouter_api_key'");
    const orKey = sr[0]?.value || process.env.OPENROUTER_API_KEY;

    // Google native models - fetch from Generative Language API
    let googleItems = [];
    try {
      const gRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}&pageSize=50`
      );
      const gData = await gRes.json();
      googleItems = (gData.models || [])
        .filter(m => m.name && m.supportedGenerationMethods?.includes('generateContent'))
        .map(m => {
          const id = m.name.replace('models/', '');
          const label = m.displayName || id;
          return { v: id, l: label };
        })
        .filter(m => m.v.startsWith('gemini-'))
        .sort((a, b) => b.v.localeCompare(a.v));
    } catch (e) { console.error('[Models] Google fetch failed:', e.message); }

    // OpenRouter models - filter to Anthropic + OpenAI
    let orItems = { anthropic: [], openai: [] };
    if (orKey) {
      try {
        const orRes = await fetch('https://openrouter.ai/api/v1/models', {
          headers: { 'Authorization': `Bearer ${orKey}` }
        });
        const orData = await orRes.json();
        (orData.data || []).forEach(m => {
          if (!m.id) return;
          const label = m.name || m.id;
          if (m.id.startsWith('anthropic/')) orItems.anthropic.push({ v: m.id, l: label });
          else if (m.id.startsWith('openai/')) orItems.openai.push({ v: m.id, l: label });
        });
        // Sort: newest first (by id descending)
        orItems.anthropic.sort((a, b) => b.v.localeCompare(a.v));
        orItems.openai.sort((a, b) => b.v.localeCompare(a.v));
      } catch (e) { console.error('[Models] OpenRouter fetch failed:', e.message); }
    }

    _modelsCache = { google: googleItems, anthropic: orItems.anthropic, openai: orItems.openai };
    _modelsCacheTs = Date.now();
    res.json(_modelsCache);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/models/refresh', (req, res) => {
  _modelsCache = null; _modelsCacheTs = 0;
  res.json({ ok: true });
});

// --- LOGS ---
router.get('/logs', (req, res) => { res.json(getLog()); });

module.exports = router;
