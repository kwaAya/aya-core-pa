'use strict';

/**
 * Unit tests for server/analytics.js
 * Runner: node --test server/analytics.test.js
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const Database = require('better-sqlite3');
const { getEngagementWindow, buildEnrichedFinanceSnapshot, recordEngagementEvent } = require('./analytics');

// ─── Helper ──────────────────────────────────────────────────────────────────

function makeTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE engagement_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      hour_of_day INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE finance_entries (
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
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE budget_baselines (
      category TEXT PRIMARY KEY,
      avg_weekly REAL NOT NULL DEFAULT 0,
      sample_weeks INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `);

  function prepare(sql) {
    const stmt = sqlite.prepare(sql);
    return {
      all: (...p) => Promise.resolve(stmt.all(...p.flat())),
      get: (...p) => Promise.resolve(stmt.get(...p.flat()) || null),
      run: (...p) => {
        const r = stmt.run(...p.flat());
        return Promise.resolve({ lastInsertRowid: r.lastInsertRowid, changes: r.changes });
      },
    };
  }

  return { prepare, sqlite };
}

/** Returns an ISO date string N days ago from now */
function daysAgo(n) {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

/** Returns an ISO date string for the start of the week that is N weeks ago */
function weeksAgo(n) {
  const d = new Date(Date.now() - n * 7 * 24 * 60 * 60 * 1000);
  d.setHours(12, 0, 0, 0);
  return d.toISOString();
}

// ─── getEngagementWindow ──────────────────────────────────────────────────────

test('getEngagementWindow — returns fallback when table is empty', async () => {
  const db = makeTestDb();
  const result = await getEngagementWindow(db);
  assert.deepEqual(result, { startHour: 9, endHour: 11, hasSufficientHistory: false });
});

test('getEngagementWindow — returns fallback when fewer than 7 distinct days', async () => {
  const db = makeTestDb();
  // Seed events on 6 distinct days (all within last 30 days)
  for (let day = 1; day <= 6; day++) {
    db.sqlite.prepare(
      `INSERT INTO engagement_events (task_id, event_type, hour_of_day, created_at) VALUES (?, ?, ?, ?)`
    ).run(1, 'sent', 10, daysAgo(day));
  }
  const result = await getEngagementWindow(db);
  assert.deepEqual(result, { startHour: 9, endHour: 11, hasSufficientHistory: false });
});

test('getEngagementWindow — returns peak hour when ≥7 distinct days exist', async () => {
  const db = makeTestDb();
  // Seed events across 10 distinct days at hour 10 (1 event per day)
  for (let day = 1; day <= 10; day++) {
    db.sqlite.prepare(
      `INSERT INTO engagement_events (task_id, event_type, hour_of_day, created_at) VALUES (?, ?, ?, ?)`
    ).run(1, 'sent', 10, daysAgo(day));
  }
  // Add 15 extra events at hour 14 across the same 10 days — hour 14 clearly wins
  for (let i = 0; i < 15; i++) {
    const day = (i % 10) + 1;
    db.sqlite.prepare(
      `INSERT INTO engagement_events (task_id, event_type, hour_of_day, created_at) VALUES (?, ?, ?, ?)`
    ).run(2, 'replied', 14, daysAgo(day));
  }
  const result = await getEngagementWindow(db);
  assert.equal(result.startHour, 14);
  assert.equal(result.endHour, 16);
  assert.equal(result.hasSufficientHistory, true);
});

test('getEngagementWindow — returns fallback without throwing when db throws', async () => {
  const brokenDb = {
    prepare: () => { throw new Error('DB exploded'); },
  };
  const result = await getEngagementWindow(brokenDb);
  assert.deepEqual(result, { startHour: 9, endHour: 11, hasSufficientHistory: false });
});

// ─── buildEnrichedFinanceSnapshot ────────────────────────────────────────────

test('buildEnrichedFinanceSnapshot — includes up-weeks trend when 3 consecutive increasing weeks', async () => {
  const db = makeTestDb();
  // Seed 3 consecutive weeks of increasing "food" spend
  // Week 3 ago: R100, Week 2 ago: R200, Week 1 ago: R300
  const weekOffsets = [21, 14, 7]; // days ago for each week start
  const amounts     = [100, 200, 300];
  for (let i = 0; i < 3; i++) {
    db.sqlite.prepare(
      `INSERT INTO finance_entries (type, amount, category, source, imported_date, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('expense', amounts[i], 'food', 'manual', null, daysAgo(weekOffsets[i]));
  }

  const snapshot = await buildEnrichedFinanceSnapshot(db);
  assert.ok(snapshot.includes('food'), `Expected 'food' trend in: ${snapshot}`);
  assert.ok(snapshot.includes('weeks in a row'), `Expected trend label in: ${snapshot}`);
});

test('buildEnrichedFinanceSnapshot — omits trend label when spend is flat', async () => {
  const db = makeTestDb();
  // Seed 3 weeks of the same amount for "food"
  const weekOffsets = [21, 14, 7];
  for (const offset of weekOffsets) {
    db.sqlite.prepare(
      `INSERT INTO finance_entries (type, amount, category, source, imported_date, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('expense', 100, 'food', 'manual', null, daysAgo(offset));
  }

  const snapshot = await buildEnrichedFinanceSnapshot(db);
  assert.ok(!snapshot.includes('weeks in a row'), `Did not expect trend label, got: ${snapshot}`);
});

test('buildEnrichedFinanceSnapshot — includes uncategorised count when general+import entries exist', async () => {
  const db = makeTestDb();
  db.sqlite.prepare(
    `INSERT INTO finance_entries (type, amount, category, source, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run('expense', 50, 'general', 'import', daysAgo(1));
  db.sqlite.prepare(
    `INSERT INTO finance_entries (type, amount, category, source, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run('expense', 30, 'general', 'import', daysAgo(2));

  const snapshot = await buildEnrichedFinanceSnapshot(db);
  assert.ok(snapshot.includes('uncategorised'), `Expected uncategorised label in: ${snapshot}`);
  assert.ok(snapshot.includes('2'), `Expected count 2 in: ${snapshot}`);
});

test('buildEnrichedFinanceSnapshot — omits uncategorised count when count is 0', async () => {
  const db = makeTestDb();
  // Seed a manually-entered general entry (source='manual' — should NOT count)
  db.sqlite.prepare(
    `INSERT INTO finance_entries (type, amount, category, source, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run('expense', 50, 'general', 'manual', daysAgo(1));

  const snapshot = await buildEnrichedFinanceSnapshot(db);
  assert.ok(!snapshot.includes('uncategorised'), `Did not expect uncategorised label, got: ${snapshot}`);
});

test('buildEnrichedFinanceSnapshot — does not throw when settings table is missing', async () => {
  // Build a db WITHOUT the settings table so the recurring-charges enrichment fails
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE finance_entries (
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
  `);
  // No settings table — budget_baselines table also absent intentionally

  function prepare(sql) {
    const stmt = sqlite.prepare(sql);
    return {
      all: (...p) => Promise.resolve(stmt.all(...p.flat())),
      get: (...p) => Promise.resolve(stmt.get(...p.flat()) || null),
      run: (...p) => {
        const r = stmt.run(...p.flat());
        return Promise.resolve({ lastInsertRowid: r.lastInsertRowid, changes: r.changes });
      },
    };
  }

  const db = { prepare, sqlite };
  let result;
  await assert.doesNotReject(async () => { result = await buildEnrichedFinanceSnapshot(db); });
  assert.equal(typeof result, 'string');
  assert.ok(result.length > 0);
});

// ─── recordEngagementEvent ────────────────────────────────────────────────────

test('recordEngagementEvent — inserts row with correct hour_of_day', async () => {
  const db = makeTestDb();
  const expectedHour = new Date().getHours();

  await recordEngagementEvent(db, 42, 'sent');

  const row = db.sqlite.prepare(`SELECT * FROM engagement_events WHERE task_id = 42`).get();
  assert.ok(row, 'Expected a row to be inserted');
  assert.equal(row.task_id, 42);
  assert.equal(row.event_type, 'sent');
  // Allow ±1 to tolerate a midnight boundary crossing during test execution
  assert.ok(
    Math.abs(row.hour_of_day - expectedHour) <= 1,
    `Expected hour_of_day ≈ ${expectedHour}, got ${row.hour_of_day}`
  );
});

test('recordEngagementEvent — does not throw when db errors', async () => {
  const brokenDb = {
    prepare: () => { throw new Error('DB exploded'); },
  };
  // Must resolve (not throw) even when the DB is broken
  await assert.doesNotReject(async () => {
    await recordEngagementEvent(brokenDb, 1, 'sent');
  });
});
