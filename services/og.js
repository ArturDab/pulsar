const { pool } = require('../db');

async function fetchOgImage(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PulsarBot/1.0)',
        'Accept': 'text/html'
      }
    });
    clearTimeout(timeout);

    if (!res.ok) return null;

    // Read only first 15KB - enough for <head>
    const reader = res.body.getReader();
    let html = '';
    let bytes = 0;
    const MAX = 15000;

    while (bytes < MAX) {
      const { done, value } = await reader.read();
      if (done) break;
      html += new TextDecoder().decode(value);
      bytes += value.length;
    }
    reader.cancel();

    // Extract og:image
    const match = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);

    return match ? match[1] : null;
  } catch {
    return null;
  }
}

async function scrapeOgImages() {
  try {
    const { rows } = await pool.query(
      "SELECT id, url FROM news_items WHERE og_image IS NULL AND status != 'rejected' ORDER BY fetched_at DESC LIMIT 30"
    );
    if (!rows.length) return;

    console.log(`[OG] Scraping ${rows.length} images...`);
    let found = 0;

    // Process 5 at a time
    for (let i = 0; i < rows.length; i += 5) {
      const batch = rows.slice(i, i + 5);
      const results = await Promise.allSettled(
        batch.map(async (item) => {
          const img = await fetchOgImage(item.url);
          if (img) {
            await pool.query('UPDATE news_items SET og_image = $1 WHERE id = $2', [img, item.id]);
            found++;
          }
        })
      );
    }

    console.log(`[OG] Done: ${found}/${rows.length} images found`);
  } catch (err) {
    console.error('[OG] Error:', err.message);
  }
}

module.exports = { scrapeOgImages };
