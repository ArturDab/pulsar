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
  const model = await getModelForTask('news');

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const total = Math.ceil(items.length / BATCH_SIZE);
    console.log(`[AI] ${mode} batch ${batchNum}/${total} (${batch.length} items) model=${model}`);

    const clusterCtx = cls.length > 0
      ? JSON.stringify(cls.map(c => ({ cluster_id: c.cluster_id, cluster_label: c.cluster_label })))
      : 'brak';

    const itemsCtx = JSON.stringify(batch.map(item => ({ url: item.url, title: item.title || '' })));
    const isFilter = mode === 'filter';

    const prompt = `${routerInstructions}

${temperatureInstructions}

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
- temperature: liczba 1-10 oceniająca potencjał redakcyjny

Odpowiedz TYLKO czystym JSON array:
[{"url":"...","relevant":true,"headline":"Polski tytuł newsa","summary":"Streszczenie po polsku.","cluster_id":"slug","cluster_label":"Nazwa po polsku","temperature":7${isFilter ? ',"rejection_reason":null' : ''}}]`;

    try {
      const raw = await callAI(prompt, { model, temperature: 0.2, maxTokens: 8192 });
      const br = parseJsonFromAI(raw);
      if (Array.isArray(br)) {
        for (const r of br) {
          if (r.cluster_id && !cls.find(c => c.cluster_id === r.cluster_id)) {
            cls.push({ cluster_id: r.cluster_id, cluster_label: r.cluster_label });
          }
        }
        results.push(...br);
      }
    } catch (err) {
      console.error(`[AI] ${mode} batch ${batchNum} FAILED: ${err.message}`);
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
