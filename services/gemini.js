const BATCH_SIZE = 8;
const BATCH_DELAY = 1500;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 2000;

async function callGemini(prompt, retryCount = 0) {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`;

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
    // Błąd sieci - retry
    if (retryCount < MAX_RETRIES) {
      const delay = RETRY_BASE_DELAY * Math.pow(2, retryCount);
      console.warn(`[Gemini] Network error, retry ${retryCount + 1}/${MAX_RETRIES} in ${delay}ms: ${err.message}`);
      await new Promise(r => setTimeout(r, delay));
      return callGemini(prompt, retryCount + 1);
    }
    throw new Error(`Gemini network error after ${MAX_RETRIES} retries: ${err.message}`);
  }

  // HTTP errors - retry na 429/500/503
  if (!res.ok) {
    const retryable = [429, 500, 502, 503].includes(res.status);
    if (retryable && retryCount < MAX_RETRIES) {
      const delay = RETRY_BASE_DELAY * Math.pow(2, retryCount);
      console.warn(`[Gemini] HTTP ${res.status}, retry ${retryCount + 1}/${MAX_RETRIES} in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      return callGemini(prompt, retryCount + 1);
    }
    const body = await res.text().catch(() => '');
    throw new Error(`Gemini HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();

  // API-level errors
  if (data.error) {
    throw new Error(`Gemini API: ${data.error.message || JSON.stringify(data.error)}`);
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    const reason = data.candidates?.[0]?.finishReason;
    throw new Error(`Gemini: empty response (finishReason: ${reason || 'unknown'})`);
  }

  // Wyczyść markdown fences
  const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

  // Próba parsowania JSON z naprawą urwanych odpowiedzi
  return parseJsonSafe(clean);
}

function parseJsonSafe(raw) {
  // Najpierw spróbuj bezpośrednio
  try { return JSON.parse(raw); } catch {}

  // Znajdź początek arraya
  const arrStart = raw.indexOf('[');
  if (arrStart === -1) {
    // Może to pojedynczy obiekt?
    const objStart = raw.indexOf('{');
    if (objStart === -1) throw new Error('Gemini: no JSON found in response');
    try { return [JSON.parse(raw.slice(objStart))]; } catch {}
    throw new Error('Gemini: unparseable JSON response');
  }

  let toParse = raw.slice(arrStart);

  // Jeśli brakuje zamykającego ]
  if (!toParse.endsWith(']')) {
    // Znajdź ostatni kompletny obiekt
    const lastBrace = toParse.lastIndexOf('}');
    if (lastBrace !== -1) {
      toParse = toParse.slice(0, lastBrace + 1) + ']';
    } else {
      return []; // Nic się nie da uratować
    }
  }

  try { return JSON.parse(toParse); } catch {}

  // Ostatnia deska ratunku: wycinaj po jednym obiekcie od końca
  let attempts = 0;
  while (attempts < 5) {
    const lastObj = toParse.lastIndexOf('},{');
    if (lastObj === -1) break;
    toParse = toParse.slice(0, lastObj + 1) + ']';
    try { return JSON.parse(toParse); } catch {}
    attempts++;
  }

  throw new Error('Gemini: JSON repair failed');
}

async function filterAndCluster(items, existingClusters = [], routerInstructions = '', temperatureInstructions = '') {
  const results = [];
  const clusters = [...existingClusters];

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const total = Math.ceil(items.length / BATCH_SIZE);
    console.log(`[Gemini] filter batch ${batchNum}/${total} (${batch.length} items)`);

    const prompt = `${routerInstructions}

${temperatureInstructions}

Istniejące klastry (reużyj cluster_id jeśli pasuje):
${clusters.length > 0 ? JSON.stringify(clusters.map(c => ({ cluster_id: c.cluster_id, cluster_label: c.cluster_label }))) : 'brak'}

Artykuły do oceny (${batch.length} sztuk):
${JSON.stringify(batch.map(item => ({ url: item.url, title: item.title || '' })))}

Odpowiedz TYLKO czystym JSON array, bez żadnego tekstu przed ani po:
[{"url":"...","relevant":true,"summary":"1-zdaniowe streszczenie po polsku","cluster_id":"slug-po-angielsku","cluster_label":"Nazwa po polsku","temperature":7}]`;

    try {
      const batchResults = await callGemini(prompt);
      console.log(`[Gemini] batch ${batchNum} returned: type=${typeof batchResults}, isArray=${Array.isArray(batchResults)}, length=${batchResults?.length}, preview=${JSON.stringify(batchResults).slice(0, 200)}`);
      if (Array.isArray(batchResults)) {
        results.push(...batchResults);
        for (const r of batchResults) {
          if (r.cluster_id && !clusters.find(c => c.cluster_id === r.cluster_id)) {
            clusters.push({ cluster_id: r.cluster_id, cluster_label: r.cluster_label });
          }
        }
      }
    } catch (err) {
      console.error(`[Gemini] filter batch ${batchNum} FAILED: ${err.message}`);
    }

    if (i + BATCH_SIZE < items.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY));
    }
  }

  return results;
}

async function reclusterAndRescore(items, existingClusters = [], routerInstructions = '', temperatureInstructions = '') {
  const results = [];
  const clusters = [...existingClusters];

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const total = Math.ceil(items.length / BATCH_SIZE);
    console.log(`[Gemini] recluster batch ${batchNum}/${total} (${batch.length} items)`);

    const prompt = `${routerInstructions}

${temperatureInstructions}

Te artykuły są już zakwalifikowane jako relevantne. Przypisz je do klastrów i oceń temperaturę.

Istniejące klastry:
${clusters.length > 0 ? JSON.stringify(clusters.map(c => ({ cluster_id: c.cluster_id, cluster_label: c.cluster_label }))) : 'brak'}

Artykuły (${batch.length} sztuk):
${JSON.stringify(batch.map(item => ({ url: item.url, title: item.title || item.url })))}

Odpowiedz TYLKO czystym JSON array, bez żadnego tekstu przed ani po:
[{"url":"...","summary":"1-zdaniowe streszczenie po polsku","cluster_id":"slug-po-angielsku","cluster_label":"Nazwa po polsku","temperature":7}]`;

    try {
      const batchResults = await callGemini(prompt);
      if (Array.isArray(batchResults)) {
        results.push(...batchResults);
        for (const r of batchResults) {
          if (r.cluster_id && !clusters.find(c => c.cluster_id === r.cluster_id)) {
            clusters.push({ cluster_id: r.cluster_id, cluster_label: r.cluster_label });
          }
        }
      }
    } catch (err) {
      console.error(`[Gemini] recluster batch ${batchNum} FAILED: ${err.message}`);
    }

    if (i + BATCH_SIZE < items.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY));
    }
  }

  return results;
}

module.exports = { filterAndCluster, reclusterAndRescore };