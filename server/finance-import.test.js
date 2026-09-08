'use strict';

/**
 * Unit tests for surfaceImportPatterns in server/finance-import.js
 * Runner: node --test server/finance-import.test.js
 *
 * Strategy: inject stubs for ./telegram and ./db into require.cache BEFORE
 * finance-import.js is loaded, so its module-level destructuring
 *   const { sendMessage } = require('./telegram')
 * captures our stub instead of the real Telegraf bot.
 */

const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const path      = require('path');
const Database  = require('better-sqlite3');

// ─── Build in-memory SQLite that matches the db module's interface ────────────

function makeInMemoryDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS merchant_category_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      hit_count INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS finance_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL DEFAULT 'expense',
      amount REAL NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      note TEXT,
      merchant TEXT,
      source TEXT DEFAULT 'manual',
      imported_date TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS budget_baselines (
      category TEXT PRIMARY KEY,
      avg_weekly REAL NOT NULL DEFAULT 0,
      sample_weeks INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  function prepare(sql) {
    const stmt = sqlite.prepare(sql);
    return {
      all:    (...p) => Promise.resolve(stmt.all(...p.flat())),
      get:    (...p) => Promise.resolve(stmt.get(...p.flat()) ?? null),
      run:    (...p) => {
        const r = stmt.run(...p.flat());
        return Promise.resolve({ lastInsertRowid: r.lastInsertRowid, changes: r.changes });
      },
    };
  }

  function transaction(fn) {
    return async function(rows) {
      const tx = sqlite.transaction((rowArr) => { for (const r of rowArr) fn(r); });
      tx(rows);
    };
  }

  function exec(sql) { sqlite.exec(sql); return Promise.resolve(); }

  return { prepare, transaction, exec, sqlite, USE_PG: false };
}

// ─── Captured messages store ──────────────────────────────────────────────────
const capturedMessages = [];

// ─── Inject stubs into require.cache BEFORE finance-import is first loaded ───
// This is the critical trick: Node caches modules by resolved file path.
// By pre-populating the cache entries for ./telegram and ./db, we ensure that
// when finance-import.js runs `const { sendMessage } = require('./telegram')`
// at module-load time, it gets our stub.

const telegramKey     = require.resolve('./telegram');
const dbKey           = require.resolve('./db');

// Stub telegram — expose sendMessage as a simple async function
require.cache[telegramKey] = {
  id:       telegramKey,
  filename: telegramKey,
  loaded:   true,
  exports: {
    sendMessage: async (msg) => { capturedMessages.push(msg); },
    initBot:     () => null,
    getChatId:   async () => null,
    nextRecurringDate: () => null,
  },
  parent:   null,
  children: [],
  paths:    [],
};

// Stub db — use the in-memory SQLite db
const inMemoryDb = makeInMemoryDb();
require.cache[dbKey] = {
  id:       dbKey,
  filename: dbKey,
  loaded:   true,
  exports:  inMemoryDb,
  parent:   null,
  children: [],
  paths:    [],
};

// Now safe to load finance-import — it will bind our stubs
const { surfaceImportPatterns } = require('./finance-import');

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** Drain and return all messages captured since last call. */
function drainMessages() {
  return capturedMessages.splice(0);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('surfaceImportPatterns — does not throw with empty transactions array', async () => {
  drainMessages();
  await assert.doesNotReject(async () => {
    await surfaceImportPatterns([]);
  });
  const msgs = drainMessages();
  // sendMessage must have been called with a string
  assert.ok(msgs.length > 0, 'Expected sendMessage to be called');
  assert.equal(typeof msgs[0], 'string');
  assert.ok(msgs[0].includes('imported 0'), `Expected "imported 0" in message, got: ${msgs[0]}`);
});

test('surfaceImportPatterns — does not throw with valid expense transactions', async () => {
  drainMessages();
  const txns = [
    { merchant: 'woolworths', category: 'general', type: 'expense', amount: 250.00, importedDate: '2025-01-15' },
    { merchant: 'uber eats',  category: 'food',    type: 'expense', amount: 120.00, importedDate: '2025-01-15' },
  ];
  await assert.doesNotReject(async () => {
    await surfaceImportPatterns(txns);
  });
  const msgs = drainMessages();
  assert.ok(msgs.length > 0, 'Expected sendMessage to be called');
  assert.equal(typeof msgs[0], 'string');
  // Should note 2 imports
  assert.ok(msgs[0].includes('imported 2'), `Expected "imported 2" in: ${msgs[0]}`);
});

test('surfaceImportPatterns — does not throw with null/undefined merchant values', async () => {
  drainMessages();
  const txns = [
    { merchant: null,      category: 'general', type: 'expense', amount: 50.00,  importedDate: '2025-01-15' },
    { merchant: undefined, category: 'food',    type: 'expense', amount: 30.00,  importedDate: '2025-01-15' },
  ];
  await assert.doesNotReject(async () => {
    await surfaceImportPatterns(txns);
  });
  const msgs = drainMessages();
  assert.ok(msgs.length > 0, 'Expected sendMessage to be called');
});

test('surfaceImportPatterns — does not throw with income transactions', async () => {
  drainMessages();
  await assert.doesNotReject(async () => {
    await surfaceImportPatterns([
      { merchant: 'employer', category: 'income', type: 'income', amount: 15000, importedDate: '2025-01-25' },
    ]);
  });
  const msgs = drainMessages();
  assert.ok(msgs.length > 0, 'Expected sendMessage to be called');
  assert.ok(msgs[0].includes('imported 1'), `Expected "imported 1" in: ${msgs[0]}`);
});

test('surfaceImportPatterns — does not throw with a large batch (stress test)', async () => {
  drainMessages();
  const txns = Array.from({ length: 100 }, (_, i) => ({
    merchant:     `merchant_${i % 10}`,
    category:     i % 3 === 0 ? 'general' : 'food',
    type:         'expense',
    amount:       10 + i,
    importedDate: '2025-01-15',
  }));
  await assert.doesNotReject(async () => {
    await surfaceImportPatterns(txns);
  });
  const msgs = drainMessages();
  assert.ok(msgs.length > 0, 'Expected sendMessage to be called');
  assert.ok(msgs[0].includes('imported 100'), `Expected "imported 100" in: ${msgs[0]}`);
});

test('surfaceImportPatterns — does not throw with malformed transaction objects', async () => {
  drainMessages();
  // null entries are filtered out per the instruction; {} and { amount: 'not a number' } are passed through
  const txns = [{}, { amount: 'not a number' }];
  await assert.doesNotReject(async () => {
    await surfaceImportPatterns(txns);
  });
  const msgs = drainMessages();
  assert.ok(msgs.length > 0, 'Expected sendMessage to be called');
});
