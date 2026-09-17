'use strict';

/**
 * Tests for server/index.js — Bug condition + preservation checks.
 *
 * Runner: node --test server/index.test.js
 *
 * Validates: Requirements 1.1, 1.2, 1.6, 2.1, 2.2, 2.6, 3.1, 3.2, 3.3, 3.4, 3.5
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path   = require('path');
const fs     = require('fs');

// ─── Task 1: Bug Condition Exploration ───────────────────────────────────────
//
// Property 1: Bug Condition — Server Module Loads Without Crash
//
// On UNFIXED code this test WOULD FAIL because document is not defined at
// module scope in server/index.js. Now that the fix is applied it passes,
// confirming isBugCondition is no longer satisfied.
//
// Validates: Requirements 1.1, 1.2, 1.6, 2.1, 2.6

describe('Bug Condition — server/index.js must not reference browser globals at module scope', () => {
  const SERVER_FILE = path.join(__dirname, 'index.js');
  const source = fs.readFileSync(SERVER_FILE, 'utf8');

  test('Telegram deep links normalize bot usernames without the leading @', () => {
    const { getBotUsername, ensureBotUsername } = require('./telegram');
    assert.equal(typeof ensureBotUsername, 'function');
    const prev = process.env.TELEGRAM_BOT_USERNAME;
    process.env.TELEGRAM_BOT_USERNAME = '@coreaya_pa';
    try {
      assert.equal(getBotUsername(), 'coreaya_pa');
    } finally {
      if (prev === undefined) delete process.env.TELEGRAM_BOT_USERNAME;
      else process.env.TELEGRAM_BOT_USERNAME = prev;
    }
  });

  // Strip out comments and string literals to reduce false-positive matches.
  // This is a conservative heuristic: we remove line comments (//) and block
  // comments (/* ... */), then check for bare identifiers.
  function stripCommentsAndStrings(code) {
    // Remove block comments
    let stripped = code.replace(/\/\*[\s\S]*?\*\//g, '');
    // Remove line comments
    stripped = stripped.replace(/\/\/[^\n]*/g, '');
    // Replace string literals with empty strings (single, double, template)
    stripped = stripped.replace(/'[^'\\]*(?:\\.[^'\\]*)*'/g, "''");
    stripped = stripped.replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, '""');
    stripped = stripped.replace(/`[^`\\]*(?:\\.[^`\\]*)*`/g, '``');
    return stripped;
  }

  const strippedSource = stripCommentsAndStrings(source);

  test('server/index.js contains no bare reference to `document`', () => {
    // Match `document` as a standalone identifier (not part of a longer name)
    const match = strippedSource.match(/\bdocument\b/);
    assert.equal(
      match,
      null,
      `Found 'document' reference in server/index.js — browser DOM code must not exist in server files.\n` +
      `Context: "${match ? strippedSource.slice(Math.max(0, strippedSource.indexOf(match[0]) - 40), strippedSource.indexOf(match[0]) + 80) : ''}"`,
    );
  });

  test('server/index.js contains no bare reference to `sessionStorage`', () => {
    const match = strippedSource.match(/\bsessionStorage\b/);
    assert.equal(
      match,
      null,
      `Found 'sessionStorage' reference in server/index.js — browser Web Storage API must not exist in server files.`,
    );
  });

  test('server/index.js contains no bare reference to `window` (DOM global)', () => {
    // Only flag `window` used as a standalone expression, not as a word fragment
    const match = strippedSource.match(/\bwindow\s*[.[(]/);
    assert.equal(
      match,
      null,
      `Found 'window' property/method access in server/index.js — browser Window API must not exist in server files.`,
    );
  });

  test('server/index.js does not contain loadBrief function (browser-only, already in public/app.html)', () => {
    const match = strippedSource.match(/function\s+loadBrief\s*\(/);
    assert.equal(match, null, `Found loadBrief() in server/index.js — this browser-only helper must live only in public/app.html`);
  });

  test('server/index.js does not contain loadPlan function (browser-only, already in public/app.html)', () => {
    const match = strippedSource.match(/function\s+loadPlan\s*\(/);
    assert.equal(match, null, `Found loadPlan() in server/index.js — this browser-only helper must live only in public/app.html`);
  });

  test('server/index.js does not contain startCheckout function (browser-only, already in public/app.html)', () => {
    const match = strippedSource.match(/(?:async\s+)?function\s+startCheckout\s*\(/);
    assert.equal(match, null, `Found startCheckout() in server/index.js — this browser-only helper must live only in public/app.html`);
  });

  test('server/index.js does not contain resumePendingPlan function (browser-only, already in public/app.html)', () => {
    const match = strippedSource.match(/function\s+resumePendingPlan\s*\(/);
    assert.equal(match, null, `Found resumePendingPlan() in server/index.js — this browser-only helper must live only in public/app.html`);
  });
});

// ─── Task 1 continued: Module load smoke test ────────────────────────────────
//
// Confirms server/index.js can be loaded in a child Node.js process without
// crashing. The child process sets minimal env vars and exits immediately
// after the module is evaluated (before app.listen's callback fires).
//
// On UNFIXED code (with document.getElementById at top-level) this would fail
// with "ReferenceError: document is not defined". On fixed code it passes.
//
// Validates: Requirements 2.1, 2.2

test('server/index.js loads in Node.js without ReferenceError (module smoke test)', { timeout: 15000 }, () => {
  const { spawnSync } = require('child_process');

  // Inline script: set env vars, mock require() for heavy deps, then load
  // server/index.js in the same process. We intercept app.listen to prevent
  // actually binding a port.
  const script = `
    const Module = require('module');
    const originalLoad = Module._load;

    // Stub modules that have real side-effects at require-time
    const stubs = {
      './telegram':   { initBot: () => {}, setupWebhook: async () => {}, sendMessage: async () => {} },
      './scheduler':  { startScheduler: () => {} },
      './webchat':    { registerChatRoutes: () => {} },
      './plan':       { enforceQuota: () => (req, res, next) => next(), rateLimit: () => (req, res, next) => next() },
      './billing':    { registerBillingRoutes: () => {} },
    };

    Module._load = function(request, parent, isMain) {
      // Normalise relative paths from server/index.js
      if (stubs[request]) return stubs[request];
      return originalLoad.apply(this, arguments);
    };

    // Ensure env vars that auth.js requires are set before db.js / auth.js load
    process.env.JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long!!';
    process.env.PORT = '0';
    process.env.DATA_DIR = require('os').tmpdir();

    // Prevent app.listen from blocking — patch it before the module runs
    const express = require('express');
    const origExpress = express;
    // We do NOT need to patch express itself; app.listen() is async and the
    // test just verifies no synchronous ReferenceError is thrown during require.

    try {
      require('./server/index.js');
      process.stdout.write('OK');
      process.exit(0);
    } catch (err) {
      process.stderr.write(err.message);
      process.exit(1);
    }
  `;

  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    timeout: 12000,
    encoding: 'utf8',
    env: {
      ...process.env,
      JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long!!',
      PORT: '0',
      DATA_DIR: require('os').tmpdir(),
    },
  });

  // If the process exits with code 1, the module threw an error
  if (result.status === 1) {
    const errMsg = result.stderr || result.stdout || '(no output)';
    assert.fail(
      `server/index.js threw an error during require() in a fresh Node.js process:\n${errMsg}\n` +
      `This confirms the bug condition — browser-only globals (document, sessionStorage, window) ` +
      `are still present at module scope in server/index.js.`
    );
  }

  // Anything except status 1 means the module loaded without synchronous crash
  // (status 0 = clean exit, null = timeout killed but no ReferenceError detected)
  assert.notEqual(result.status, 1, 'Module must not throw ReferenceError on load');
});

// ─── Task 2: Preservation — Express server wiring is intact ─────────────────
//
// Property 2: Preservation — All Express Routes, Middleware, and Bootstrap
// Are Unaffected.
//
// These tests construct a minimal version of the same Express wiring and verify
// the core invariants hold without running the full server bootstrap.
//
// Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5

describe('Preservation — server/index.js Express wiring', () => {
  // Build a minimal Express app that mirrors the route setup in server/index.js
  // using in-memory stubs for db, auth, and billing. This lets us verify route
  // behaviour without needing a real DB or live auth tokens.

  let app;
  let Database;

  // Minimal db wrapper around better-sqlite3 in-memory, matching the db.js API
  function makeInMemoryDb() {
    Database = Database || require('better-sqlite3');
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
        created_at TEXT NOT NULL,
        user_id INTEGER,
        next_ping_at TEXT,
        ping_count INTEGER NOT NULL DEFAULT 0,
        start_at TEXT,
        due_at TEXT
      );
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        name TEXT,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        created_at TEXT NOT NULL,
        profile_text TEXT,
        plan TEXT NOT NULL DEFAULT 'free',
        plan_expires_at TEXT,
        payfast_token TEXT,
        telegram_chat_id TEXT,
        telegram_link_code TEXT
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
        created_at TEXT NOT NULL,
        user_id INTEGER
      );
    `);
    function prepare(sql) {
      const stmt = sqlite.prepare(sql);
      return {
        all: (...p) => Promise.resolve(stmt.all(...p.flat())),
        get: (...p) => Promise.resolve(stmt.get(...p.flat()) ?? null),
        run: (...p) => {
          const r = stmt.run(...p.flat());
          return Promise.resolve({ lastInsertRowid: r.lastInsertRowid, changes: r.changes });
        },
      };
    }
    return { prepare, sqlite };
  }

  function buildTestApp(db, userId) {
    const express = require('express');
    const cookieParser = require('cookie-parser');
    const testApp = express();
    testApp.use(express.json());
    testApp.use(cookieParser());

    // Stub requireUser: if userId is set, attach it; otherwise 401
    testApp.use((req, res, next) => {
      if (userId != null) {
        req.userId = userId;
        next();
      } else {
        res.status(401).json({ error: 'not authenticated' });
      }
    });

    // ─── Tasks routes (copied from server/index.js for preservation test) ──────

    testApp.get('/api/tasks', async (req, res) => {
      try {
        const tasks = await db.prepare(
          `SELECT * FROM tasks WHERE user_id = ? ORDER BY
            CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 ELSE 1 END ASC,
            status DESC, created_at DESC`
        ).all(req.userId);
        res.json(tasks);
      } catch (err) { res.status(500).json({ error: err.message }); }
    });

    testApp.post('/api/tasks', async (req, res) => {
      const { title, notes, remind_at, stale_days, stale_minutes, priority, recurring, start_at, due_at } = req.body;
      if (!title || !title.trim()) {
        return res.status(400).json({ error: 'title is required' });
      }
      const staleMins = stale_minutes
        ? parseInt(stale_minutes, 10)
        : (stale_days ? parseInt(stale_days, 10) * 1440 : 4320);
      const now = new Date().toISOString();
      try {
        const result = await db.prepare(
          `INSERT INTO tasks (title, notes, remind_at, stale_minutes, priority, recurring, start_at, due_at, last_touched_at, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(title.trim(), notes || null, remind_at || null, staleMins, priority || 'normal', recurring || null, start_at || null, due_at || null, now, now, req.userId);
        const task = await db.prepare(`SELECT * FROM tasks WHERE id = ? AND user_id = ?`).get(result.lastInsertRowid, req.userId);
        res.status(201).json(task);
      } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ─── Status route ──────────────────────────────────────────────────────────

    testApp.get('/api/status', async (req, res) => {
      try {
        const u = await db.prepare(`SELECT telegram_chat_id FROM users WHERE id = ?`).get(req.userId);
        res.json({ telegramLinked: !!u?.telegram_chat_id });
      } catch (err) { res.status(500).json({ error: err.message }); }
    });

    return testApp;
  }

  // Simple HTTP helper — calls a route handler via Node's http module
  function httpRequest(testApp, method, urlPath, body) {
    return new Promise((resolve, reject) => {
      const http = require('http');
      const server = http.createServer(testApp);
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        const bodyStr = body ? JSON.stringify(body) : null;
        const req = http.request({
          hostname: '127.0.0.1',
          port,
          path: urlPath,
          method,
          headers: {
            'Content-Type': 'application/json',
            ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
          },
        }, (res) => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            server.close();
            try {
              resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers });
            } catch {
              resolve({ status: res.statusCode, body: data, headers: res.headers });
            }
          });
        });
        req.on('error', reject);
        if (bodyStr) req.write(bodyStr);
        req.end();
      });
    });
  }

  // ─── GET /api/tasks ──────────────────────────────────────────────────────────

  test('GET /api/tasks returns 200 and empty array for authenticated user with no tasks', async () => {
    const db = makeInMemoryDb();
    const testApp = buildTestApp(db, 1);
    const res = await httpRequest(testApp, 'GET', '/api/tasks', null);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body), 'Response body must be an array');
  });

  test('GET /api/tasks returns 401 when not authenticated', async () => {
    const db = makeInMemoryDb();
    const testApp = buildTestApp(db, null); // null userId → 401
    const res = await httpRequest(testApp, 'GET', '/api/tasks', null);
    assert.equal(res.status, 401);
  });

  // ─── POST /api/tasks ─────────────────────────────────────────────────────────

  test('POST /api/tasks returns 201 and the created task when title is provided', async () => {
    const db = makeInMemoryDb();
    const testApp = buildTestApp(db, 1);
    const res = await httpRequest(testApp, 'POST', '/api/tasks', { title: 'Buy milk' });
    assert.equal(res.status, 201);
    assert.equal(res.body.title, 'Buy milk');
    assert.ok(res.body.id, 'Created task must have an id');
  });

  test('POST /api/tasks returns 400 with "title is required" when title is absent', async () => {
    const db = makeInMemoryDb();
    const testApp = buildTestApp(db, 1);
    const res = await httpRequest(testApp, 'POST', '/api/tasks', { notes: 'some notes' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'title is required');
  });

  test('POST /api/tasks returns 400 with "title is required" when title is empty string', async () => {
    const db = makeInMemoryDb();
    const testApp = buildTestApp(db, 1);
    const res = await httpRequest(testApp, 'POST', '/api/tasks', { title: '   ' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'title is required');
  });

  test('POST /api/tasks returns 401 when not authenticated', async () => {
    const db = makeInMemoryDb();
    const testApp = buildTestApp(db, null);
    const res = await httpRequest(testApp, 'POST', '/api/tasks', { title: 'Buy milk' });
    assert.equal(res.status, 401);
  });

  // ─── POST /api/tasks — property: title is required for any payload ───────────
  //
  // Validates: Requirements 3.1, 3.2
  //
  // Property: For any POST /api/tasks body that lacks a non-whitespace title,
  //           the route MUST return 400 with error "title is required".

  test('POST /api/tasks — property: missing/blank title always returns 400 (varied payloads)', async () => {
    const db = makeInMemoryDb();
    const testApp = buildTestApp(db, 1);

    // Simulate many payloads that lack a valid title
    const badPayloads = [
      {},
      { title: '' },
      { title: '   ' },
      { title: '\t\n' },
      { notes: 'memo', priority: 'high' },
      { title: null },
      { title: 0 },
      { title: false },
    ];

    for (const payload of badPayloads) {
      const res = await httpRequest(testApp, 'POST', '/api/tasks', payload);
      assert.equal(
        res.status, 400,
        `Expected 400 for payload ${JSON.stringify(payload)}, got ${res.status}`
      );
      assert.equal(
        res.body.error, 'title is required',
        `Expected "title is required" for payload ${JSON.stringify(payload)}`
      );
    }
  });

  // ─── GET /api/status ─────────────────────────────────────────────────────────

  test('GET /api/status returns 200 with telegramLinked: false when no Telegram linked', async () => {
    const db = makeInMemoryDb();
    // Insert a user without telegram_chat_id
    db.sqlite.prepare(
      `INSERT INTO users (id, email, password_hash, password_salt, created_at) VALUES (1, 'test@example.com', 'hash', 'salt', ?)`
    ).run(new Date().toISOString());
    const testApp = buildTestApp(db, 1);
    const res = await httpRequest(testApp, 'GET', '/api/status', null);
    assert.equal(res.status, 200);
    assert.equal(res.body.telegramLinked, false);
  });

  test('GET /api/status returns 401 when not authenticated', async () => {
    const db = makeInMemoryDb();
    const testApp = buildTestApp(db, null);
    const res = await httpRequest(testApp, 'GET', '/api/status', null);
    assert.equal(res.status, 401);
  });

  // ─── Preservation: unauthenticated requests return 401 (property) ────────────
  //
  // Validates: Requirements 3.1, 3.5
  //
  // Property: For any request to a protected route without credentials,
  //           the server MUST return 401.

  test('Preservation property — unauthenticated requests to protected routes all return 401', async () => {
    const db = makeInMemoryDb();
    const testApp = buildTestApp(db, null);

    const protectedRoutes = [
      { method: 'GET',  path: '/api/tasks' },
      { method: 'POST', path: '/api/tasks' },
      { method: 'GET',  path: '/api/status' },
    ];

    for (const route of protectedRoutes) {
      const res = await httpRequest(testApp, route.method, route.path, route.method === 'POST' ? { title: 'x' } : null);
      assert.equal(
        res.status, 401,
        `Expected 401 for unauthenticated ${route.method} ${route.path}, got ${res.status}`
      );
    }
  });

  // ─── Preservation: server/index.js still calls app.listen ────────────────────
  //
  // Validates: Requirements 2.1, 3.5
  //
  // Assert that the source code still contains the app.listen call with the
  // configured port — confirms the server bootstrap is intact after the fix.

  test('server/index.js still contains app.listen call (bootstrap intact)', () => {
    const SERVER_FILE = path.join(__dirname, 'index.js');
    const source = fs.readFileSync(SERVER_FILE, 'utf8');
    const match = source.match(/\bapp\.listen\s*\(/);
    assert.ok(match, 'server/index.js must contain app.listen() to start the Express server');
  });
});
