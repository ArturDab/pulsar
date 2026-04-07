let cache = { data: null, ts: 0 };
const TTL = 30 * 60 * 1000; // 30 min

const HEADERS = {
  'User-Agent': 'Mozilla/5.0',
  'Accept': 'application/json'
};

async function fetchLatestReviews() {
  if (cache.data && Date.now() - cache.ts < TTL) return cache.data;

  try {
    // OpenCritic API - recently released games sorted by score
    const res = await fetch('https://api.opencritic.com/api/game?platforms=&time=last90&sort=date&order=desc&skip=0', {
      headers: HEADERS
    });

    if (!res.ok) throw new Error(`OpenCritic HTTP ${res.status}`);
    const data = await res.json();

    const games = data
      .filter(g => g.name && g.id)
      .slice(0, 25)
      .map(g => ({
        title: g.name,
        score: g.topCriticScore > 0 ? Math.round(g.topCriticScore) : null,
        url: 'https://opencritic.com/game/' + g.id + '/' + slugify(g.name),
        date: g.firstReleaseDate ? new Date(g.firstReleaseDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null,
        tier: g.tier || null
      }));

    cache = { data: games, ts: Date.now() };
    console.log(`[OpenCritic] Fetched ${games.length} games`);
    return games;

  } catch (err) {
    console.error('[OpenCritic] Failed:', err.message);

    // Fallback: try popular endpoint
    try {
      const res2 = await fetch('https://api.opencritic.com/api/game/popular', { headers: HEADERS });
      if (res2.ok) {
        const data2 = await res2.json();
        const games2 = data2.filter(g => g.name).slice(0, 20).map(g => ({
          title: g.name,
          score: g.topCriticScore > 0 ? Math.round(g.topCriticScore) : null,
          url: 'https://opencritic.com/game/' + g.id + '/' + slugify(g.name),
          date: g.firstReleaseDate ? new Date(g.firstReleaseDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null,
          tier: g.tier || null
        }));
        cache = { data: games2, ts: Date.now() };
        return games2;
      }
    } catch {}

    return cache.data || [];
  }
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

module.exports = { fetchLatestReviews };
