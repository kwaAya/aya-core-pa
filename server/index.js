require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');
const { initBot } = require('./telegram');
const { startScheduler } = require('./scheduler');
const { registerChatRoutes } = require('./webchat');

const app = express();
app.use(cors());
app.use(express.json());

// ─── Auth ──────────────────────────────────────────────────────────────────
// Shared-secret gate for the API. Set PA_ACCESS_TOKEN once this is deployed
// publicly — the web app prompts for it once and remembers it locally.
// Leave PA_ACCESS_TOKEN unset for local dev and auth is skipped entirely.
const PA_TOKEN = process.env.PA_ACCESS_TOKEN;
function requireAuth(req, res, next) {
  if (!PA_TOKEN) return next();
  if (req.get('x-pa-token') === PA_TOKEN) return next();
  res.status(401).json({ error: 'unauthorized' });
}
app.use('/api', requireAuth);

app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── Tasks ───────────────────────────────────────────────────────────────────

app.get('/api/tasks', async (req, res) => {
  try {
    const tasks = await db.prepare(
      `SELECT * FROM tasks ORDER BY
        CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 ELSE 1 END ASC,
        status ASC,
        created_at DESC`
    ).all();
    res.json(tasks);
  } catch (err) {
    console.error('[tasks GET] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tasks', async (req, res) => {
  const { title, notes, remind_at, stale_days, stale_minutes, priority, recurring } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }
  // accept stale_minutes directly, or convert stale_days for backwards compat
  const staleMins = stale_minutes
    ? parseInt(stale_minutes, 10)
    : (stale_days ? parseInt(stale_days, 10) * 1440 : 4320); // default 3 days

  const now = new Date().toISOString();
  try {
    const result = await db.prepare(
      `INSERT INTO tasks (title, notes, remind_at, stale_minutes, priority, recurring, last_touched_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      title.trim(),
      notes || null,
      remind_at || null,
      staleMins,
      priority || 'normal',
      recurring || null,
      now,
      now
    );

    const task = await db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(result.lastInsertRowid);
    res.status(201).json(task);
  } catch (err) {
    console.error('[tasks POST] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/tasks/:id', async (req, res) => {
  const { id } = req.params;
  const { title, notes, status, remind_at, stale_days, stale_minutes, priority, recurring, touch } = req.body;

  try {
    const existing = await db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);
    if (!existing) return res.status(404).json({ error: 'not found' });

    // compute stale_minutes from either field
    let newStaleMins = existing.stale_minutes || (existing.stale_days || 3) * 1440;
    if (stale_minutes !== undefined) newStaleMins = parseInt(stale_minutes, 10);
    else if (stale_days !== undefined) newStaleMins = parseInt(stale_days, 10) * 1440;

    const remindChanged = remind_at !== undefined && remind_at !== existing.remind_at;
    const becameDone     = status === 'done' && existing.status !== 'done';
    const resetPing      = remindChanged || becameDone;

    const updated = {
      title:           title     !== undefined ? title     : existing.title,
      notes:           notes     !== undefined ? notes     : existing.notes,
      status:          status    !== undefined ? status    : existing.status,
      remind_at:       remind_at !== undefined ? remind_at : existing.remind_at,
      stale_minutes:   newStaleMins,
      priority:        priority  !== undefined ? priority  : existing.priority,
      recurring:       recurring !== undefined ? recurring : existing.recurring,
      last_touched_at: touch ? new Date().toISOString() : existing.last_touched_at,
      reminded:        remindChanged ? 0 : existing.reminded,
      ping_count:      resetPing ? 0 : existing.ping_count,
      next_ping_at:    resetPing ? null : existing.next_ping_at,
    };

    await db.prepare(
      `UPDATE tasks SET title=?, notes=?, status=?, remind_at=?, stale_minutes=?, priority=?, recurring=?, last_touched_at=?, reminded=?, ping_count=?, next_ping_at=? WHERE id=?`
    ).run(
      updated.title, updated.notes, updated.status, updated.remind_at,
      updated.stale_minutes, updated.priority, updated.recurring,
      updated.last_touched_at, updated.reminded, updated.ping_count, updated.next_ping_at, id
    );

    const task = await db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);
    res.json(task);
  } catch (err) {
    console.error('[tasks PATCH] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/tasks/:id', async (req, res) => {
  try {
    await db.prepare(`DELETE FROM tasks WHERE id = ?`).run(req.params.id);
    res.status(204).end();
  } catch (err) {
    console.error('[tasks DELETE] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Finance ──────────────────────────────────────────────────────────────────

const multer = require('multer');
const os     = require('os');
const {
  parseStatementFile,
  commitTransactions,
  deduplicateTransactions,
  learnMerchantCategory,
  surfaceImportPatterns,
} = require('./finance-import');
const { sendMessage } = require('./telegram');

// store uploads in OS temp dir, deleted immediately after parse
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 10 * 1024 * 1024 } });

app.get('/api/finance', async (req, res) => {
  try {
    const entries = await db.prepare(
      `SELECT * FROM finance_entries ORDER BY created_at DESC LIMIT 100`
    ).all();

    const totals = await db.prepare(
      `SELECT type, SUM(amount) as total FROM finance_entries GROUP BY type`
    ).all();

    const monthStart = new Date().toISOString().slice(0, 7) + '-01';
    const byCategory = await db.prepare(
      `SELECT category, type, SUM(amount) as total
       FROM finance_entries
       WHERE created_at >= ?
       GROUP BY category, type
       ORDER BY total DESC`
    ).all(monthStart);

    // weekly net trend, last 8 weeks (Sunday-start buckets, computed in JS for SQLite/Postgres parity)
    const trendCutoff = new Date();
    trendCutoff.setDate(trendCutoff.getDate() - 56);
    const trendRows = await db.prepare(
      `SELECT type, amount, created_at FROM finance_entries WHERE created_at >= ?`
    ).all(trendCutoff.toISOString());
    const weekBuckets = {};
    trendRows.forEach(r => {
      const d = new Date(r.created_at);
      const weekStart = new Date(d);
      weekStart.setDate(d.getDate() - d.getDay());
      const key = weekStart.toISOString().slice(0, 10);
      weekBuckets[key] = (weekBuckets[key] || 0) + (r.type === 'income' ? r.amount : -r.amount);
    });
    const trend = [];
    for (let i = 7; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - d.getDay() - i * 7);
      const key = d.toISOString().slice(0, 10);
      trend.push({ week: key, net: weekBuckets[key] || 0 });
    }

    res.json({ entries, totals, byCategory, trend });
  } catch (err) {
    console.error('[finance GET] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/finance', async (req, res) => {
  const { type, amount, category, note } = req.body;
  if (!amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: 'valid amount is required' });
  }
  const now = new Date().toISOString();
  try {
    const result = await db.prepare(
      `INSERT INTO finance_entries (type, amount, category, note, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      type || 'expense',
      parseFloat(amount),
      category || 'general',
      note || null,
      now
    );

    const entry = await db.prepare(`SELECT * FROM finance_entries WHERE id = ?`).get(result.lastInsertRowid);
    res.status(201).json(entry);
  } catch (err) {
    console.error('[finance POST] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Finance: bank settings (must be before :id routes) ──────────────────────

app.get('/api/finance/settings', async (req, res) => {
  try {
    const rows = await db.prepare(`SELECT key, value FROM bank_settings`).all();
    const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
    res.json(settings);
  } catch (err) {
    console.error('[finance settings GET] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/finance/settings', async (req, res) => {
  const allowed = ['bank', 'last_four', 'last_imported'];
  const upsert  = db.prepare(`INSERT INTO bank_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  try {
    for (const key of allowed) {
      if (req.body[key] !== undefined) await upsert.run(key, req.body[key]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[finance settings POST] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Finance: statement import (must be before :id routes) ───────────────────

app.post('/api/finance/import/preview', upload.single('statement'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file uploaded' });
  try {
    const parsed  = await parseStatementFile(req.file.path);
    const deduped = await deduplicateTransactions(parsed);
    res.json({ transactions: deduped, totalParsed: parsed.length, duplicatesSkipped: parsed.length - deduped.length });
  } catch (err) {
    console.error('[import] parse failed:', err.message);
    try { require('fs').unlinkSync(req.file.path); } catch {}
    res.status(422).json({ error: err.message });
  }
});

app.post('/api/finance/import/commit', async (req, res) => {
  const { transactions } = req.body;
  if (!Array.isArray(transactions) || transactions.length === 0)
    return res.status(400).json({ error: 'no transactions to commit' });

  // coerce amount to number — frontend JSON round-trip can turn floats into strings
  const valid = transactions
    .map(t => ({ ...t, amount: parseFloat(t.amount) }))
    .filter(t => t.importedDate && !isNaN(t.amount) && t.amount > 0 && t.type);

  if (valid.length === 0) {
    sendMessage('✅ statement received — all transactions were already recorded, nothing new to import.').catch(() => {});
    return res.status(400).json({ error: 'no valid transactions after validation' });
  }

  try {
    await commitTransactions(valid);

    // Fire post-import pattern surfacing asynchronously — do not block the response
    surfaceImportPatterns(valid).catch(err =>
      console.error('[import] pattern surfacing failed:', err.message)
    );

    res.json({ committed: valid.length });
  } catch (err) {
    console.error('[import] commit failed:', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ─── Finance: :id routes ──────────────────────────────────────────────────────

app.patch('/api/finance/:id/category', async (req, res) => {
  const { category } = req.body;
  if (!category) return res.status(400).json({ error: 'category required' });
  try {
    const entry = await db.prepare(`SELECT * FROM finance_entries WHERE id = ?`).get(req.params.id);
    if (!entry) return res.status(404).json({ error: 'not found' });
    await db.prepare(`UPDATE finance_entries SET category = ? WHERE id = ?`).run(category, req.params.id);
    if (entry.merchant) await learnMerchantCategory(entry.merchant, category);
    res.json({ ok: true, learned: !!entry.merchant });
  } catch (err) {
    console.error('[finance category PATCH] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/finance/:id', async (req, res) => {
  try {
    await db.prepare(`DELETE FROM finance_entries WHERE id = ?`).run(req.params.id);
    res.status(204).end();
  } catch (err) {
    console.error('[finance DELETE] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Status ───────────────────────────────────────────────────────────────────

app.get('/api/status', async (req, res) => {
  try {
    const chatIdRow = await db.prepare(`SELECT value FROM settings WHERE key = 'chat_id'`).get();
    res.json({ telegramLinked: !!chatIdRow });
  } catch (err) {
    console.error('[status GET] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Context (for chat empty state) ───────────────────────────────────────────

app.get('/api/context', async (req, res) => {
  try {
    const openRow  = await db.prepare(`SELECT COUNT(*) as n FROM tasks WHERE status = 'open'`).get();
    const highRow  = await db.prepare(`SELECT COUNT(*) as n FROM tasks WHERE status = 'open' AND priority = 'high'`).get();
    const openCount = openRow.n;
    const highCount = highRow.n;

    const month = new Date().toISOString().slice(0, 7);
    const finRows = await db.prepare(
      `SELECT type, SUM(amount) as total FROM finance_entries WHERE created_at >= ? GROUP BY type`
    ).all(`${month}-01`);
    const income  = finRows.find(r => r.type === 'income')?.total  || 0;
    const expense = finRows.find(r => r.type === 'expense')?.total || 0;

    // most recent high priority task title, if any
    const urgent = await db.prepare(
      `SELECT title FROM tasks WHERE status = 'open' AND priority = 'high' ORDER BY created_at DESC LIMIT 1`
    ).get();

    // completion history — computed in JS so it works identically on SQLite + Postgres
    const doneRows = await db.prepare(
      `SELECT last_touched_at FROM tasks WHERE status = 'done' ORDER BY last_touched_at DESC LIMIT 300`
    ).all();
    const doneDates = new Set(doneRows.map(r => r.last_touched_at.slice(0, 10)));
    const todayKey  = new Date().toISOString().slice(0, 10);
    const doneToday = doneRows.filter(r => r.last_touched_at.slice(0, 10) === todayKey).length;

    const last7 = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      last7.push(doneDates.has(d.toISOString().slice(0, 10)));
    }
    // grace period: if today has nothing done yet, count from yesterday so the
    // streak doesn't zero out before the day's actually over
    let streakDays = 0;
    const startOffset = doneDates.has(todayKey) ? 0 : 1;
    for (let i = startOffset; ; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      if (doneDates.has(d.toISOString().slice(0, 10))) streakDays++;
      else break;
    }

    res.json({
      openCount,
      highCount,
      financeNet: income - expense,
      urgentTask: urgent ? urgent.title : null,
      doneToday,
      last7,
      streakDays,
    });
  } catch (err) {
    console.error('[context GET] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Heatmap (contribution-style, last 12 weeks) ──────────────────────────────

app.get('/api/heatmap', async (req, res) => {
  try {
    const days = 84;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - (days - 1));
    cutoff.setHours(0, 0, 0, 0);
    const rows = await db.prepare(
      `SELECT last_touched_at FROM tasks WHERE status = 'done' AND last_touched_at >= ?`
    ).all(cutoff.toISOString());
    const counts = {};
    rows.forEach(r => {
      const key = r.last_touched_at.slice(0, 10);
      counts[key] = (counts[key] || 0) + 1;
    });
    const cells = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      cells.push({ date: key, count: counts[key] || 0 });
    }
    res.json({ days: cells });
  } catch (err) {
    console.error('[heatmap GET] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Profile ──────────────────────────────────────────────────────────────────

const fs   = require('fs');
const profilePath = require('path').join(__dirname, 'profile.md');

app.get('/api/profile', (req, res) => {
  try {
    const content = fs.readFileSync(profilePath, 'utf-8');
    res.json({ content });
  } catch {
    res.json({ content: '' });
  }
});

app.post('/api/profile', (req, res) => {
  const { content } = req.body;
  if (typeof content !== 'string') return res.status(400).json({ error: 'content required' });
  try {
    fs.writeFileSync(profilePath, content, 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Chat (Claude reasoning) ──────────────────────────────────────────────────

registerChatRoutes(app);

// ─── Boot ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[server] running on port ${PORT}`);
  initBot();
  startScheduler();
});
