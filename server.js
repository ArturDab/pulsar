require('dotenv').config();
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

app.use('/api', apiRouter);

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