const path = require('path');
const USE_PG = !!process.env.DATABASE_URL;

if (USE_PG) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5,
  });

  console.log('[db] using Postgres');

  async function initSchema() {
    const client = await pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS tasks (
          id SERIAL PRIMARY KEY,
          title TEXT NOT NULL,
          notes TEXT,
          status TEXT NOT NULL DEFAULT 'open',
          priority TEXT NOT NULL DEFAULT 'normal',
          remind_at TEXT,
          reminded INTEGER NOT NULL DEFAULT 0,
          stale_days INTEGER NOT NULL DEFAULT 3,
          stale_minutes INTEGER DEFAULT 4320,
          recurring TEXT,
          last_touched_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT
        );
        CREATE TABLE IF NOT EXISTS finance_entries (
          id SERIAL PRIMARY KEY,
          type TEXT NOT NULL DEFAULT 'expense',
          amount DOUBLE PRECISION NOT NULL,
          category TEXT NOT NULL DEFAULT 'general',
          note TEXT,
          merchant TEXT,
          source TEXT DEFAULT 'manual',
          imported_date TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS merchant_category_map (
          id SERIAL PRIMARY KEY,
          pattern TEXT NOT NULL UNIQUE,
          category TEXT NOT NULL,
          hit_count INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS bank_settings (
          key TEXT PRIMARY KEY,
          value TEXT
        );
        CREATE TABLE IF NOT EXISTS budget_baselines (
          category TEXT PRIMARY KEY,
          avg_weekly DOUBLE PRECISION NOT NULL DEFAULT 0,
          sample_weeks INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chat_history (
          id SERIAL PRIMARY KEY,
          chat_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_chat_history_chat_id ON chat_history(chat_id, created_at);
      `);
      await client.query(`
        ALTER TABLE tasks ADD COLUMN IF NOT EXISTS next_ping_at TEXT;
        ALTER TABLE tasks ADD COLUMN IF NOT EXISTS ping_count INTEGER NOT NULL DEFAULT 0;
      `);
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (chatId) {
        await client.query(
          `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
          ['chat_id', String(chatId)]
        );
      }
      console.log('[db] schema ready');
    } finally {
      client.release();
    }
  }

  initSchema().catch(e => console.error('[db] schema init failed:', e.message));

  function convertPlaceholders(sql) {
    // Convert SQLite-specific syntax to Postgres
    let converted = sql
      // date('now', 'start of month') → DATE_TRUNC('month', NOW())
      .replace(/date\s*\(\s*'now'\s*,\s*'start of month'\s*\)/gi, "DATE_TRUNC('month', NOW())")
      // strftime('%Y-%m', col) → TO_CHAR(col::timestamp, 'YYYY-MM')
      .replace(/strftime\s*\(\s*'%Y-%m'\s*,\s*([^)]+?)\s*\)/gi, (_, col) => `TO_CHAR((${col.trim()})::timestamp, 'YYYY-MM')`)
      // strftime('%Y-%W', col) → TO_CHAR(col::timestamp, 'IYYY-IW')
      .replace(/strftime\s*\(\s*'%Y-%W'\s*,\s*([^)]+?)\s*\)/gi, (_, col) => `TO_CHAR((${col.trim()})::timestamp, 'IYYY-IW')`)
      // ON CONFLICT( → ON CONFLICT ( (add space for Postgres strictness)
      .replace(/ON CONFLICT\(/g, 'ON CONFLICT (');
    // Convert ? placeholders to $1, $2...
    let i = 0;
    return converted.replace(/\?/g, () => `$${++i}`);
  }

  function prepare(sql) {
    const pgSQL = convertPlaceholders(sql);
    return {
      async all(...params) {
        const flat = params.flat();
        const { rows } = await pool.query(pgSQL, flat.length ? flat : undefined);
        return rows;
      },
      async get(...params) {
        const flat = params.flat();
        const { rows } = await pool.query(pgSQL, flat.length ? flat : undefined);
        return rows[0] || null;
      },
      async run(...params) {
        const flat = params.flat();
        // Try with RETURNING id first, fall back without
        const returningSQL = /^\s*INSERT/i.test(pgSQL) ? pgSQL + ' RETURNING id' : pgSQL;
        try {
          const { rows, rowCount } = await pool.query(returningSQL, flat.length ? flat : undefined);
          return { lastInsertRowid: rows?.[0]?.id, changes: rowCount };
        } catch {
          const { rowCount } = await pool.query(pgSQL, flat.length ? flat : undefined);
          return { lastInsertRowid: null, changes: rowCount };
        }
      },
    };
  }

  async function exec(sql) {
    await pool.query(sql);
  }

  function transaction(fn) {
    return async function(rows) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const row of rows) {
          await fn(row, client);
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    };
  }

  module.exports = { prepare, exec, transaction, pool, USE_PG: true };

} else {
  const Database = require('better-sqlite3');
  const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
  const sqliteDb = new Database(path.join(DATA_DIR, 'data.sqlite'));
  console.log('[db] using SQLite at', path.join(DATA_DIR, 'data.sqlite'));

  sqliteDb.pragma('journal_mode = WAL');

  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL, notes TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      priority TEXT NOT NULL DEFAULT 'normal',
      remind_at TEXT, reminded INTEGER NOT NULL DEFAULT 0,
      stale_days INTEGER NOT NULL DEFAULT 3,
      stale_minutes INTEGER DEFAULT 4320,
      recurring TEXT, last_touched_at TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS finance_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL DEFAULT 'expense', amount REAL NOT NULL,
      category TEXT NOT NULL DEFAULT 'general', note TEXT,
      merchant TEXT, source TEXT DEFAULT 'manual',
      imported_date TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS merchant_category_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT, pattern TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL, hit_count INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bank_settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS budget_baselines (
      category TEXT PRIMARY KEY, avg_weekly REAL NOT NULL DEFAULT 0,
      sample_weeks INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL,
      role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_history_chat_id ON chat_history(chat_id, created_at);
  `);

  const finCols  = sqliteDb.prepare('PRAGMA table_info(finance_entries)').all().map(c => c.name);
  const taskCols = sqliteDb.prepare('PRAGMA table_info(tasks)').all().map(c => c.name);
  if (!finCols.includes('merchant'))      sqliteDb.exec('ALTER TABLE finance_entries ADD COLUMN merchant TEXT');
  if (!finCols.includes('source'))        sqliteDb.exec("ALTER TABLE finance_entries ADD COLUMN source TEXT DEFAULT 'manual'");
  if (!finCols.includes('imported_date')) sqliteDb.exec('ALTER TABLE finance_entries ADD COLUMN imported_date TEXT');
  if (!taskCols.includes('priority'))     sqliteDb.exec("ALTER TABLE tasks ADD COLUMN priority TEXT DEFAULT 'normal'");
  if (!taskCols.includes('recurring'))    sqliteDb.exec('ALTER TABLE tasks ADD COLUMN recurring TEXT');
  if (!taskCols.includes('stale_minutes')) {
    sqliteDb.exec('ALTER TABLE tasks ADD COLUMN stale_minutes INTEGER DEFAULT 4320');
    if (taskCols.includes('stale_days')) sqliteDb.exec('UPDATE tasks SET stale_minutes = stale_days * 1440');
  }
  if (!taskCols.includes('next_ping_at')) sqliteDb.exec('ALTER TABLE tasks ADD COLUMN next_ping_at TEXT');
  if (!taskCols.includes('ping_count'))   sqliteDb.exec('ALTER TABLE tasks ADD COLUMN ping_count INTEGER DEFAULT 0');

  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (chatId && !sqliteDb.prepare("SELECT value FROM settings WHERE key='chat_id'").get()) {
    sqliteDb.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run('chat_id', String(chatId));
  }

  function prepare(sql) {
    const stmt = sqliteDb.prepare(sql);
    return {
      all:    (...params) => Promise.resolve(stmt.all(...params.flat())),
      get:    (...params) => Promise.resolve(stmt.get(...params.flat()) || null),
      run:    (...params) => { const r = stmt.run(...params.flat()); return Promise.resolve({ lastInsertRowid: r.lastInsertRowid, changes: r.changes }); },
      allSync:(...params) => stmt.all(...params.flat()),
      getSync:(...params) => stmt.get(...params.flat()) || null,
      runSync:(...params) => stmt.run(...params.flat()),
    };
  }

  function exec(sql) { sqliteDb.exec(sql); return Promise.resolve(); }

  function transaction(fn) {
    return async function(rows) {
      const tx = sqliteDb.transaction(rowArr => { for (const r of rowArr) fn(r); });
      tx(rows);
    };
  }

  module.exports = { prepare, exec, transaction, sqliteDb, USE_PG: false };
}
