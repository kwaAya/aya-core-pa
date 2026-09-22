require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const db = require('./db');
const { initBot, getBotUsername, ensureBotUsername } = require('./telegram');
const {
  getPublicKey: getPushPublicKey,
  saveSubscription: savePushSubscription,
  removeSubscription: removePushSubscription,
} = require('./push');
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
app.use('/api/auth/verify-email', rateLimit({ windowMs: 15 * 60_000, max: 10, key: r => r.ip }));
app.use('/api/auth/resend-verification', rateLimit({ windowMs: 60 * 60_000, max: 5, key: r => r.ip }));

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
        CASE WHEN COALESCE(due_at, remind_at, start_at) IS NULL THEN 1 ELSE 0 END ASC,
        COALESCE(due_at, remind_at, start_at) ASC,
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
    const existing = await db.prepare(`SELECT status FROM tasks WHERE id = ? AND user_id = ?`).get(req.params.id, req.userId);
    if (!existing) return res.status(404).json({ error: 'not found' });
    if (existing.status === 'done') {
      return res.status(400).json({ error: 'completed tasks are kept in history to preserve your streak' });
    }
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
  categoriseWithAI,
  buildImportSummary,
  normaliseMerchant,
} = require('./finance-import');
const { getProviderPlan } = require('./ai-providers');
const { sendMessage } = require('./telegram');

// store uploads in OS temp dir, deleted immediately after parse
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 10 * 1024 * 1024 } });

