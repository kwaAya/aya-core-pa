// ─── AI itinerary generator ──────────────────────────────────────────────────
// Turns "plan my week" + the user's open tasks, existing calendar and weather
// into a day-by-day plan. Runs on the same free provider chain as Core chat
// (Groq → Gemini → OpenRouter), so it adds no new cost or dependency.
//
// Safety model
//  • The model only ever produces a DRAFT. Nothing touches the calendar until
//    the user confirms.
//  • Model output is treated as untrusted: parsed defensively and validated in
//    code (dates, times, overlaps, day window, past times) before it is saved.
//  • Confirming is idempotent: events are tagged (itinerary_id, item_key), so a
//    repeat confirm never duplicates, and deleting an itinerary removes exactly
//    the events it created.

const crypto = require('crypto');
const db = require('./db');
const cal = require('./calendar');
const history = require('./history');

const MAX_RANGE_DAYS = 90;
const MAX_ITEMS = 200;
const MAX_PROMPT = 1000;

// ─── Output parsing & validation (pure — unit tested) ────────────────────────

function extractJson(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/^\s*```[a-z]*\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  if (s === -1 || e <= s) return null;
  try { return JSON.parse(raw.slice(s, e + 1)); } catch { return null; }
}

function clip(v, max) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function itemKey(date, start, title) {
  return crypto.createHash('sha1').update(`${date}|${start}|${title.toLowerCase()}`).digest('hex').slice(0, 12);
}

// ctx: { startDate, endDate, dayStart, dayEnd, tz, nowMs, taskIds:Set<number>, busy:[{startMs,endMs,title}] }
function validatePlan(parsed, ctx) {
  const warnings = [];
  const rawItems = Array.isArray(parsed?.items) ? parsed.items : [];
  const good = [];

  for (const it of rawItems.slice(0, MAX_ITEMS * 2)) {
    const title = clip(it?.title, 80);
    const date = typeof it?.date === 'string' ? it.date : '';
    const start = typeof it?.start === 'string' ? it.start : '';
    const end = typeof it?.end === 'string' ? it.end : '';
    if (!title || !cal.isDateStr(date) || !cal.isTimeStr(start) || !cal.isTimeStr(end)) continue;
    if (date < ctx.startDate || date > ctx.endDate) continue;
    if (end <= start) continue;
    if (start < ctx.dayStart || end > ctx.dayEnd) { warnings.push(`Dropped "${title}" (outside your day window)`); continue; }

    const startMs = cal.localToUtcMs(date, start, ctx.tz);
    const endMs = cal.localToUtcMs(date, end, ctx.tz);
    const mins = (endMs - startMs) / 60000;
    if (mins < 5 || mins > 720) continue;
    if (startMs < ctx.nowMs - 5 * 60000) continue; // already started/over — can't schedule the past

    const taskId = Number.isInteger(it.task_id) && ctx.taskIds.has(it.task_id) ? it.task_id : null;
    good.push({
      key: itemKey(date, start, title), date, start, end, title,
      notes: clip(it?.notes, 200), task_id: taskId,
      priority: ['high','normal','low'].includes(it?.priority) ? it.priority : 'normal',
      startMs, endMs,
    });
  }

  good.sort((a, b) => a.startMs - b.startMs);

  const items = [];
  let prevEnd = -Infinity;
  const seen = new Set();
  for (const g of good) {
    if (seen.has(g.key)) continue;
    if (g.startMs < prevEnd) { warnings.push(`Dropped "${g.title}" (overlapped another item)`); continue; }
    const clash = ctx.busy.find(b => g.startMs < b.endMs && g.endMs > b.startMs);
    const { startMs, endMs, ...item } = g;
    if (clash) item.conflict = clash.title;
    items.push(item);
    seen.add(g.key);
    prevEnd = g.endMs;
    if (items.length >= MAX_ITEMS) break;
  }

  return {
    title: clip(parsed?.title, 80) || 'Your plan',
    summary: clip(parsed?.summary, 300),
    items,
    warnings: warnings.slice(0, 10),
  };
}

// ─── Prompt ──────────────────────────────────────────────────────────────────

function buildMessages({ prompt, startDate, endDate, dayStart, dayEnd, tz, nowLocal, profile, tasks, busyLines, weatherLine, historyBlock = '', visContextBlock = '' }) {
  const msgs = [];

  if (visContextBlock) {
    msgs.push({ role: 'system', content: visContextBlock });
  }

  const system = `You are the planning engine inside Core PA, a personal assistant app. Build a realistic day-by-day schedule for the user.

Reply with ONE JSON object and nothing else (no markdown, no commentary):
{"title": string (max 60 chars), "summary": string (1-2 sentences), "items": [{"date":"YYYY-MM-DD","start":"HH:mm","end":"HH:mm","title":string,"notes":string,"task_id":number|null,"priority":"high"|"normal"|"low"}]}

Rules:
- Times are the user's local wall-clock time, 24-hour HH:mm. Timezone: ${tz}.
- Only use dates from ${startDate} to ${endDate} inclusive. Only schedule between ${dayStart} and ${dayEnd} each day.
- Never overlap another item or any busy time listed below. Leave 10-15 minute buffers and include meals/breaks when sensible.
- Current local time is ${nowLocal}; never schedule anything earlier than that.
- Schedule the user's open tasks where they fit (set task_id to the task's id); do NOT invent task ids. Put high-priority and due-soon tasks first.
- Set priority on every item: "high" for deadlines, exams, urgent work; "low" for rest, social, low-stakes blocks; "normal" for everything else.
- Respect the user's request and profile. Keep each day achievable: at most 10 items per day.
- When a history section is given, personalise with it: include the listed routine slots, schedule tasks marked as slipping (open 7+ days) early in the range, and put demanding work in the user's most productive window. Never invent routines that are not listed.
- Titles are short (max 60 chars). Notes are optional and max 160 chars.`;

  const user = [
    `Request: ${prompt}`,
    `Range: ${startDate} to ${endDate}`,
    profile ? `About the user: ${clip(profile, 600)}` : '',
    weatherLine,
    historyBlock,
    tasks.length ? `Open tasks:\n${tasks.join('\n')}` : 'Open tasks: none',
    busyLines.length ? `Already busy (do not overlap):\n${busyLines.join('\n')}` : 'Already busy: nothing',
  ].filter(Boolean).join('\n\n');

  msgs.push({ role: 'system', content: system }, { role: 'user', content: user });
  return msgs;
}

// ─── Input parsing ───────────────────────────────────────────────────────────

function parseRequest(body, nowMs) {
  const b = body && typeof body === 'object' ? body : {};
  const prompt = clip(b.prompt, MAX_PROMPT);
  if (prompt.length < 3) return { error: 'Tell me what you want to plan' };

  const tz = b.timezone === undefined ? cal.DEFAULT_TZ : b.timezone;
  if (!cal.isValidTz(tz)) return { error: 'invalid timezone' };

  const today = cal.utcToLocal(nowMs, tz).date;
  const startDate = b.start_date === undefined ? today : b.start_date;
  const endDate = b.end_date === undefined ? startDate : b.end_date;
  if (!cal.isDateStr(startDate) || !cal.isDateStr(endDate)) return { error: 'dates must be YYYY-MM-DD' };
  if (startDate < today) return { error: "start date can't be in the past" };
  if (endDate < startDate) return { error: 'end date is before start date' };
  if (cal.daysBetween(startDate, endDate) + 1 > MAX_RANGE_DAYS) return { error: `plans can cover at most ${MAX_RANGE_DAYS} days` };

  const dayStart = b.day_start === undefined ? '08:00' : b.day_start;
  const dayEnd = b.day_end === undefined ? '21:00' : b.day_end;
  if (!cal.isTimeStr(dayStart) || !cal.isTimeStr(dayEnd) || dayEnd <= dayStart) return { error: 'invalid day window' };

  return { value: { prompt, tz, startDate, endDate, dayStart, dayEnd } };
}

// ─── Model call ──────────────────────────────────────────────────────────────

async function generatePlan(messages, ctx) {
  const { getProviderPlan, fetchWithProviderFallback } = require('./ai-providers');
  const plan = getProviderPlan();
  if (!plan.length) { const e = new Error('no_provider'); e.code = 'no_provider'; throw e; }
  let lastErr = null;
  for (const provider of plan) {
    try {
      const res = await fetchWithProviderFallback(provider, messages, 8192);
      const data = await res.json();
      const parsed = extractJson(data.choices?.[0]?.message?.content);
      const result = parsed ? validatePlan(parsed, ctx) : null;
      if (result && result.items.length) return result;
      lastErr = new Error(`${provider.name} returned no usable plan`);
    } catch (err) {
      lastErr = err;
    }
    console.warn(`[itinerary] ${provider.name} failed:`, lastErr.message);
  }
  throw lastErr || new Error('generation failed');
}

// ─── Routes ──────────────────────────────────────────────────────────────────

function summarise(row) {
  let count = 0;
  try { count = JSON.parse(row.plan_json).items.length; } catch { /* ignore */ }
  return {
    id: row.id, title: row.title, status: row.status,
    range_start: row.range_start, range_end: row.range_end,
    created_at: row.created_at, item_count: count,
  };
}

function hydrate(row) {
  return { ...summarise(row), prompt: row.prompt, plan: JSON.parse(row.plan_json) };
}

function registerItineraryRoutes(app) {
  const { requireUser } = require('./auth');
  const { enforceQuota, rateLimit } = require('./plan');
  const gate = async (req, res, next) => { try { await cal.ensureCalendarSchema(); next(); } catch (e) { next(e); } };

  app.post('/api/itinerary/generate', requireUser, gate,
    rateLimit({ windowMs: 60_000, max: 6 }), enforceQuota('itinerary'),
    async (req, res) => {
      const nowMs = Date.now();
      const parsed = parseRequest(req.body, nowMs);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      const p = parsed.value;
      const uid = req.userId;

      // Housekeeping: stale drafts never pile up.
      db.prepare(`DELETE FROM itineraries WHERE user_id = ? AND status = 'draft' AND created_at < ?`)
        .run(uid, new Date(nowMs - 7 * 86400000).toISOString()).catch(() => {});

      // Context: open tasks, existing events in range, profile, weather (today only).
      const rangeFrom = cal.localToUtcMs(p.startDate, '00:00', p.tz);
      const rangeTo = cal.localToUtcMs(cal.addDays(p.endDate, 1), '00:00', p.tz);
      const [taskRows, events, profileRow] = await Promise.all([
        db.prepare(`SELECT id, title, priority, remind_at, start_at, due_at, created_at FROM tasks
                     WHERE user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 40`).all(uid),
        cal.getEventsInRange(uid, new Date(rangeFrom).toISOString(), new Date(rangeTo).toISOString(), 200),
        db.prepare(`SELECT profile_text FROM users WHERE id = ?`).get(uid).catch(() => null),
      ]);

      const fmtLocal = (iso) => { const l = cal.utcToLocal(Date.parse(iso), p.tz); return `${l.date} ${l.time}`; };
      const tasks = taskRows.map(t => {
        const when = t.due_at || t.start_at || t.remind_at;
        const ms = when ? Date.parse(when) : NaN;
        const age = Math.floor((nowMs - Date.parse(t.created_at || '')) / 86400000);
        return `- id ${t.id}: ${clip(t.title, 100)} [${t.priority}]${age >= 7 ? ` (open ${age}d)` : ''}${Number.isFinite(ms) ? ` (${t.due_at ? 'due' : 'at'} ${fmtLocal(new Date(ms).toISOString())})` : ''}`;
      });
      // Imported all-day items (birthdays, holidays) are informational, not busy time.
      const timed = events.filter(e => !(String(e.source || '').startsWith('import:') && Date.parse(e.end_at) - Date.parse(e.start_at) >= 20 * 3600000));
      const busy = timed.map(e => ({ startMs: Date.parse(e.start_at), endMs: Date.parse(e.end_at), title: e.title }));
      const busyLines = timed.map(e => `- ${fmtLocal(e.start_at)} to ${fmtLocal(e.end_at)}: ${clip(e.title, 80)}`);

      let weatherLine = '';
      if (p.startDate <= cal.utcToLocal(nowMs, p.tz).date) {
        try {
          const w = await require('./weather').getUserWeather(uid);
          if (w) weatherLine = `Weather today: ${w.condition}, ${w.temp}°C, ${w.rainChance}% rain chance${w.nextRainAt ? `, rain likely around ${w.nextRainAt}` : ''}.`;
        } catch { /* weather is optional */ }
      }

      const nowLocalParts = cal.utcToLocal(nowMs, p.tz);
      const hist = await history.buildHistoryContext(uid, p.tz, p.startDate, p.endDate, busy, taskRows, nowMs)
        .catch(err => { console.error('[itinerary] history failed:', err.message); return { block: '', basis: [] }; });

      let visContextBlock = '';
      if (p.prompt.startsWith('Vis:')) {
        try {
          const { getVisContext } = require('./vis');
          const vc = await getVisContext(uid);
          if (vc) {
            const parts = [
              vc.identity      ? `Identity: ${clip(vc.identity, 400)}`           : '',
              vc.projects      ? `Projects: ${clip(vc.projects, 400)}`           : '',
              vc.cognitive_style ? `Cognitive style: ${clip(vc.cognitive_style, 400)}` : '',
              vc.open_loops    ? `Open loops: ${clip(vc.open_loops, 300)}`       : '',
              vc.life_context  ? `Life context (private): ${clip(vc.life_context, 300)}` : '',
            ].filter(Boolean);
            if (parts.length) {
              visContextBlock = `You are Vis. This is Aya's life plan request. Her context:\n\n${parts.join('\n\n')}`;
            }
          }
        } catch (visErr) {
          console.error('[itinerary] vis context failed:', visErr.message);
        }
      }

      const messages = buildMessages({
        ...p,
        nowLocal: `${nowLocalParts.date} ${nowLocalParts.time}`,
        profile: profileRow?.profile_text && !/^\(no profile/.test(profileRow.profile_text) ? profileRow.profile_text : '',
        tasks, busyLines, weatherLine, historyBlock: hist.block, visContextBlock,
      });

      const ctx = {
        startDate: p.startDate, endDate: p.endDate, dayStart: p.dayStart, dayEnd: p.dayEnd, tz: p.tz, nowMs,
        taskIds: new Set(taskRows.map(t => Number(t.id))), busy,
      };

      let result;
      try {
        result = await generatePlan(messages, ctx);
      } catch (err) {
        console.error('[itinerary] generation failed:', err.message);
        if (err.code === 'no_provider') return res.status(503).json({ error: 'The AI planner is unavailable right now.' });
        return res.status(502).json({ error: "I couldn't build a usable plan this time. Try rephrasing or narrowing the range." });
      }

      const plan = { ...result, basis: hist.basis, tz: p.tz, day_start: p.dayStart, day_end: p.dayEnd };
      const now = new Date().toISOString();
      const ins = await db.prepare(
        `INSERT INTO itineraries (user_id, title, range_start, range_end, status, prompt, plan_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)`
      ).run(uid, plan.title, p.startDate, p.endDate, p.prompt, JSON.stringify(plan), now, now);
      const row = await db.prepare(`SELECT * FROM itineraries WHERE id = ? AND user_id = ?`).get(ins.lastInsertRowid, uid);
      res.status(201).json(hydrate(row));
    });

  app.get('/api/itinerary', requireUser, gate, async (req, res) => {
    const rows = await db.prepare(
      `SELECT * FROM itineraries WHERE user_id = ? ORDER BY id DESC LIMIT 12`
    ).all(req.userId);
    res.json(rows.map(summarise));
  });

  app.get('/api/itinerary/:id', requireUser, gate, async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'bad id' });
    const row = await db.prepare(`SELECT * FROM itineraries WHERE id = ? AND user_id = ?`).get(Number(req.params.id), req.userId);
    if (!row) return res.status(404).json({ error: 'plan not found' });
    res.json(hydrate(row));
  });

  // Write the plan into the calendar. Idempotent; `exclude` lets the user drop items first.
  app.post('/api/itinerary/:id/confirm', requireUser, gate, rateLimit({ windowMs: 60_000, max: 20 }), async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'bad id' });
    const row = await db.prepare(`SELECT * FROM itineraries WHERE id = ? AND user_id = ?`).get(Number(req.params.id), req.userId);
    if (!row) return res.status(404).json({ error: 'plan not found' });

    const plan = JSON.parse(row.plan_json);
    const exclude = new Set(Array.isArray(req.body?.exclude) ? req.body.exclude.filter(k => typeof k === 'string').slice(0, 200) : []);
    const createTasks = req.body?.createTasks !== false; // default true
    const items = plan.items.filter(i => !exclude.has(i.key));
    if (!items.length) return res.status(400).json({ error: 'nothing to add — every item was removed' });

    const existing = await db.prepare(`SELECT item_key FROM calendar_events WHERE user_id = ? AND itinerary_id = ?`).all(req.userId, row.id);
    const have = new Set(existing.map(e => e.item_key));
    const now = new Date().toISOString();
    let created = 0, tasksCreated = 0;
    for (const it of items) {
      const startUtc = new Date(cal.localToUtcMs(it.date, it.start, plan.tz)).toISOString();
      const endUtc   = new Date(cal.localToUtcMs(it.date, it.end,   plan.tz)).toISOString();
      if (!have.has(it.key)) {
        await db.prepare(
          `INSERT INTO calendar_events (user_id, title, notes, location, start_at, end_at, source, itinerary_id, item_key, created_at, updated_at)
           VALUES (?, ?, ?, NULL, ?, ?, 'itinerary', ?, ?, ?, ?)`
        ).run(req.userId, it.title, it.notes || null, startUtc, endUtc, row.id, it.key, now, now);
        created++;
      }
      // Create a task for unlinked items (no existing task_id) when requested
      if (createTasks && !it.task_id) {
        const priority = ['high','normal','low'].includes(it.priority) ? it.priority : 'normal';
        await db.prepare(
          `INSERT INTO tasks (user_id, title, notes, status, priority, remind_at, source, last_touched_at, created_at)
           VALUES (?, ?, ?, 'open', ?, ?, 'plan', ?, ?)`
        ).run(req.userId, it.title, it.notes || null, priority, startUtc, now, now);
        tasksCreated++;
      }
    }
    await db.prepare(`UPDATE itineraries SET status = 'confirmed', updated_at = ? WHERE id = ? AND user_id = ?`).run(now, row.id, req.userId);
    res.json({ ok: true, created, tasksCreated, skipped: items.length - created });
  });

  // Discards a draft, or undoes a confirmed plan by removing exactly the events it created.
  app.delete('/api/itinerary/:id', requireUser, gate, async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'bad id' });
    const id = Number(req.params.id);
    const row = await db.prepare(`SELECT id FROM itineraries WHERE id = ? AND user_id = ?`).get(id, req.userId);
    if (!row) return res.status(404).json({ error: 'plan not found' });
    const r = await db.prepare(`DELETE FROM calendar_events WHERE user_id = ? AND itinerary_id = ?`).run(req.userId, id);
    await db.prepare(`DELETE FROM itineraries WHERE id = ? AND user_id = ?`).run(id, req.userId);
    res.json({ ok: true, removed_events: r.changes || 0 });
  });
}

module.exports = { registerItineraryRoutes, extractJson, validatePlan, parseRequest, buildMessages };