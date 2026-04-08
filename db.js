const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const DEFAULT_ROUTER = `Jesteś redaktorem newsów gamingowych dla polskiego portalu Interia. Odbiorcy to gracze casualowi i hardkorowi.

FILTROWANIE - odrzuć bezwzględnie:
- Reklamy, listy topek, rankingi, poradniki, recenzje gier starszych niż 2 tygodnie od premiery
- Artykuły niezwiązane z grami wideo
- Clickbait bez konkretnej nowej informacji
- Treści powtarzające news z tego samego dnia z innego źródła (zachowaj tylko najlepsze)

ZACHOWAJ:
- Premiery i zapowiedzi gier (każda platforma)
- Patche, aktualizacje, DLC do znanych tytułów
- Kontrowersje, skandale i ciekawe spory branżowe
- Industry news: zwolnienia, przejęcia, wyniki finansowe, zmiany w studiach
- Nieoczekiwane i zaskakujące doniesienia

GRUPOWANIE w klastry:
- Artykuły o TYM SAMYM wydarzeniu z różnych źródeł = ten sam cluster_id
- cluster_id: krótki kebab-case slug po angielsku
- cluster_label: czytelna nazwa po polsku
- Każdy artykuł MUSI mieć cluster_id`;

const DEFAULT_TEMPERATURE = `OCENA POTENCJAŁU NEWSA (temperature, skala 1-10):
10 - wydarzenie globalne: premiera AAA, ogromny skandal
8-9 - bardzo ważny news: zapowiedź głośnej gry, duży patch, poważny kryzys studia
6-7 - solidny news: mniejsza premiera, ciekawa aktualizacja, interesujący industry news
4-5 - przeciętny news: niszowy tytuł, drobna aktualizacja, branżowa ciekawostka
1-3 - słaby potencjał: bardzo niszowy temat, mały nieznany deweloper
Uwzględnij popularność tytułu i studia w Polsce.`;

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feeds (
      id SERIAL PRIMARY KEY, url TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS news_items (
      id SERIAL PRIMARY KEY, url TEXT UNIQUE NOT NULL, title TEXT, headline TEXT,
      summary TEXT, source TEXT, cluster_id TEXT, cluster_label TEXT,
      status TEXT DEFAULT 'free', reserved_by TEXT, temperature INT DEFAULT 5,
      bookmarked BOOLEAN DEFAULT false, og_image TEXT, rejection_reason TEXT,
      published_at TIMESTAMPTZ, fetched_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id SERIAL PRIMARY KEY, started_at TIMESTAMPTZ DEFAULT NOW(),
      finished_at TIMESTAMPTZ, items_fetched INT DEFAULT 0, items_saved INT DEFAULT 0, error TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    INSERT INTO feeds (url, name) VALUES ('https://gamerant.com/feed/gaming/', 'Game Rant') ON CONFLICT (url) DO NOTHING;
    CREATE TABLE IF NOT EXISTS review_projects (
      id SERIAL PRIMARY KEY, game_title TEXT NOT NULL, links TEXT[] DEFAULT '{}',
      notes TEXT, status TEXT DEFAULT 'draft', produce_count INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS felieton_ideas (
      id SERIAL PRIMARY KEY, title TEXT NOT NULL, brief TEXT,
      direction TEXT, status TEXT DEFAULT 'draft', produce_count INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`INSERT INTO settings (key, value) VALUES ('router_instructions', $1) ON CONFLICT (key) DO NOTHING`, [DEFAULT_ROUTER]);
  await pool.query(`INSERT INTO settings (key, value) VALUES ('temperature_instructions', $1) ON CONFLICT (key) DO NOTHING`, [DEFAULT_TEMPERATURE]);
  await pool.query(`
    ALTER TABLE news_items ADD COLUMN IF NOT EXISTS reserved_by TEXT;
    ALTER TABLE news_items ADD COLUMN IF NOT EXISTS temperature INT DEFAULT 5;
    ALTER TABLE news_items ADD COLUMN IF NOT EXISTS og_image TEXT;
    ALTER TABLE news_items ADD COLUMN IF NOT EXISTS bookmarked BOOLEAN DEFAULT false;
    ALTER TABLE news_items ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
    ALTER TABLE news_items ADD COLUMN IF NOT EXISTS headline TEXT;
    ALTER TABLE news_items ADD COLUMN IF NOT EXISTS produce_count INT DEFAULT 0;
  `).catch(() => {});
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ni_status ON news_items(status);
    CREATE INDEX IF NOT EXISTS idx_ni_published ON news_items(published_at);
  `).catch(() => {});
  console.log('[DB] Ready');
}

module.exports = { pool, initDb };
