const Parser = require('rss-parser');
const parser = new Parser({ timeout: 10000 });

async function fetchFeed(feedUrl) {
  try {
    const feed = await parser.parseURL(feedUrl);
    const source = feed.title || new URL(feedUrl).hostname;
    return feed.items
      .filter(item => item.link)
      .map(item => ({
        url: item.link,
        title: item.title || '',
        published_at: item.pubDate ? new Date(item.pubDate) : new Date(),
        source
      }));
  } catch (err) {
    console.error(`[RSS] Error fetching ${feedUrl}: ${err.message}`);
    return [];
  }
}

module.exports = { fetchFeed };