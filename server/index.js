require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const db = require('./db');
const { initBot } = require('./telegram');
const { startScheduler } = require('./scheduler');
const { registerChatRoutes } = require('./webchat');
const { attachUser, registerAuthRoutes, requireUser } = require('./auth');
const { enforceQuota, rateLimit } = require('./plan');
const { registerBillingRoutes } = require('./billing');

const app = express();
app.set('trust proxy', 1); // Railway sits behind a proxy — needed for correct req.ip

// Same-origin only. Cookie auth + open CORS is how people get their sessions stolen.
app.use(cors({ origin: process.env.APP_URL || false, credentials: true }));

// Baseline security headers (no new dependency).
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), camera=(), microphone=(self)',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  });
  next();
});

// PayFast ITN needs the raw body to verify the signature — must come before express.json.
app.use('/api/billing/payfast/itn', express.raw({ type: '*/*', limit: '1mb' }));

app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use(attachUser);

// Brute-force protection on the auth surface.
app.use('/api/auth/login',  rateLimit({ windowMs: 15 * 60_000, max: 10, key: r => r.ip }));
app.use('/api/auth/signup', rateLimit({ windowMs: 60 * 60_000, max: 5,  key: r => r.ip }));

registerAuthRoutes(app);
registerBillingRoutes(app);

// Old shared-token gate removed — superseded by real per-user auth (see auth.js).

app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── Tasks ───────────────────────────────────────────────────────────────────

