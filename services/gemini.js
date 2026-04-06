const BATCH_SIZE = 8;
const BATCH_DELAY = 1500;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 2000;

async function callGemini(prompt, retryCount = 0) {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 8192 }
      })
    });
  } catch (err) {
    if (retryCount < MAX_RETRIES) {
      const delay = RETRY_BASE_DELAY * Math.pow(2, retryCount);
      console.warn(`[Gemini] Network error, retry ${retryCount + 1}/${MAX_RETRIES} in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      return callGemini(prompt, retryCount + 1);
    }
    throw new Error(`Gemini network error after ${MAX_RETRIES} retries: ${err.message}`);
  }

  if (!res.ok) {
    if ([429, 500, 502, 503].includes(res.status) && retryCount < MAX_RETRIES) {
      const delay = RETRY_BASE_DELAY * Math.pow(2, retryCount);
      console.warn(`[Gemini] HTTP ${res.status}, retry ${retryCount + 1}/${MAX_RETRIES} in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      return callGemini(prompt, retryCount + 1);
    }
    const body = await res.text().catch(() => '');
    throw new Error(`Gemini HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  if (data.error) throw new Error(`Gemini API: ${data.error.message}`);
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(`Gemini: empty response (${data.candidates?.[0]?.finishReason})`);

  const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  return parseJsonSafe(clean);
}

function parseJsonSafe(raw) {
  try { return JSON.parse(raw); } catch {}
  const arrStart = raw.indexOf('[');
  if (arrStart === -1) return [];
  let toParse = raw.slice(arrStart);
  if (!toParse.endsWith(']')) {
    const last = toParse.lastIndexOf('}');
    if (last !== -1) toParse = toParse.slice(0, last + 1) + ']';
    else return [];
  }
  try { return JSON.parse(toParse); } catch {}
  let attempts = 0;
  while (attempts < 5) {
    const cut = toParse.lastIndexOf('},{');
    if (cut === -1) break;
    toParse = toParse.slice(0, cut + 1) + ']';
    try { return JSON.parse(toParse); } catch {}
    attempts++;
  }
  throw new Error('Gemini: JSON repair failed');
}

async function processBatches(items, clusters, routerInstructions, temperatureInstructions, mode) {
  const results = [];
  const cls = [...clusters];

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const total = Math.ceil(items.length / BATCH_SIZE);
    console.log(`[Gemini] ${mode} batch ${batchNum}/${total} (${batch.length} items)`);

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
- cluster_id, cluster_label, temperature

Odpowiedz TYLKO czystym JSON array:
[{"url":"...","relevant":true,"headline":"Polski tytuł newsa","summary":"Streszczenie po polsku.","cluster_id":"slug","cluster_label":"Nazwa po polsku","temperature":7${isFilter ? ',"rejection_reason":null' : ''}}]`;

    try {
      const br = await callGemini(prompt);
      if (Array.isArray(br)) {
        results.push(...br);
        for (const r of br) {
          if (r.cluster_id && !cls.find(c => c.cluster_id === r.cluster_id)) {
            cls.push({ cluster_id: r.cluster_id, cluster_label: r.cluster_label });
          }
        }
      }
    } catch (err) {
      console.error(`[Gemini] ${mode} batch ${batchNum} FAILED: ${err.message}`);
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

module.exports = { filterAndCluster, reclusterAndRescore };
