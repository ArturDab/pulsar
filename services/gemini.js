const { callAI, parseJsonFromAI } = require('./ai');
const { pool } = require('../db');

const BATCH_SIZE = 8;
const BATCH_DELAY = 1500;

async function getModelForTask(task) {
  try {
    const { rows } = await pool.query('SELECT value FROM settings WHERE key=$1', ['model_' + task]);
    return rows[0]?.value || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  } catch { return process.env.GEMINI_MODEL || 'gemini-2.5-flash'; }
}

async function processBatches(items, clusters, routerInstructions, temperatureInstructions, mode) {
  const results = [];
  const cls = [...clusters];
  const modelNews = await getModelForTask('news');
  const modelTemp = await getModelForTask('temperature');

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const total = Math.ceil(items.length / BATCH_SIZE);
    console.log(`[AI] ${mode} batch ${batchNum}/${total} (${batch.length} items) model_news=${modelNews} model_temp=${modelTemp}`);

    const clusterCtx = cls.length > 0
      ? JSON.stringify(cls.map(c => ({ cluster_id: c.cluster_id, cluster_label: c.cluster_label })))
      : 'brak';

    const itemsCtx = JSON.stringify(batch.map(item => ({ url: item.url, title: item.title || '' })));

    const isFilter = mode === 'filter';

    // Pass 1: filter + cluster + headline + summary (model_news)
    const prompt1 = `${routerInstructions}

Istniejące klastry (reużyj cluster_id jeśli pasuje):
${clusterCtx}

Artykuły do oceny (${batch.length} sztuk):
${itemsCtx}

Dla KAŻDEGO artykułu zwróć obiekt JSON.
${isFilter ? `Jeśli artykuł jest NIEISTOTNY, ustaw relevant:false i podaj rejection_reason (krótkie uzasadnienie po polsku, 5-10 słów).
Jeśli artykuł jest ISTOTNY, ustaw relevant:true.` : 'Wszystkie artykuły są już zakwalifikowane jako istotne.'}

Dla istotnych artykułów ZAWSZE podaj:
- headline: chwytliwy polski tytuł newsa (5-10 słów, jak nagłówek w portalu)
- summary: 1-zdaniowe streszczenie po polsku
- cluster_id, cluster_label

Odpowiedz TYLKO czystym JSON array:
[{"url":"...","relevant":true,"headline":"Polski tytuł newsa","summary":"Streszczenie po polsku.","cluster_id":"slug","cluster_label":"Nazwa po polsku"${isFilter ? ',"rejection_reason":null' : ''}}]`;

    let pass1 = [];
    try {
      const raw1 = await callAI(prompt1, { model: modelNews, temperature: 0.2, maxTokens: 8192 });
      const br1 = parseJsonFromAI(raw1);
      if (Array.isArray(br1)) {
        pass1 = br1;
        for (const r of br1) {
          if (r.cluster_id && !cls.find(c => c.cluster_id === r.cluster_id)) {
            cls.push({ cluster_id: r.cluster_id, cluster_label: r.cluster_label });
          }
        }
      }
    } catch (err) {
      console.error(`[AI] ${mode} batch ${batchNum} pass1 FAILED: ${err.message}`);
      if (i + BATCH_SIZE < items.length) await new Promise(r => setTimeout(r, BATCH_DELAY));
      continue;
    }

    // Pass 2: temperature scoring - only relevant items (model_temperature)
    const relevantItems = pass1.filter(r => r.relevant !== false);
    let tempMap = {};
    if (relevantItems.length > 0) {
      const tempCtx = JSON.stringify(relevantItems.map(r => ({ url: r.url, headline: r.headline || '', summary: r.summary || '' })));
      const prompt2 = `${temperatureInstructions}

Oceń potencjał redakcyjny każdego artykułu w skali 1-10.
8-10 = gorący news (przełomowy, wirusowy, duże zainteresowanie)
6-7 = mocny news (istotny, warto pokryć)
4-5 = solidny news (normalny coverage)
1-3 = niski potencjał

Artykuły do oceny (${relevantItems.length} sztuk):
${tempCtx}

Odpowiedz TYLKO czystym JSON array:
[{"url":"...","temperature":7}]`;

      try {
        const raw2 = await callAI(prompt2, { model: modelTemp, temperature: 0.1, maxTokens: 2048 });
        const br2 = parseJsonFromAI(raw2);
        if (Array.isArray(br2)) {
          for (const r of br2) tempMap[r.url] = r.temperature;
        }
      } catch (err) {
        console.error(`[AI] ${mode} batch ${batchNum} pass2 (temperature) FAILED: ${err.message}`);
      }
    }

    // Merge results
    for (const r of pass1) {
      results.push({ ...r, temperature: tempMap[r.url] ?? 5 });
    }

    if (i + BATCH_SIZE < items.length) await new Promise(r => setTimeout(r, BATCH_DELAY));
  }
  return results;
}

async function filterAndCluster(items, existingClusters = [], routerInstructions = '', temperatureInstructions = '') {
  return processBatches(items, existingClusters, routerInstructions, temperatureInstructions, 'filter');
}

async function reclusterAndRescore(items, existingClusters = [], routerInstructions = '', temperatureInstructions = '') {
  return processBatches(items, existingClusters, routerInstructions, temperatureInstructions, 'recluster');
}

module.exports = { filterAndCluster, reclusterAndRescore, getModelForTask };
