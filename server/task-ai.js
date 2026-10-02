// ─── Task steps (AI breakdown) + "schedule this task" ────────────────────────
// • Breakdown: Core splits a vague task into small, concrete steps (first one tiny,
//   so starting is easy). Runs on the same free provider chain as chat.
// • Schedule: finds the first free slot in the user's day (calendar events and other
//   scheduled tasks count as busy) and sets the task's start_at / due_at — the same
//   fields the app's alarms, focus timer and server nudges already use.
//
// Additive: own table (created lazily, portable SQL), own routes, every query scoped
// by user_id. Model output is untrusted and validated before saving.

const db = require('./db');
const cal = require('./calendar');

const MAX_STEPS_PER_TASK = 30;
const DEFAULT_TASK_MIN = 30;

// ─── Schema ──────────────────────────────────────────────────────────────────
let schemaPromise = null;
function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await db.ready;
      const pk = db.USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
      await db.exec(`CREATE TABLE IF NOT EXISTS task_steps (
        id ${pk},
        task_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        text TEXT NOT NULL,
        est_min INTEGER,
        done INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_task_steps_task ON task_steps (user_id, task_id, position)`);
    })().catch(err => { schemaPromise = null; throw err; });
  }
  return schemaPromise;
}

// ─── Pure helpers (unit tested) ──────────────────────────────────────────────
function clip(v, max) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function extractJson(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/^\s*```[a-z]*\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
  if (s === -1 || e <= s) return null;
  try { return JSON.parse(raw.slice(s, e + 1)); } catch { return null; }
}

function validateSteps(parsed, title) {
  const raw = Array.isArray(parsed?.steps) ? parsed.steps : Array.isArray(parsed) ? parsed : [];
  const seen = new Set();
  const out = [];
  for (const s of raw) {
    const text = clip(typeof s === 'string' ? s : s?.text, 120);
    if (text.length < 3) continue;
    const key = text.toLowerCase();
    if (seen.has(key) || key === String(title || '').toLowerCase()) continue;
    seen.add(key);
    const est = Number(s?.est_min);
    out.push({ text, est_min: Number.isFinite(est) && est >= 1 ? Math.min(Math.round(est), 180) : null });
    if (out.length >= 8) break;
  }
  return out;
}

function buildStepMessages(task) {
  const system = `You are the task coach inside Core PA, a personal assistant app. Break the user's task into small, concrete steps they can start right now.

Reply with ONE JSON object and nothing else:
{"steps":[{"text":string,"est_min":number}]}

Rules:
- 3 to 8 steps, in the order they should be done.
- The FIRST step must be tiny (5 minutes or less) and easy to start, like opening a document or gathering one thing.
- Each step starts with a verb, is specific, and is at most 90 characters. No fluff, no numbering, no repeating the task title.
- est_min is a realistic whole number of minutes (1-120).
- Match the user's language. Use their notes for context if given.`;
  const user = `Task: ${clip(task.title, 200)}${task.notes ? `\nNotes: ${clip(task.notes, 500)}` : ''}${task.priority === 'high' ? '\nPriority: high' : ''}`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

const ceil5 = ms => Math.ceil(ms / 300000) * 300000;

// Earliest gap ≥ duration inside [dayStart, dayEnd] on each date, skipping busy blocks
// (each followed by a short buffer). busy: [{startMs,endMs}].
function findSlot({ busy, nowMs, startDate, endDate, dayStart, dayEnd, tz, durationMin, bufferMin = 10, deadlineMs = Infinity }) {
  const dur = durationMin * 60000, buf = bufferMin * 60000;
  const blocks = busy.map(b => ({ s: b.startMs, e: b.endMs + buf })).sort((a, b) => a.s - b.s);
  for (let d = startDate; d <= endDate; d = cal.addDays(d, 1)) {
    let cursor = Math.max(cal.localToUtcMs(d, dayStart, tz), ceil5(nowMs));
    const end = Math.min(cal.localToUtcMs(d, dayEnd, tz), deadlineMs);
    for (const b of blocks) {
      if (b.e <= cursor) continue;
      if (b.s >= end) break;
      if (b.s - cursor >= dur) return { startMs: cursor, endMs: cursor + dur };
      cursor = ceil5(Math.max(cursor, b.e));
    }
    if (end - cursor >= dur) return { startMs: cursor, endMs: cursor + dur };
  }
  return null;
}

function parseScheduleRequest(body, nowMs) {
  const b = body && typeof body === 'object' ? body : {};
  const tz = b.timezone === undefined ? cal.DEFAULT_TZ : b.timezone;
  if (!cal.isValidTz(tz)) return { error: 'invalid timezone' };
  const today = cal.utcToLocal(nowMs, tz).date;
  const when = b.when === undefined ? 'today' : b.when;
  const ranges = { today: [today, today], tomorrow: [cal.addDays(today, 1), cal.addDays(today, 1)], week: [today, cal.addDays(today, 6)] };
  if (!ranges[when]) return { error: 'when must be today, tomorrow or week' };
  const dayStart = b.day_start === undefined ? '08:00' : b.day_start;
  const dayEnd = b.day_end === undefined ? '21:00' : b.day_end;
  if (!cal.isTimeStr(dayStart) || !cal.isTimeStr(dayEnd) || dayEnd <= dayStart) return { error: 'invalid day window' };
  let durationMin = null;
  if (b.duration_min !== undefined) {
    durationMin = Number(b.duration_min);
    if (!Number.isFinite(durationMin) || durationMin < 5 || durationMin > 480) return { error: 'duration must be 5–480 minutes' };
    durationMin = Math.round(durationMin / 5) * 5;
  }
  return { value: { tz, startDate: ranges[when][0], endDate: ranges[when][1], dayStart, dayEnd, durationMin } };
}

// ─── Routes ──────────────────────────────────────────────────────────────────
function registerTaskAiRoutes(app) {
  const { requireUser } = require('./auth');
  const { enforceQuota, rateLimit } = require('./plan');
  const gate = async (req, res, next) => { try { await ensureSchema(); next(); } catch (e) { next(e); } };
  const isId = v => /^\d+$/.test(String(v));
  const limitWrites = rateLimit({ windowMs: 60_000, max: 90 });

  const getTask = (id, userId) => db.prepare(`SELECT * FROM tasks WHERE id = ? AND user_id = ?`).get(Number(id), userId);
  const getSteps = (taskId, userId) => db.prepare(
    `SELECT id, position, text, est_min, done FROM task_steps WHERE task_id = ? AND user_id = ? ORDER BY position ASC, id ASC`
  ).all(Number(taskId), userId);
  const shape = rows => rows.map(r => ({ id: r.id, text: r.text, est_min: r.est_min, done: !!Number(r.done) }));

  app.get('/api/task-steps/summary', requireUser, gate, async (req, res) => {
    const rows = await db.prepare(
      `SELECT s.task_id, COUNT(*) AS total, SUM(s.done) AS done
         FROM task_steps s JOIN tasks t ON t.id = s.task_id AND t.user_id = s.user_id
        WHERE s.user_id = ? AND t.status = 'open' GROUP BY s.task_id`
    ).all(req.userId);
    res.json(rows.map(r => ({ task_id: Number(r.task_id), total: Number(r.total), done: Number(r.done || 0) })));
  });

  app.get('/api/tasks/:id/steps', requireUser, gate, async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ error: 'bad id' });
    if (!(await getTask(req.params.id, req.userId))) return res.status(404).json({ error: 'task not found' });
    res.json({ steps: shape(await getSteps(req.params.id, req.userId)) });
  });

  app.post('/api/tasks/:id/steps', requireUser, gate, limitWrites, async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ error: 'bad id' });
    if (!(await getTask(req.params.id, req.userId))) return res.status(404).json({ error: 'task not found' });
    const text = clip(req.body?.text, 200);
    if (text.length < 1) return res.status(400).json({ error: 'step text is required' });
    const existing = await getSteps(req.params.id, req.userId);
    if (existing.length >= MAX_STEPS_PER_TASK) return res.status(409).json({ error: `a task can have at most ${MAX_STEPS_PER_TASK} steps` });
    const pos = existing.length ? Math.max(...existing.map(s => Number(s.position))) + 1 : 0;
    await db.prepare(`INSERT INTO task_steps (task_id, user_id, position, text, est_min, done, created_at) VALUES (?, ?, ?, ?, NULL, 0, ?)`)
      .run(Number(req.params.id), req.userId, pos, text, new Date().toISOString());
    res.status(201).json({ steps: shape(await getSteps(req.params.id, req.userId)) });
  });

  app.patch('/api/tasks/:id/steps/:sid', requireUser, gate, limitWrites, async (req, res) => {
    if (!isId(req.params.id) || !isId(req.params.sid)) return res.status(400).json({ error: 'bad id' });
    const step = await db.prepare(`SELECT * FROM task_steps WHERE id = ? AND task_id = ? AND user_id = ?`).get(Number(req.params.sid), Number(req.params.id), req.userId);
    if (!step) return res.status(404).json({ error: 'step not found' });
    const done = req.body?.done === undefined ? Number(step.done) : (req.body.done ? 1 : 0);
    const text = req.body?.text === undefined ? step.text : clip(req.body.text, 200);
    if (!text) return res.status(400).json({ error: 'step text can\'t be empty' });
    await db.prepare(`UPDATE task_steps SET done = ?, text = ? WHERE id = ? AND user_id = ?`).run(done, text, step.id, req.userId);
    // Working on a step counts as touching the task (keeps it from going "stale").
    await db.prepare(`UPDATE tasks SET last_touched_at = ? WHERE id = ? AND user_id = ?`).run(new Date().toISOString(), Number(req.params.id), req.userId);
    const steps = shape(await getSteps(req.params.id, req.userId));
    res.json({ steps, all_done: steps.length > 0 && steps.every(s => s.done) });
  });

  app.delete('/api/tasks/:id/steps/:sid', requireUser, gate, limitWrites, async (req, res) => {
    if (!isId(req.params.id) || !isId(req.params.sid)) return res.status(400).json({ error: 'bad id' });
    const r = await db.prepare(`DELETE FROM task_steps WHERE id = ? AND task_id = ? AND user_id = ?`).run(Number(req.params.sid), Number(req.params.id), req.userId);
    if (!r.changes) return res.status(404).json({ error: 'step not found' });
    res.json({ steps: shape(await getSteps(req.params.id, req.userId)) });
  });

  // ── AI breakdown ──
  app.post('/api/tasks/:id/breakdown', requireUser, gate, rateLimit({ windowMs: 60_000, max: 8 }), enforceQuota('breakdown'), async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ error: 'bad id' });
    const task = await getTask(req.params.id, req.userId);
    if (!task) return res.status(404).json({ error: 'task not found' });
    if (task.status !== 'open') return res.status(409).json({ error: 'only open tasks can be broken down' });

    const existing = await getSteps(task.id, req.userId);
    if (existing.length && req.body?.replace !== true) {
      return res.status(409).json({ error: 'steps_exist', message: 'This task already has steps.', steps: shape(existing) });
    }

    const { getProviderPlan, fetchWithProviderFallback } = require('./ai-providers');
    const plan = getProviderPlan();
    if (!plan.length) return res.status(503).json({ error: 'The AI coach is unavailable right now.' });

    const messages = buildStepMessages(task);
    let steps = null, lastErr = null;
    for (const provider of plan) {
      try {
        const r = await fetchWithProviderFallback(provider, messages, 1500);
        const data = await r.json();
        const valid = validateSteps(extractJson(data.choices?.[0]?.message?.content), task.title);
        if (valid.length >= 2) { steps = valid; break; }
        lastErr = new Error(`${provider.name} returned too few steps`);
      } catch (e) { lastErr = e; }
      console.warn(`[task-ai] ${provider.name} failed:`, lastErr.message);
    }
    if (!steps) return res.status(502).json({ error: "I couldn't break that down this time. Try adding a bit more detail to the task." });

    // Only replace once we have a good result, so a failure never wipes the user's steps.
    if (existing.length) await db.prepare(`DELETE FROM task_steps WHERE task_id = ? AND user_id = ?`).run(task.id, req.userId);
    const now = new Date().toISOString();
    for (let i = 0; i < steps.length; i++) {
      await db.prepare(`INSERT INTO task_steps (task_id, user_id, position, text, est_min, done, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)`)
        .run(task.id, req.userId, i, steps[i].text, steps[i].est_min, now);
    }
    await db.prepare(`UPDATE tasks SET last_touched_at = ? WHERE id = ? AND user_id = ?`).run(now, task.id, req.userId);
    res.status(201).json({ steps: shape(await getSteps(task.id, req.userId)) });
  });

  // ── Schedule into the first free slot ──
  app.post('/api/tasks/:id/schedule', requireUser, gate, rateLimit({ windowMs: 60_000, max: 30 }), async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ error: 'bad id' });
    const task = await getTask(req.params.id, req.userId);
    if (!task) return res.status(404).json({ error: 'task not found' });
    if (task.status !== 'open') return res.status(409).json({ error: 'only open tasks can be scheduled' });

    const nowMs = Date.now();
    const parsed = parseScheduleRequest(req.body, nowMs);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const p = parsed.value;

    let durationMin = p.durationMin;
    if (!durationMin) {
      const steps = await getSteps(task.id, req.userId);
      const sum = steps.filter(s => !Number(s.done)).reduce((a, s) => a + (Number(s.est_min) || 0), 0);
      durationMin = sum > 0 ? Math.min(480, Math.max(15, Math.ceil(sum / 5) * 5)) : DEFAULT_TASK_MIN;
    }

    const rangeFrom = cal.localToUtcMs(p.startDate, '00:00', p.tz);
    const rangeTo = cal.localToUtcMs(cal.addDays(p.endDate, 1), '00:00', p.tz);
    const [events, otherTasks] = await Promise.all([
      cal.getEventsInRange(req.userId, new Date(rangeFrom).toISOString(), new Date(rangeTo).toISOString(), 500),
      db.prepare(`SELECT start_at, due_at FROM tasks WHERE user_id = ? AND status = 'open' AND id <> ? AND start_at IS NOT NULL AND due_at IS NOT NULL LIMIT 500`).all(req.userId, task.id),
    ]);
    const busy = events.map(e => ({ startMs: Date.parse(e.start_at), endMs: Date.parse(e.end_at) }));
    for (const t of otherTasks) {
      const s = Date.parse(t.start_at), e = Date.parse(t.due_at);
      if (Number.isFinite(s) && Number.isFinite(e) && e > s && s < rangeTo && e > rangeFrom) busy.push({ startMs: s, endMs: e });
    }

    // A due date with no start time is a real deadline: don't schedule past it.
    const dueMs = task.due_at ? Date.parse(task.due_at) : NaN;
    const deadlineMs = !task.start_at && Number.isFinite(dueMs) && dueMs > nowMs ? dueMs : Infinity;

    const slot = findSlot({ busy, nowMs, ...p, durationMin, deadlineMs });
    if (!slot) {
      return res.status(409).json({ error: deadlineMs !== Infinity
        ? "There's no free time before this task's deadline in that range. Try a different day or a shorter task."
        : "I couldn't find a free slot in that range. Try another day, or a shorter duration." });
    }

    const previous = { start_at: task.start_at || null, due_at: task.due_at || null };
    const startIso = new Date(slot.startMs).toISOString(), endIso = new Date(slot.endMs).toISOString();
    await db.prepare(`UPDATE tasks SET start_at = ?, due_at = ?, last_touched_at = ? WHERE id = ? AND user_id = ?`)
      .run(startIso, endIso, new Date().toISOString(), task.id, req.userId);
    res.json({ ok: true, start_at: startIso, end_at: endIso, duration_min: durationMin, previous });
  });
}

module.exports = { registerTaskAiRoutes, ensureSchema, validateSteps, extractJson, findSlot, parseScheduleRequest, buildStepMessages };