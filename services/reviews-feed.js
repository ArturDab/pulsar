const Parser = require('rss-parser');
const parser = new Parser({ timeout: 10000 });

let cache = { data: null, ts: 0 };
const TTL = 30 * 60 * 1000; // 30 min

const REVIEW_FEEDS = [
  'https://www.pushsquare.com/feeds/reviews',
  'https://www.purexbox.com/feeds/reviews',
  'https://www.nintendolife.com/feeds/reviews',
  'https://www.eurogamer.net/feed/reviews',
  'https://www.pcgamer.com/reviews/rss/',
];

async function fetchReviewFeed() {
  if (cache.data && Date.now() - cache.ts < TTL) return cache.data;

  const allItems = [];

  for (const feedUrl of REVIEW_FEEDS) {
    try {
      const feed = await parser.parseURL(feedUrl);
      const source = feed.title || new URL(feedUrl).hostname;
      for (const item of (feed.items || []).slice(0, 10)) {
        if (!item.link) continue;
        allItems.push({
          title: item.title || '',
          url: item.link,
          source,
          date: item.pubDate ? new Date(item.pubDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null,
          dateTs: item.pubDate ? new Date(item.pubDate).getTime() : 0
        });
      }
    } catch (err) {
      console.error(`[ReviewFeed] Error fetching ${feedUrl}: ${err.message}`);
    }
  }

  // Sort by date, newest first, deduplicate by URL
  allItems.sort((a, b) => b.dateTs - a.dateTs);
  const seen = new Set();
  const unique = allItems.filter(item => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  }).slice(0, 30);

  // Remove dateTs from output
  const result = unique.map(({ dateTs, ...rest }) => rest);

  cache = { data: result, ts: Date.now() };
  console.log(`[ReviewFeed] Fetched ${result.length} reviews from ${REVIEW_FEEDS.length} feeds`);
  return result;
}

module.exports = { fetchReviewFeed };
