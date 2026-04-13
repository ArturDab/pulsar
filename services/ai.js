/**
 * Unified AI service - routes calls to Gemini API or OpenRouter
 * Model format:
 *   - "gemini-2.5-flash" etc → direct Gemini API
 *   - anything else (e.g. "anthropic/claude-sonnet-4", "openai/gpt-4o") → OpenRouter
 */

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 2000;

function isGeminiModel(model) {
  return model && model.startsWith('gemini-');
}

async function getOpenRouterKey() {
  try {
    const { pool } = require('../db');
    const { rows } = await pool.query("SELECT value FROM settings WHERE key='openrouter_api_key'");
    if (rows[0]?.value) return rows[0].value;
  } catch {}
  return process.env.OPENROUTER_API_KEY || null;
}

async function callAI(prompt, { model, temperature = 0.2, maxTokens = 8192, tools = null, online = false } = {}) {
  if (!model) model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

  if (isGeminiModel(model)) {
    return callGemini(prompt, model, temperature, maxTokens, tools);
  } else {
    const m = online && !model.includes(':online') && !model.includes(':thinking') ? model + ':online' : model;
    return callOpenRouter(prompt, m, temperature, maxTokens);
  }
}

async function callGemini(prompt, model, temperature, maxTokens, tools, retryCount = 0) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature, maxOutputTokens: maxTokens }
  };
  if (tools) body.tools = tools;

  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (err) {
    if (retryCount < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, RETRY_BASE_DELAY * Math.pow(2, retryCount)));
      return callGemini(prompt, model, temperature, maxTokens, tools, retryCount + 1);
    }
    throw new Error(`Gemini network error: ${err.message}`);
  }

  if (!res.ok) {
    if ([429, 500, 502, 503].includes(res.status) && retryCount < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, RETRY_BASE_DELAY * Math.pow(2, retryCount)));
      return callGemini(prompt, model, temperature, maxTokens, tools, retryCount + 1);
    }
    const body = await res.text().catch(() => '');
    throw new Error(`Gemini HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  if (data.error) throw new Error(`Gemini: ${data.error.message}`);
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(`Gemini: empty response (${data.candidates?.[0]?.finishReason})`);
  return text;
}

async function callOpenRouter(prompt, model, temperature, maxTokens, retryCount = 0) {
  const apiKey = await getOpenRouterKey();
  if (!apiKey) throw new Error('Brak klucza OpenRouter. Dodaj go w Ustawieniach lub w Railway Variables.');

  let res;
  try {
    res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://pulsar-news-monitor.up.railway.app',
        'X-Title': 'Pulsar News Monitor'
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature,
        max_tokens: maxTokens
      })
    });
  } catch (err) {
    if (retryCount < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, RETRY_BASE_DELAY * Math.pow(2, retryCount)));
      return callOpenRouter(prompt, model, temperature, maxTokens, retryCount + 1);
    }
    throw new Error(`OpenRouter network error: ${err.message}`);
  }

  if (!res.ok) {
    if ([429, 500, 502, 503].includes(res.status) && retryCount < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, RETRY_BASE_DELAY * Math.pow(2, retryCount)));
      return callOpenRouter(prompt, model, temperature, maxTokens, retryCount + 1);
    }
    const body = await res.text().catch(() => '');
    throw new Error(`OpenRouter HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  if (data.error) throw new Error(`OpenRouter: ${data.error.message || JSON.stringify(data.error)}`);
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenRouter: empty response');
  return text;
}

// Parse JSON from AI response (handles markdown fences, truncated arrays etc.)
function parseJsonFromAI(raw) {
  const clean = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  try { return JSON.parse(clean); } catch {}
  const arrStart = clean.indexOf('[');
  if (arrStart === -1) return [];
  let toParse = clean.slice(arrStart);
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
  throw new Error('AI response: JSON parse failed');
}

module.exports = { callAI, parseJsonFromAI, isGeminiModel };
