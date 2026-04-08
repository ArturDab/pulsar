const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const CHANNEL_ID = process.env.SLACK_CHANNEL_ID || 'C036TL6F4P2';

// Statyczny mapping znanych użytkowników (fallback gdy brak scope users:read)
const userCache = new Map([
  ['U02F9CC3X27', 'Grzegorz Gajkos'],
  ['U035PDTKA11', 'Krzysztof Chalabis'],
  ['U02F1SM8K8W', 'Artur Dąbrowski'],
  ['U02FLP9GHMX', 'Artur Dąbrowski'],
  ['U02F83E0C7M', 'Łukasz Lasak'],
  ['U03622DM4JV', 'Tomasz Alicki'],
  ['U03MWBFQB9S', 'Zbigniew Pławecki'],
]);

async function resolveUser(userId) {
  if (!userId) return 'unknown';
  if (userCache.has(userId)) return userCache.get(userId);
  try {
    const res = await fetch(`https://slack.com/api/users.info?user=${userId}`, {
      headers: { Authorization: `Bearer ${SLACK_TOKEN}` }
    });
    const data = await res.json();
    if (data.ok) {
      const name = data.user?.profile?.display_name || data.user?.real_name || userId;
      userCache.set(userId, name);
      return name;
    }
  } catch {}
  return userId;
}

function initials(name) {
  if (!name) return '?';
  // Jeśli to ID usera (np. U02F9CC3X27), pokaż 'U'
  if (/^U[A-Z0-9]{8,}$/.test(name)) return 'U';
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

function formatSlackText(text) {
  if (!text) return '';
  return text
    // URL z display textem
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, (_, url, display) => {
      // Jeśli display wygląda jak skrócony URL, pokaż oryginalny
      const label = display.startsWith('http') ? url : display;
      return `<a href="${url}" target="_blank" rel="noopener">${label}</a>`;
    })
    // Zwykły URL
    .replace(/<(https?:\/\/[^>]+)>/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
    // @mention z displayname: <@U123|name>
    .replace(/<@([A-Z0-9]+)\|([^>]+)>/g, (_, uid, name) => {
      const resolved = userCache.get(uid) || name;
      return `<span style="color:var(--blue);font-weight:500">@${resolved}</span>`;
    })
    // @mention bez displayname: <@U123>
    .replace(/<@([A-Z0-9]+)>/g, (_, uid) => {
      const resolved = userCache.get(uid) || uid;
      return `<span style="color:var(--blue);font-weight:500">@${resolved}</span>`;
    });
}

function extractUrls(text) {
  if (!text) return [];
  const urls = [];
  const re = /<(https?:\/\/[^|>]+)(?:\|[^>]*)?>/g;
  let m;
  while ((m = re.exec(text)) !== null) urls.push(m[1]);
  return urls;
}

async function getSlackUrlMap() {
  const urlMap = new Map();
  let cursor;
  do {
    const params = new URLSearchParams({ channel: CHANNEL_ID, limit: '200', ...(cursor ? { cursor } : {}) });
    const res = await fetch(`https://slack.com/api/conversations.history?${params}`, {
      headers: { Authorization: `Bearer ${SLACK_TOKEN}` }
    });
    const data = await res.json();
    if (!data.ok) { console.error('[Slack] Error:', data.error); break; }
    for (const msg of (data.messages || [])) {
      const urls = extractUrls(msg.text);
      const userName = msg.user ? await resolveUser(msg.user) : 'ktoś';
      for (const u of urls) { if (!urlMap.has(u)) urlMap.set(u, userName); }
    }
    cursor = data.response_metadata?.next_cursor;
  } while (cursor);
  return urlMap;
}

async function getSlackUrls() {
  const map = await getSlackUrlMap();
  return new Set(map.keys());
}

async function getRecentMessages(limit = 40) {
  const res = await fetch(
    `https://slack.com/api/conversations.history?channel=${CHANNEL_ID}&limit=${limit}`,
    { headers: { Authorization: `Bearer ${SLACK_TOKEN}` } }
  );
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack: ${data.error}`);
  const messages = [];
  for (const msg of (data.messages || [])) {
    if (msg.subtype) continue;
    let userName = msg.user || 'unknown';
    try { userName = await resolveUser(msg.user); } catch {}
    const msgText = msg.text || '';
    messages.push({
      ts: msg.ts,
      time: new Date(parseFloat(msg.ts) * 1000).toISOString(),
      user: userName,
      initials: initials(userName),
      text: formatSlackText(msgText),
      urls: extractUrls(msgText)
    });
  }
  return messages;
}

async function postToSlack(url) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: CHANNEL_ID, text: url, as_user: true })
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack error: ${data.error}`);
  return data;
}

async function deleteMessageByUrl(targetUrl) {
  if (!SLACK_TOKEN) throw new Error('SLACK_BOT_TOKEN not set');
  // Find our bot's message containing this URL
  const params = new URLSearchParams({ channel: CHANNEL_ID, limit: '100' });
  const res = await fetch(`https://slack.com/api/conversations.history?${params}`, {
    headers: { Authorization: `Bearer ${SLACK_TOKEN}` }
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack: ${data.error}`);
  
  const norm = targetUrl.toLowerCase().replace(/\/+$/, '');
  for (const msg of (data.messages || [])) {
    const urls = extractUrls(msg.text);
    const match = urls.some(u => u.toLowerCase().replace(/\/+$/, '') === norm);
    if (match) {
      const delRes = await fetch('https://slack.com/api/chat.delete', {
        method: 'POST',
        headers: { Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: CHANNEL_ID, ts: msg.ts })
      });
      const delData = await delRes.json();
      if (!delData.ok && delData.error !== 'message_not_found') {
        throw new Error(`Nie udało się usunąć: ${delData.error}`);
      }
      return true;
    }
  }
  return false;
}

module.exports = { getSlackUrls, getSlackUrlMap, getRecentMessages, postToSlack, deleteMessageByUrl };