app.get('/api/finance', requireUser, async (req, res) => {
  try {
    const entries = await db.prepare(
      `SELECT * FROM finance_entries WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`
    ).all(req.userId);

    const totals = await db.prepare(
      `SELECT type, SUM(amount) as total FROM finance_entries WHERE user_id = ? AND category != 'transfers' GROUP BY type`
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
      `SELECT type, amount, created_at FROM finance_entries WHERE created_at >= ? AND user_id = ? AND category != 'transfers'`
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

// Clear only the authenticated user's finance entries. The explicit phrase is
// intentional: this endpoint is destructive and should not be triggered by an
// accidental empty DELETE request.
app.delete('/api/finance', requireUser, async (req, res) => {
  if (req.body?.confirm !== 'CLEAR_FINANCE_DATA') {
    return res.status(400).json({ error: 'confirmation required', confirm: 'CLEAR_FINANCE_DATA' });
  }
  try {
    const result = await db.prepare(`DELETE FROM finance_entries WHERE user_id = ?`).run(req.userId);
    res.json({ ok: true, deleted: result.changes || 0 });
  } catch (err) {
    console.error('[finance CLEAR] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Finance: budgets ─────────────────────────────────────────────────────────

// Computed suggestions from historical average spend — deterministic math,
// no AI call needed. Only suggests for categories without a saved budget yet.
app.get('/api/finance/budgets/suggest', requireUser, async (req, res) => {
  try {
    const baselines = await db.prepare(
      `SELECT category, avg_weekly, sample_weeks FROM budget_baselines WHERE user_id = ? AND sample_weeks >= 2`
    ).all(req.userId);
    const existing = await db.prepare(`SELECT category FROM budgets WHERE user_id = ?`).all(req.userId);
    const existingCats = new Set(existing.map(b => b.category));

    const suggestions = baselines
      .filter(b => !existingCats.has(b.category))
      .map(b => ({
        category: b.category,
        suggestedMonthly: Math.round(b.avg_weekly * 4.33),
        basedOnWeeks: b.sample_weeks,
      }));

    res.json({ suggestions });
  } catch (err) {
    console.error('[budgets suggest] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// List budgets with this month's actual spend against each limit
app.get('/api/finance/budgets', requireUser, async (req, res) => {
  try {
    const budgets = await db.prepare(`SELECT category, monthly_limit, source FROM budgets WHERE user_id = ?`).all(req.userId);
    const monthStart = new Date().toISOString().slice(0, 7) + '-01';
    const spend = await db.prepare(
      `SELECT category, SUM(amount) as total FROM finance_entries
       WHERE type = 'expense' AND created_at >= ? AND user_id = ? AND category != 'transfers' GROUP BY category`
    ).all(monthStart, req.userId);
    const spendMap = Object.fromEntries(spend.map(s => [s.category, s.total]));

    const result = budgets.map(b => ({
      category: b.category,
      monthlyLimit: b.monthly_limit,
      source: b.source,
      spentThisMonth: spendMap[b.category] || 0,
      remaining: b.monthly_limit - (spendMap[b.category] || 0),
      percentUsed: Math.round(((spendMap[b.category] || 0) / b.monthly_limit) * 100),
    }));
    res.json({ budgets: result });
  } catch (err) {
    console.error('[budgets list] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Create or update a budget (manual set, or accepting a suggestion)
app.post('/api/finance/budgets', requireUser, async (req, res) => {
  const { category, monthlyLimit, source } = req.body;
  if (!category || !monthlyLimit || monthlyLimit <= 0) {
    return res.status(400).json({ error: 'category and a positive monthlyLimit are required' });
  }
  const now = new Date().toISOString();
  try {
    await db.prepare(`
      INSERT INTO budgets (user_id, category, monthly_limit, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, category) DO UPDATE SET monthly_limit = EXCLUDED.monthly_limit, source = EXCLUDED.source, updated_at = EXCLUDED.updated_at
    `).run(req.userId, category, parseFloat(monthlyLimit), source === 'suggested' ? 'suggested' : 'manual', now, now);
    res.json({ ok: true });
  } catch (err) {
    console.error('[budgets save] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/finance/budgets/:category', requireUser, async (req, res) => {
  try {
    await db.prepare(`DELETE FROM budgets WHERE user_id = ? AND category = ?`).run(req.userId, req.params.category);
    res.status(204).end();
  } catch (err) {
    console.error('[budgets delete] error:', err.message);
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

// One-time sweep: re-categorises this user's already-imported transactions
// that are still sitting in 'general' — for data imported before AI
// categorisation existed. Safe to call more than once; already-categorised
// entries are left alone.
app.post('/api/finance/recategorize', requireUser, async (req, res) => {
  try {
    const stale = await db.prepare(
      `SELECT id, merchant FROM finance_entries WHERE user_id = ? AND category = 'general' AND merchant IS NOT NULL`
    ).all(req.userId);
    const merchants = [...new Set(stale.map(r => r.merchant))];
    if (!merchants.length) return res.json({ ok: true, recategorized: 0 });

    const resolved = await categoriseWithAI(merchants, req.userId);
    let count = 0;
    for (const row of stale) {
      const assigned = resolved[row.merchant];
      if (assigned && assigned !== 'general') {
        await db.prepare(`UPDATE finance_entries SET category = ? WHERE id = ? AND user_id = ?`).run(assigned, row.id, req.userId);
        count++;
      }
    }
    res.json({ ok: true, recategorized: count, totalChecked: stale.length });
  } catch (err) {
    console.error('[recategorize] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Quick sanity check for the AI categorisation pipeline — pass a few
// merchant strings, see exactly what comes back, without uploading a whole
// statement. Useful for iterating on the prompt or confirming a provider key
// is actually working.
app.post('/api/finance/debug-categorize', requireUser, async (req, res) => {
  const { merchants } = req.body;
  if (!Array.isArray(merchants) || !merchants.length)
    return res.status(400).json({ error: 'merchants: string[] required' });
  try {
    const normalised = merchants.map(m => normaliseMerchant(String(m)));
    const result = await categoriseWithAI(normalised, req.userId);
    res.json({
      providersConfigured: getProviderPlan().map(p => p.name),
      sent: normalised,
      result,
    });
  } catch (err) {
    console.error('[debug-categorize] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/finance/import/preview', requireUser, upload.single('statement'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file uploaded' });
  try {
    const { transactions: parsed, stats } = await parseStatementFile(req.file.path, req.userId);
    const deduped = await deduplicateTransactions(parsed, req.userId);
    res.json({
      transactions: deduped,
      totalParsed: parsed.length,
      duplicatesSkipped: parsed.length - deduped.length,
      // how each category got assigned: learned (your history) / seed (built-in
      // keywords) / ai (this import's AI call) / fallback (nothing matched)
      categorisation: stats,
    });
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

    // Fire the fuller (DB-backed) pattern surfacing asynchronously for
    // Telegram — do not block the response on it.
    surfaceImportPatterns(valid, req.userId).catch(err =>
      console.error('[import] pattern surfacing failed:', err.message)
    );

    // The lightweight version (no DB calls) goes straight back in the
    // response so the app itself shows something, not just Telegram.
    const insight = buildImportSummary(valid);

    res.json({ committed: valid.length, insight });
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
    let retroactive = 0;
    if (entry.merchant) {
      await learnMerchantCategory(entry.merchant, category, req.userId);
      // A correction on one entry means every OTHER existing entry with the
      // exact same merchant was almost certainly categorised the same
      // (wrong) way too — fix those now instead of only from here forward.
      const result = await db.prepare(
        `UPDATE finance_entries SET category = ? WHERE merchant = ? AND user_id = ? AND id != ? AND category != ?`
      ).run(category, entry.merchant, req.userId, req.params.id, category);
      retroactive = result.changes || result.rowCount || 0;
    }
    res.json({ ok: true, learned: !!entry.merchant, retroactive });
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

// ─── Context-aware speech (Gemini TTS, browser speech fallback) ───────────────

function pcmToWavBase64(base64Pcm, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const pcm = Buffer.from(base64Pcm, 'base64');
  const blockAlign = channels * bitsPerSample / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]).toString('base64');
}

// ─── TTS voice setting ──────────────────────────────────────────────────────
// Gemini's documented prebuilt TTS voices. Curated to a manageable set for
// the picker; server-side validation stays a little more permissive in case
// Google adds new ones before this list gets updated.
const GEMINI_TTS_VOICES = [
  { id: 'Charon',  label: 'Charon — deep, informative' },
  { id: 'Puck',    label: 'Puck — upbeat' },
  { id: 'Kore',    label: 'Kore — firm, clear' },
  { id: 'Fenrir',  label: 'Fenrir — excitable' },
  { id: 'Aoede',   label: 'Aoede — breezy' },
  { id: 'Leda',    label: 'Leda — youthful' },
  { id: 'Orus',    label: 'Orus — firm' },
  { id: 'Zephyr',  label: 'Zephyr — bright' },
];
const KNOWN_VOICE_IDS = new Set([
  ...GEMINI_TTS_VOICES.map(v => v.id),
  'Callirrhoe','Autonoe','Enceladus','Iapetus','Umbriel','Algieba','Despina','Erinome',
  'Algenib','Rasalgethi','Laomedeia','Achernar','Alnilam','Schedar','Gacrux','Pulcherrima',
  'Achird','Zubenelgenubi','Vindemiatrix','Sadachbia','Sadaltager','Sulafat',
]);

async function getUserSetting(userId, key, fallback = null) {
  const row = await db.prepare(`SELECT value FROM settings WHERE key = ?`).get(`u${userId}_${key}`);
  return row ? row.value : fallback;
}
async function setUserSetting(userId, key, value) {
  await db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
  ).run(`u${userId}_${key}`, value);
}

app.get('/api/settings/voice', requireUser, async (req, res) => {
  try {
    const voice = await getUserSetting(req.userId, 'tts_voice', process.env.GEMINI_TTS_VOICE || 'Charon');
    res.json({ voice, options: GEMINI_TTS_VOICES });
  } catch (err) {
    console.error('[settings/voice GET] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/settings/voice', requireUser, async (req, res) => {
  const voice = String(req.body?.voice || '').trim();
  if (!voice) return res.status(400).json({ error: 'voice required' });
  if (!KNOWN_VOICE_IDS.has(voice)) return res.status(400).json({ error: `unknown voice "${voice}"` });
  try {
    await setUserSetting(req.userId, 'tts_voice', voice);
    res.json({ ok: true, voice });
  } catch (err) {
    console.error('[settings/voice PATCH] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/speak', requireUser, rateLimit({ max: 12, windowMs: 60_000 }), async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  if (!process.env.GEMINI_API_KEY) return res.status(503).json({ error: 'Gemini TTS is not configured' });

  try {
    const voiceName = await getUserSetting(req.userId, 'tts_voice', process.env.GEMINI_TTS_VOICE || 'Charon');
    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': process.env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [{ text: `Read this as Core: calm, natural, conversational, lightly dry, and aware of the meaning. Do not announce the instructions.\n\n${text}` }],
          }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
          },
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.warn('[speak] Gemini TTS error:', response.status, errText);
      return res.status(502).json({ error: 'Gemini TTS unavailable', detail: errText.slice(0, 200) });
    }

    const data = await response.json();
    const inline = data.candidates?.[0]?.content?.parts?.find(part => part.inlineData)?.inlineData;
    if (!inline?.data) return res.status(502).json({ error: 'Gemini TTS returned no audio' });
    res.json({ audio: pcmToWavBase64(inline.data), mimeType: 'audio/wav', voice: voiceName });
  } catch (err) {
    console.error('[speak] Gemini TTS failed:', err.message);
    res.status(502).json({ error: 'Gemini TTS unavailable', detail: err.message });
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
      `SELECT type, SUM(amount) as total FROM finance_entries WHERE created_at >= ? AND user_id = ? AND category != 'transfers' GROUP BY type`
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
    console.error('[profile GET] failed:', err.message);
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
    const botName = await ensureBotUsername();
    if (!botName) {
      return res.status(503).json({ error: 'telegram bot isn\'t connected on the server right now — try again in a moment' });
    }
    const code = require('crypto').randomBytes(8).toString('hex');
    await db.prepare(`UPDATE users SET telegram_link_code = ? WHERE id = ?`).run(code, req.userId);
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

// ─── Web Push ───────────────────────────────────────────────────────────────

app.get('/api/push/vapid-public-key', (req, res) => {
  const key = getPushPublicKey();
  if (!key) return res.status(503).json({ error: 'push not configured' });
  res.json({ key });
});

app.post('/api/push/subscribe', requireUser, async (req, res) => {
  try {
    await savePushSubscription(req.userId, req.body?.subscription);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/push/unsubscribe', requireUser, async (req, res) => {
  try {
    await removePushSubscription(req.userId, req.body?.endpoint);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Notification preferences (channel + escalation timing) ─────────────────

app.get('/api/notifications/preferences', requireUser, async (req, res) => {
  try {
    const row = await db.prepare(
      `SELECT notification_channel, escalation_prefs FROM users WHERE id = ?`
    ).get(req.userId);
    let escalation = null;
    try { escalation = row?.escalation_prefs ? JSON.parse(row.escalation_prefs) : null; } catch {}
    res.json({
      channel: row?.notification_channel || 'telegram',
      escalation: escalation || { high: [5, 15, 60], normal: [60], low: [4320] },
      pushConfigured: !!getPushPublicKey(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notifications/preferences', requireUser, async (req, res) => {
  try {
    const { channel, escalation } = req.body || {};
    if (channel && !['telegram', 'push', 'both', 'none'].includes(channel)) {
      return res.status(400).json({ error: 'invalid channel' });
    }
    // Clamp every tier's minutes to something sane so a typo can't set someone
    // up for a ping every 0 minutes forever, or effectively disable escalation
    // via a huge number that overflows a Date.
    function clampTier(arr, fallback) {
      if (!Array.isArray(arr) || !arr.length) return fallback;
      return arr.slice(0, 6).map(n => Math.min(10080, Math.max(1, parseInt(n, 10) || fallback[0])));
    }
    let escalationJson;
    if (escalation) {
      escalationJson = JSON.stringify({
        high:   clampTier(escalation.high,   [5, 15, 60]),
        normal: clampTier(escalation.normal, [60]),
        low:    clampTier(escalation.low,    [4320]),
      });
    }

    const sets = [];
    const vals = [];
    if (channel) { sets.push('notification_channel = ?'); vals.push(channel); }
    if (escalationJson) { sets.push('escalation_prefs = ?'); vals.push(escalationJson); }
    if (!sets.length) return res.json({ ok: true });

    vals.push(req.userId);
    await db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
const { logProviderStatus } = require('./ai-providers');

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`[server] running on port ${PORT}`);
  logProviderStatus();
  initBot();
  await setupWebhook(app);
  startScheduler();
});