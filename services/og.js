const { pool } = require('../db');

async function fetchOgImage(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml'
      },
      redirect: 'follow'
    });
    clearTimeout(timeout);
    if (!res.ok) return null;

    const reader = res.body.getReader();
    let html = '';
    let bytes = 0;
    while (bytes < 20000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += new TextDecoder().decode(value);
      bytes += value.length;
    }
    reader.cancel();

    // Try og:image first, then twitter:image
    const og = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
    if (og) return og[1];

    const tw = html.match(/<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']twitter:image["']/i);
    return tw ? tw[1] : null;
  } catch { return null; }
}

async function scrapeOgImages() {
  try {
    const { rows } = await pool.query(
      "SELECT id, url FROM news_items WHERE og_image IS NULL AND status != 'rejected' ORDER BY fetched_at DESC LIMIT 50"
    );
    if (!rows.length) return;
    console.log(`[OG] Scraping ${rows.length} images...`);
    let found = 0;
    for (let i = 0; i < rows.length; i += 5) {
      await Promise.allSettled(rows.slice(i, i + 5).map(async (item) => {
        const img = await fetchOgImage(item.url);
        if (img) {
          await pool.query('UPDATE news_items SET og_image = $1 WHERE id = $2', [img, item.id]);
          found++;
        }
      }));
    }
    console.log(`[OG] Done: ${found}/${rows.length} found`);
  } catch (err) { console.error('[OG] Error:', err.message); }
}

module.exports = { scrapeOgImages };
