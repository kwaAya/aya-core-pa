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
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── Tasks ───────────────────────────────────────────────────────────────────

app.get('/api/tasks', (req, res) => {
  const tasks = db.prepare(
    `SELECT * FROM tasks ORDER BY
      CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 ELSE 1 END ASC,
      status ASC,
      created_at DESC`
  ).all();
  res.json(tasks);
});

app.post('/api/tasks', (req, res) => {
  const { title, notes, remind_at, stale_days, priority, recurring } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }
  const now = new Date().toISOString();
  const result = db.prepare(
    `INSERT INTO tasks (title, notes, remind_at, stale_days, priority, recurring, last_touched_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    title.trim(),
    notes || null,
    remind_at || null,
    stale_days || 3,
    priority || 'normal',
    recurring || null,
    now,
    now
  );

  const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(result.lastInsertRowid);
  res.status(201).json(task);
});

app.patch('/api/tasks/:id', (req, res) => {
  const { id } = req.params;
  const { title, notes, status, remind_at, stale_days, priority, recurring, touch } = req.body;

  const existing = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const updated = {
    title:          title          !== undefined ? title          : existing.title,
    notes:          notes          !== undefined ? notes          : existing.notes,
    status:         status         !== undefined ? status         : existing.status,
    remind_at:      remind_at      !== undefined ? remind_at      : existing.remind_at,
    stale_days:     stale_days     !== undefined ? stale_days     : existing.stale_days,
    priority:       priority       !== undefined ? priority       : existing.priority,
    recurring:      recurring      !== undefined ? recurring      : existing.recurring,
    last_touched_at: touch ? new Date().toISOString() : existing.last_touched_at,
    reminded: remind_at !== undefined && remind_at !== existing.remind_at ? 0 : existing.reminded,
  };

  db.prepare(
    `UPDATE tasks SET title=?, notes=?, status=?, remind_at=?, stale_days=?, priority=?, recurring=?, last_touched_at=?, reminded=? WHERE id=?`
  ).run(
    updated.title, updated.notes, updated.status, updated.remind_at,
    updated.stale_days, updated.priority, updated.recurring,
    updated.last_touched_at, updated.reminded, id
  );

  const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);
  res.json(task);
});

app.delete('/api/tasks/:id', (req, res) => {
  db.prepare(`DELETE FROM tasks WHERE id = ?`).run(req.params.id);
  res.status(204).end();
});

// ─── Finance ──────────────────────────────────────────────────────────────────

const multer = require('multer');
const os     = require('os');
const {
  parseStatementFile,
  commitTransactions,
  deduplicateTransactions,
  learnMerchantCategory,
} = require('./finance-import');

// store uploads in OS temp dir, deleted immediately after parse
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 10 * 1024 * 1024 } });

app.get('/api/finance', (req, res) => {
  const entries = db.prepare(
    `SELECT * FROM finance_entries ORDER BY created_at DESC LIMIT 100`
  ).all();

  const totals = db.prepare(
    `SELECT type, SUM(amount) as total FROM finance_entries GROUP BY type`
  ).all();

  const byCategory = db.prepare(
    `SELECT category, type, SUM(amount) as total
     FROM finance_entries
     WHERE created_at >= date('now', 'start of month')
     GROUP BY category, type
     ORDER BY total DESC`
  ).all();

  res.json({ entries, totals, byCategory });
});

app.post('/api/finance', (req, res) => {
  const { type, amount, category, note } = req.body;
  if (!amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: 'valid amount is required' });
  }
  const now = new Date().toISOString();
  const result = db.prepare(
    `INSERT INTO finance_entries (type, amount, category, note, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    type || 'expense',
    parseFloat(amount),
    category || 'general',
    note || null,
    now
  );

  const entry = db.prepare(`SELECT * FROM finance_entries WHERE id = ?`).get(result.lastInsertRowid);
  res.status(201).json(entry);
});

// ─── Finance: bank settings (must be before :id routes) ──────────────────────

app.get('/api/finance/settings', (req, res) => {
  const rows = db.prepare(`SELECT key, value FROM bank_settings`).all();
  const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
  res.json(settings);
});

app.post('/api/finance/settings', (req, res) => {
  const allowed = ['bank', 'last_four', 'last_imported'];
  const upsert  = db.prepare(`INSERT INTO bank_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  for (const key of allowed) {
    if (req.body[key] !== undefined) upsert.run(key, req.body[key]);
  }
  res.json({ ok: true });
});

// ─── Finance: statement import (must be before :id routes) ───────────────────

app.post('/api/finance/import/preview', upload.single('statement'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file uploaded' });
  try {
    const parsed  = parseStatementFile(req.file.path);
    const deduped = deduplicateTransactions(parsed);
    res.json({ transactions: deduped, totalParsed: parsed.length, duplicatesSkipped: parsed.length - deduped.length });
  } catch (err) {
    console.error('[import] parse failed:', err.message);
    try { require('fs').unlinkSync(req.file.path); } catch {}
    res.status(422).json({ error: err.message });
  }
});

app.post('/api/finance/import/commit', (req, res) => {
  const { transactions } = req.body;
  if (!Array.isArray(transactions) || transactions.length === 0)
    return res.status(400).json({ error: 'no transactions to commit' });
  const valid = transactions.filter(t => t.importedDate && typeof t.amount === 'number' && t.amount > 0 && t.type);
  if (valid.length === 0) return res.status(400).json({ error: 'no valid transactions' });
  try {
    commitTransactions(valid);
    res.json({ committed: valid.length });
  } catch (err) {
    console.error('[import] commit failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Finance: :id routes ──────────────────────────────────────────────────────

app.patch('/api/finance/:id/category', (req, res) => {
  const { category } = req.body;
  if (!category) return res.status(400).json({ error: 'category required' });
  const entry = db.prepare(`SELECT * FROM finance_entries WHERE id = ?`).get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'not found' });
  db.prepare(`UPDATE finance_entries SET category = ? WHERE id = ?`).run(category, req.params.id);
  if (entry.merchant) learnMerchantCategory(entry.merchant, category);
  res.json({ ok: true, learned: !!entry.merchant });
});

app.delete('/api/finance/:id', (req, res) => {
  db.prepare(`DELETE FROM finance_entries WHERE id = ?`).run(req.params.id);
  res.status(204).end();
});

// ─── Status ───────────────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  const chatIdRow = db.prepare(`SELECT value FROM settings WHERE key = 'chat_id'`).get();
  res.json({ telegramLinked: !!chatIdRow });
});

// ─── Context (for chat empty state) ───────────────────────────────────────────

app.get('/api/context', (req, res) => {
  const openCount = db.prepare(`SELECT COUNT(*) as n FROM tasks WHERE status = 'open'`).get().n;
  const highCount = db.prepare(`SELECT COUNT(*) as n FROM tasks WHERE status = 'open' AND priority = 'high'`).get().n;

  const month = new Date().toISOString().slice(0, 7);
  const finRows = db.prepare(
    `SELECT type, SUM(amount) as total FROM finance_entries WHERE created_at >= ? GROUP BY type`
  ).all(`${month}-01`);
  const income  = finRows.find(r => r.type === 'income')?.total  || 0;
  const expense = finRows.find(r => r.type === 'expense')?.total || 0;

  // most recent high priority task title, if any
  const urgent = db.prepare(
    `SELECT title FROM tasks WHERE status = 'open' AND priority = 'high' ORDER BY created_at DESC LIMIT 1`
  ).get();

  res.json({
    openCount,
    highCount,
    financeNet: income - expense,
    urgentTask: urgent ? urgent.title : null,
  });
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
