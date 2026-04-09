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
    // tempByPos[i] = temperature for relevantItems[i]
    const tempByPos = new Array(relevantItems.length).fill(5);

    if (relevantItems.length > 0) {
      const lines = relevantItems.map((r, i) =>
        `${i+1}. ${(r.headline || r.title || '').slice(0, 120)}`
      ).join('\n');

      const prompt2 = `${temperatureInstructions}

Oceń potencjał redakcyjny każdego artykułu w skali 1-10.
8-10 = gorący news (przełomowy, wirusowy, duże zainteresowanie)
6-7 = mocny news (istotny, warto pokryć)
4-5 = solidny news (normalny coverage)
1-3 = niski potencjał

Artykuły (${relevantItems.length} sztuk, ZACHOWAJ tę samą kolejność w odpowiedzi):
${lines}

Odpowiedz TYLKO czystym JSON array liczb całkowitych, po jednej temperaturze na artykuł w tej samej kolejności:
[7,5,8,3,6]`;

      try {
        const raw2 = await callAI(prompt2, { model: modelTemp, temperature: 0.1, maxTokens: 256 });
        console.log(`[AI] pass2 raw: ${raw2.slice(0, 200)}`);
        // Try to parse as plain array of numbers first
        const clean = raw2.replace(/```[a-z]*\n?/g, '').trim();
        let temps = null;
        try { temps = JSON.parse(clean); } catch {}
        if (!Array.isArray(temps)) {
          // fallback: extract all numbers from string
          const nums = clean.match(/\d+/g);
          if (nums) temps = nums.map(Number);
        }
        if (Array.isArray(temps)) {
          console.log(`[AI] pass2 parsed ${temps.length} temperatures for ${relevantItems.length} items`);
          temps.forEach((t, i) => {
            if (i < tempByPos.length) tempByPos[i] = Math.min(10, Math.max(1, Number(t) || 5));
          });
        } else {
          console.error(`[AI] pass2 could not parse temperatures from: ${raw2.slice(0, 300)}`);
        }
      } catch (err) {
        console.error(`[AI] ${mode} batch ${batchNum} pass2 FAILED: ${err.message}`);
      }
    }

    // Merge: match relevant items by position, rejected items keep temp=1
    let relIdx = 0;
    for (const r of pass1) {
      if (r.relevant === false) {
        results.push({ ...r, temperature: 1 });
      } else {
        results.push({ ...r, temperature: tempByPos[relIdx++] });
      }
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