app.get('/api/tasks', requireUser, async (req, res) => {
  try {
    const tasks = await db.prepare(
      `SELECT * FROM tasks WHERE user_id = ? ORDER BY
        CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 ELSE 1 END ASC,
        status DESC,
        created_at DESC`
    ).all(req.userId);
    res.json(tasks);
  } catch (err) {
    console.error('[tasks GET] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tasks', requireUser, async (req, res) => {
  const { title, notes, remind_at, stale_days, stale_minutes, priority, recurring, start_at, due_at } = req.body;
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
      `INSERT INTO tasks (title, notes, remind_at, stale_minutes, priority, recurring, start_at, due_at, last_touched_at, created_at, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      title.trim(),
      notes || null,
      remind_at || null,
      staleMins,
      priority || 'normal',
      recurring || null,
      start_at || null,
      due_at || null,
      now,
      now,
      req.userId
    );

    const task = await db.prepare(`SELECT * FROM tasks WHERE id = ? AND user_id = ?`).get(result.lastInsertRowid, req.userId);
    res.status(201).json(task);
  } catch (err) {
    console.error('[tasks POST] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/tasks/:id', requireUser, async (req, res) => {
  const { id } = req.params;
  const { title, notes, status, remind_at, stale_days, stale_minutes, priority, recurring, touch, start_at, due_at } = req.body;

  try {
    const existing = await db.prepare(`SELECT * FROM tasks WHERE id = ? AND user_id = ?`).get(id, req.userId);
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
      start_at:        start_at  !== undefined ? start_at  : existing.start_at,
      due_at:          due_at    !== undefined ? due_at    : existing.due_at,
      stale_minutes:   newStaleMins,
      priority:        priority  !== undefined ? priority  : existing.priority,
      recurring:       recurring !== undefined ? recurring : existing.recurring,
      last_touched_at: touch ? new Date().toISOString() : existing.last_touched_at,
      reminded:        remindChanged ? 0 : existing.reminded,
      ping_count:      resetPing ? 0 : existing.ping_count,
      next_ping_at:    resetPing ? null : existing.next_ping_at,
    };

    await db.prepare(
      `UPDATE tasks SET title=?, notes=?, status=?, remind_at=?, start_at=?, due_at=?, stale_minutes=?, priority=?, recurring=?, last_touched_at=?, reminded=?, ping_count=?, next_ping_at=? WHERE id=? AND user_id=?`
    ).run(
      updated.title, updated.notes, updated.status, updated.remind_at, updated.start_at, updated.due_at,
      updated.stale_minutes, updated.priority, updated.recurring,
      updated.last_touched_at, updated.reminded, updated.ping_count, updated.next_ping_at, id, req.userId
    );

    const task = await db.prepare(`SELECT * FROM tasks WHERE id = ? AND user_id = ?`).get(id, req.userId);
    res.json(task);
  } catch (err) {
    console.error('[tasks PATCH] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/tasks/:id', requireUser, async (req, res) => {
  try {
    await db.prepare(`DELETE FROM tasks WHERE id = ? AND user_id = ?`).run(req.params.id, req.userId);
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

app.get('/api/finance', requireUser, async (req, res) => {
  try {
    const entries = await db.prepare(
      `SELECT * FROM finance_entries WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`
    ).all(req.userId);

    const totals = await db.prepare(
      `SELECT type, SUM(amount) as total FROM finance_entries WHERE user_id = ? GROUP BY type`
    ).all(req.userId);

    const monthStart = new Date().toISOString().slice(0, 7) + '-01';
    const byCategory = await db.prepare(
      `SELECT category, type, SUM(amount) as total
       FROM finance_entries
       WHERE created_at >= ? AND user_id = ?
       GROUP BY category, type
       ORDER BY total DESC`
    ).all(monthStart, req.userId);

    // weekly net trend, last 8 weeks (Sunday-start buckets, computed in JS for SQLite/Postgres parity)
    const trendCutoff = new Date();
    trendCutoff.setDate(trendCutoff.getDate() - 56);
    const trendRows = await db.prepare(
      `SELECT type, amount, created_at FROM finance_entries WHERE created_at >= ? AND user_id = ?`
    ).all(trendCutoff.toISOString(), req.userId);
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

app.post('/api/finance', requireUser, async (req, res) => {
  const { type, amount, category, note } = req.body;
  if (!amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: 'valid amount is required' });
  }
  const now = new Date().toISOString();
  try {
    const result = await db.prepare(
      `INSERT INTO finance_entries (type, amount, category, note, created_at, user_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      type || 'expense',
      parseFloat(amount),
      category || 'general',
      note || null,
      now,
      req.userId
    );

    const entry = await db.prepare(`SELECT * FROM finance_entries WHERE id = ? AND user_id = ?`).get(result.lastInsertRowid, req.userId);
    res.status(201).json(entry);
  } catch (err) {
    console.error('[finance POST] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Finance: bank settings (must be before :id routes) ──────────────────────

app.get('/api/finance/settings', requireUser, async (req, res) => {
  try {
    const prefix = `u${req.userId}_`;
    const rows = await db.prepare(`SELECT key, value FROM bank_settings WHERE key LIKE ?`).all(`${prefix}%`);
    const settings = Object.fromEntries(rows.map(r => [r.key.slice(prefix.length), r.value]));
    res.json(settings);
  } catch (err) {
    console.error('[finance settings GET] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/finance/settings', requireUser, async (req, res) => {
  const allowed = ['bank', 'last_four', 'last_imported'];
  const upsert  = db.prepare(`INSERT INTO bank_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  try {
    for (const key of allowed) {
      if (req.body[key] !== undefined) await upsert.run(`u${req.userId}_${key}`, req.body[key]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[finance settings POST] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Finance: statement import (must be before :id routes) ───────────────────

app.post('/api/finance/import/preview', requireUser, upload.single('statement'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file uploaded' });
  try {
    const parsed  = await parseStatementFile(req.file.path);
    const deduped = await deduplicateTransactions(parsed, req.userId);
    res.json({ transactions: deduped, totalParsed: parsed.length, duplicatesSkipped: parsed.length - deduped.length });
  } catch (err) {
    console.error('[import] parse failed:', err.message);
    try { require('fs').unlinkSync(req.file.path); } catch {}
    res.status(422).json({ error: err.message });
  }
});

app.post('/api/finance/import/commit', requireUser, enforceQuota('statement_import'), async (req, res) => {
  const { transactions } = req.body;
  if (!Array.isArray(transactions) || transactions.length === 0)
    return res.status(400).json({ error: 'no transactions to commit' });

  // coerce amount to number — frontend JSON round-trip can turn floats into strings
  const valid = transactions
    .map(t => ({ ...t, amount: parseFloat(t.amount) }))
    .filter(t => t.importedDate && !isNaN(t.amount) && t.amount > 0 && t.type);

  if (valid.length === 0) {
    sendMessage('✅ statement received — all transactions were already recorded, nothing new to import.', req.userId).catch(() => {});
    return res.status(400).json({ error: 'no valid transactions after validation' });
  }

  try {
    await commitTransactions(valid, req.userId);

    // Fire post-import pattern surfacing asynchronously — do not block the response
    surfaceImportPatterns(valid, req.userId).catch(err =>
      console.error('[import] pattern surfacing failed:', err.message)
    );

    res.json({ committed: valid.length });
  } catch (err) {
    console.error('[import] commit failed:', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ─── Finance: :id routes ──────────────────────────────────────────────────────

app.patch('/api/finance/:id/category', requireUser, async (req, res) => {
  const { category } = req.body;
  if (!category) return res.status(400).json({ error: 'category required' });
  try {
    const entry = await db.prepare(`SELECT * FROM finance_entries WHERE id = ? AND user_id = ?`).get(req.params.id, req.userId);
    if (!entry) return res.status(404).json({ error: 'not found' });
    await db.prepare(`UPDATE finance_entries SET category = ? WHERE id = ? AND user_id = ?`).run(category, req.params.id, req.userId);
    if (entry.merchant) await learnMerchantCategory(entry.merchant, category, req.userId);
    res.json({ ok: true, learned: !!entry.merchant });
  } catch (err) {
    console.error('[finance category PATCH] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/finance/:id', requireUser, async (req, res) => {
  try {
    await db.prepare(`DELETE FROM finance_entries WHERE id = ? AND user_id = ?`).run(req.params.id, req.userId);
    res.status(204).end();
  } catch (err) {
    console.error('[finance DELETE] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Voice transcription (Whisper via Groq) ───────────────────────────────────

app.post('/api/transcribe', requireUser, enforceQuota('transcribe'), upload.single('audio'), async (req, res) => {
  if (!process.env.GROQ_API_KEY) {
    return res.status(503).json({ error: 'GROQ_API_KEY not set' });
  }
  if (!req.file) return res.status(400).json({ error: 'no audio uploaded' });

  const fs = require('fs');
  try {
    const buffer = fs.readFileSync(req.file.path);
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: req.file.mimetype || 'audio/webm' }), req.file.originalname || 'audio.webm');
    form.append('model', 'whisper-large-v3-turbo');
    form.append('language', 'en');

    const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: form,
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      console.error('[transcribe] Groq error:', groqRes.status, errText);
      return res.status(502).json({ error: 'transcription failed' });
    }

    const data = await groqRes.json();
    res.json({ text: (data.text || '').trim() });
  } catch (err) {
    console.error('[transcribe] error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    fs.unlink(req.file.path, () => {}); // best-effort cleanup, mirrors finance import behaviour
  }
});

// ─── Status ───────────────────────────────────────────────────────────────────

app.get('/api/status', requireUser, async (req, res) => {
  try {
    const u = await db.prepare(`SELECT telegram_chat_id FROM users WHERE id = ?`).get(req.userId);
    res.json({ telegramLinked: !!u?.telegram_chat_id });
  } catch (err) {
    console.error('[status GET] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Context (for chat empty state) ───────────────────────────────────────────

app.get('/api/context', requireUser, async (req, res) => {
  try {
    const openRow  = await db.prepare(`SELECT COUNT(*) as n FROM tasks WHERE status = 'open' AND user_id = ?`).get(req.userId);
    const highRow  = await db.prepare(`SELECT COUNT(*) as n FROM tasks WHERE status = 'open' AND priority = 'high' AND user_id = ?`).get(req.userId);
    const openCount = openRow.n;
    const highCount = highRow.n;

    const month = new Date().toISOString().slice(0, 7);
    const finRows = await db.prepare(
      `SELECT type, SUM(amount) as total FROM finance_entries WHERE created_at >= ? AND user_id = ? GROUP BY type`
    ).all(`${month}-01`, req.userId);
    const income  = finRows.find(r => r.type === 'income')?.total  || 0;
    const expense = finRows.find(r => r.type === 'expense')?.total || 0;

    // most recent high priority task title, if any
    const urgent = await db.prepare(
      `SELECT title FROM tasks WHERE status = 'open' AND priority = 'high' AND user_id = ? ORDER BY created_at DESC LIMIT 1`
    ).get(req.userId);

    // completion history — computed in JS so it works identically on SQLite + Postgres
    const doneRows = await db.prepare(
      `SELECT last_touched_at FROM tasks WHERE status = 'done' AND user_id = ? ORDER BY last_touched_at DESC LIMIT 300`
    ).all(req.userId);
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

app.get('/api/heatmap', requireUser, async (req, res) => {
  try {
    const days = 84;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - (days - 1));
    cutoff.setHours(0, 0, 0, 0);
    const rows = await db.prepare(
      `SELECT last_touched_at FROM tasks WHERE status = 'done' AND last_touched_at >= ? AND user_id = ?`
    ).all(cutoff.toISOString(), req.userId);
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

app.get('/api/profile', requireUser, async (req, res) => {
  try {
    const row = await db.prepare(`SELECT profile_text FROM users WHERE id = ?`).get(req.userId);
    res.json({ content: row?.profile_text || '' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/profile', requireUser, async (req, res) => {
  const { content } = req.body;
  if (typeof content !== 'string') return res.status(400).json({ error: 'content required' });
  try {
    await db.prepare(`UPDATE users SET profile_text = ? WHERE id = ?`).run(content, req.userId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Telegram account linking (per user) ──────────────────────────────────────

app.post('/api/telegram/link-code', requireUser, async (req, res) => {
  try {
    const code = require('crypto').randomBytes(8).toString('hex');
    await db.prepare(`UPDATE users SET telegram_link_code = ? WHERE id = ?`).run(code, req.userId);
    const botName = process.env.TELEGRAM_BOT_USERNAME || 'your_bot';
    res.json({ code, url: `https://t.me/${botName}?start=${code}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/telegram/status', requireUser, async (req, res) => {
  const u = await db.prepare(`SELECT telegram_chat_id FROM users WHERE id = ?`).get(req.userId);
  res.json({ linked: !!u?.telegram_chat_id });
});

app.post('/api/telegram/unlink', requireUser, async (req, res) => {
  await db.prepare(`UPDATE users SET telegram_chat_id = NULL WHERE id = ?`).run(req.userId);
  res.json({ ok: true });
});

// ─── POPIA: right of access (s23) — full data export ─────────────────────────

app.get('/api/account/export', requireUser, async (req, res) => {
  try {
    const [user, tasks, finance, chat, usage] = await Promise.all([
      db.prepare(`SELECT id, email, name, created_at, profile_text, plan FROM users WHERE id = ?`).get(req.userId),
      db.prepare(`SELECT * FROM tasks WHERE user_id = ?`).all(req.userId),
      db.prepare(`SELECT * FROM finance_entries WHERE user_id = ?`).all(req.userId),
      db.prepare(`SELECT role, content, created_at FROM chat_history WHERE chat_id = ?`).all(`web-${req.userId}`),
      db.prepare(`SELECT kind, created_at FROM usage_events WHERE user_id = ?`).all(req.userId),
    ]);
    res.set('Content-Disposition', `attachment; filename="aya-core-pa-export-${req.userId}.json"`);
    res.json({ exportedAt: new Date().toISOString(), user, tasks, finance, chat, usage });
  } catch (err) {
    console.error('[export] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POPIA: right to deletion (s24) — hard delete, requires password ─────────

app.delete('/api/account', requireUser, async (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'password required to confirm deletion' });
  try {
    const { verifyPassword } = require('./auth');
    const user = await db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.userId);
    if (!user || !verifyPassword(password, user.password_hash, user.password_salt)) {
      return res.status(401).json({ error: 'password incorrect' });
    }
    await db.prepare(`DELETE FROM tasks WHERE user_id = ?`).run(req.userId);
    await db.prepare(`DELETE FROM finance_entries WHERE user_id = ?`).run(req.userId);
    await db.prepare(`DELETE FROM merchant_category_map WHERE user_id = ?`).run(req.userId);
    await db.prepare(`DELETE FROM engagement_events WHERE user_id = ?`).run(req.userId);
    await db.prepare(`DELETE FROM usage_events WHERE user_id = ?`).run(req.userId);
    await db.prepare(`DELETE FROM chat_history WHERE chat_id = ?`).run(`web-${req.userId}`);
    await db.prepare(`DELETE FROM bank_settings WHERE key LIKE ?`).run(`u${req.userId}_%`);
    await db.prepare(`DELETE FROM users WHERE id = ?`).run(req.userId);
    res.clearCookie('pa_session');
    res.json({ ok: true, deleted: true });
  } catch (err) {
    console.error('[account delete] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Chat (Claude reasoning) ──────────────────────────────────────────────────

registerChatRoutes(app);

// ─── Boot ─────────────────────────────────────────────────────────────────────

const { setupWebhook } = require('./telegram');

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`[server] running on port ${PORT}`);
  initBot();
  await setupWebhook(app);
  startScheduler();
});
