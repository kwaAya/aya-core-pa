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

app.delete('/api/finance/:id', (req, res) => {
  db.prepare(`DELETE FROM finance_entries WHERE id = ?`).run(req.params.id);
  res.status(204).end();
});

// ─── Status ───────────────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  const chatIdRow = db.prepare(`SELECT value FROM settings WHERE key = 'chat_id'`).get();
  res.json({ telegramLinked: !!chatIdRow });
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
