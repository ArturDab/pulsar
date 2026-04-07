let cache = { data: null, ts: 0 };
const TTL = 30 * 60 * 1000; // 30 min cache

async function fetchMetacritic() {
  if (cache.data && Date.now() - cache.ts < TTL) return cache.data;

  try {
    const url = 'https://www.metacritic.com/browse/game/all/all/current-year/';
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    if (!res.ok) throw new Error(`Metacritic HTTP ${res.status}`);

    const html = await res.text();
    const games = [];

    // Parse game cards from the browse page
    // Each game has a title, metascore, platform, date, and link
    const cardRegex = /<a[^>]*href="(\/game\/[^"]+)"[^>]*>[\s\S]*?<\/a>/gi;
    const titleRegex = /data-title="([^"]+)"/;
    const scoreRegex = /data-metascore="(\d+)"/;

    // Simpler approach: extract JSON-LD or structured data
    // Metacritic uses a lot of JS rendering, so let's try a different parse
    const items = [];

    // Try extracting from meta tags and structured patterns
    // Pattern: game title + metascore + date
    const blockRegex = /<div[^>]*class="[^"]*c-finderProductCard[^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi;

    // Fallback: simpler regex for key data points
    // Look for patterns like: href="/game/SLUG/" with nearby score and title
    const linkRe = /href="(\/game\/[^/"]+\/)"[^>]*>/gi;
    const allLinks = [];
    let m;
    while ((m = linkRe.exec(html)) !== null) {
      allLinks.push(m[1]);
    }

    // Extract title-score pairs from the page
    // Metacritic renders: <span>TITLE</span> ... <span>SCORE</span>
    const pairRe = /href="(\/game\/([^/"]+)\/)"[\s\S]*?(?:>([^<]{2,80})<\/(?:span|div|p|a))[\s\S]*?(?:metascore|score)[^>]*>(\d{1,3})</gi;

    // Most reliable: extract from page's __NEXT_DATA__ or similar JSON blob
    const jsonMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (jsonMatch) {
      try {
        const data = JSON.parse(jsonMatch[1]);
        const items = extractFromNextData(data);
        if (items.length) {
          cache = { data: items.slice(0, 20), ts: Date.now() };
          return cache.data;
        }
      } catch {}
    }

    // Fallback: regex-based extraction
    // Look for patterns: title in heading tags near score numbers
    const gameBlocks = html.split(/(?=<a[^>]*href="\/game\/)/i).slice(1, 30);
    for (const block of gameBlocks) {
      const href = block.match(/href="(\/game\/[^"]+)"/);
      const title = block.match(/>([^<]{3,80})<\/(?:span|p|div|h3)/);
      const score = block.match(/>(\d{2,3})<\/(?:span|div)/);
      const date = block.match(/(\w{3}\s+\d{1,2},\s+\d{4})/);

      if (href && title) {
        games.push({
          title: title[1].trim(),
          score: score ? parseInt(score[1]) : null,
          url: 'https://www.metacritic.com' + href[1],
          date: date ? date[1] : null
        });
      }
    }

    // Deduplicate by URL
    const seen = new Set();
    const unique = games.filter(g => {
      if (seen.has(g.url)) return false;
      seen.add(g.url);
      return true;
    });

    cache = { data: unique.slice(0, 20), ts: Date.now() };
    console.log(`[Metacritic] Scraped ${unique.length} games`);
    return cache.data;

  } catch (err) {
    console.error('[Metacritic] Scrape failed:', err.message);
    return cache.data || [];
  }
}

function extractFromNextData(data) {
  const games = [];
  try {
    // Navigate Next.js data structure - this varies by page
    const walk = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      if (obj.title && (obj.metaScore || obj.score) && obj.slug) {
        games.push({
          title: obj.title,
          score: obj.metaScore || obj.score || null,
          url: 'https://www.metacritic.com/game/' + obj.slug + '/',
          date: obj.releaseDate || obj.date || null
        });
      }
      for (const v of Object.values(obj)) {
        if (Array.isArray(v)) v.forEach(walk);
        else if (typeof v === 'object') walk(v);
      }
    };
    walk(data);
  } catch {}
  return games;
}

module.exports = { fetchMetacritic };
