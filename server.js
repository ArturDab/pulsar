require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');
const { initDb } = require('./db');
const apiRouter = require('./routes/api');
const { runPipeline } = require('./services/pipeline');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Auth ---
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

function signToken(t) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(t).digest('hex');
}
function createSession() {
  const t = crypto.randomBytes(32).toString('hex');
  return t + '.' + signToken(t);
}
function verifySession(signed) {
  if (!signed || typeof signed !== 'string') return false;
  const dot = signed.lastIndexOf('.');
  if (dot < 1) return false;
  const token = signed.slice(0, dot);
  const sig = signed.slice(dot + 1);
  try {
    const expected = signToken(token);
    if (sig.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch { return false; }
}
function parseCookies(req) {
  const cookies = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const eq = p.indexOf('=');
    if (eq > 0) cookies[p.slice(0, eq).trim()] = p.slice(eq + 1).trim();
  });
  return cookies;
}
function authMiddleware(req, res, next) {
  if (!APP_PASSWORD) return next();
  if (verifySession(parseCookies(req)['pulsar_session'])) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.get('/api/auth/check', (req, res) => {
  if (!APP_PASSWORD) return res.json({ ok: true });
  if (verifySession(parseCookies(req)['pulsar_session'])) return res.json({ ok: true });
  res.status(401).json({ error: 'Unauthorized' });
});
app.post('/api/auth/login', (req, res) => {
  if (!APP_PASSWORD) return res.json({ ok: true });
  const { password } = req.body || {};
  if (!password || password !== APP_PASSWORD)
    return res.status(401).json({ error: 'Nieprawidłowe hasło' });
  const session = createSession();
  res.setHeader('Set-Cookie', `pulsar_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);
  res.json({ ok: true });
});
app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'pulsar_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.use('/api', authMiddleware, apiRouter);

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Co 30 minut
cron.schedule('*/30 * * * *', () => {
  console.log('[CRON] Starting pipeline...');
  runPipeline();
});

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`[Server] Running on port ${PORT}`);
      runPipeline();
    });
  })
  .catch(err => {
    console.error('[Server] Init failed:', err.message);
    process.exit(1);
  });