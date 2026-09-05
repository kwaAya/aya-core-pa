const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'data.sqlite'));

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'open',       -- open | done
    priority TEXT NOT NULL DEFAULT 'normal',   -- high | normal | low
    remind_at TEXT,                             -- ISO datetime, nullable
    reminded INTEGER NOT NULL DEFAULT 0,        -- has the one-time reminder fired
    stale_days INTEGER NOT NULL DEFAULT 3,      -- nudge if untouched this many days
    recurring TEXT,                             -- null | daily | weekly | monthly
    last_touched_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS finance_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL DEFAULT 'expense',      -- expense | income
    amount REAL NOT NULL,
    category TEXT NOT NULL DEFAULT 'general', -- food | transport | bills | income | general | other
    note TEXT,
    merchant TEXT,                             -- normalised merchant name (from import)
    source TEXT NOT NULL DEFAULT 'manual',     -- manual | import
    imported_date TEXT,                        -- original transaction date from statement (ISO)
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS merchant_category_map (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern TEXT NOT NULL UNIQUE,              -- lowercased normalised merchant pattern
    category TEXT NOT NULL,
    hit_count INTEGER NOT NULL DEFAULT 1,      -- how many times this mapping has been applied
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bank_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// migrate finance_entries if upgrading from earlier schema
const finCols = db.prepare(`PRAGMA table_info(finance_entries)`).all().map(c => c.name);
if (!finCols.includes('merchant'))      db.exec(`ALTER TABLE finance_entries ADD COLUMN merchant TEXT`);
if (!finCols.includes('source'))        db.exec(`ALTER TABLE finance_entries ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'`);
if (!finCols.includes('imported_date')) db.exec(`ALTER TABLE finance_entries ADD COLUMN imported_date TEXT`);

// migrate existing tasks table to add new columns if upgrading
const taskCols = db.prepare(`PRAGMA table_info(tasks)`).all().map(c => c.name);
if (!taskCols.includes('priority')) {
  db.exec(`ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'`);
}
if (!taskCols.includes('recurring')) {
  db.exec(`ALTER TABLE tasks ADD COLUMN recurring TEXT`);
}

module.exports = db;
