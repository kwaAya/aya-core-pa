// ─── Calendar pod ────────────────────────────────────────────────────────────
// Native calendar (events CRUD) + a private, revocable .ics subscribe feed so
// Google Calendar / Apple Calendar / Outlook can show Core PA events for free.
//
// Design notes
//  • Additive: owns its own tables, created lazily with portable SQL, so db.js
//    is untouched and works on both SQLite and Postgres.
//  • Everything is stored in UTC ISO-8601 strings; timezone conversion happens
//    at the edges (itinerary generation, display).
//  • Every query is scoped by user_id. The only unauthenticated route is the
//    feed, which is gated by an unguessable per-user token.

const crypto = require('crypto');
const db = require('./db');

const DEFAULT_TZ = process.env.DEFAULT_TIMEZONE || 'Africa/Johannesburg';
const MAX_EVENTS_PER_USER = 3000;
const MAX_RANGE_DAYS = 62;
const MAX_EVENT_MS = 14 * 24 * 60 * 60 * 1000;

// ─── Schema ──────────────────────────────────────────────────────────────────

let schemaPromise = null;
function ensureCalendarSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await db.ready;
      const pk = db.USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
      await db.exec(`CREATE TABLE IF NOT EXISTS calendar_events (
        id ${pk},
        user_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        notes TEXT,
        location TEXT,
        start_at TEXT NOT NULL,
        end_at TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        itinerary_id INTEGER,
        item_key TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_cal_events_user_start ON calendar_events (user_id, start_at)`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_cal_events_itin ON calendar_events (itinerary_id)`);
      await db.exec(`CREATE TABLE IF NOT EXISTS calendar_feeds (
        id ${pk},
        user_id INTEGER NOT NULL UNIQUE,
        token TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      )`);
      await db.exec(`CREATE TABLE IF NOT EXISTS calendar_imports (
        id ${pk},
        user_id INTEGER NOT NULL,
        url TEXT NOT NULL,
        name TEXT NOT NULL,
        tz TEXT,
        last_synced_at TEXT,
        last_attempt_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL
      )`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_cal_imports_user ON calendar_imports (user_id)`);
      await db.exec(`CREATE TABLE IF NOT EXISTS itineraries (
        id ${pk},
        user_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        range_start TEXT NOT NULL,
        range_end TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        prompt TEXT,
        plan_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_itineraries_user ON itineraries (user_id, created_at)`);
    })().catch(err => { schemaPromise = null; throw err; });
  }
  return schemaPromise;
}

// ─── Time helpers (no dependencies; Intl handles DST) ────────────────────────

function isValidTz(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

// Offset (local − UTC) in ms for a given instant in a timezone.
function tzOffsetMs(utcMs, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const m = {};
  for (const p of parts) m[p.type] = p.value;
  const asUtc = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour, +m.minute, +m.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

function isDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function isTimeStr(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

// 'YYYY-MM-DD' + 'HH:mm' wall-clock time in `tz`  →  UTC epoch ms.
// Two passes so times near a DST change resolve correctly.
function localToUtcMs(dateStr, timeStr, tz) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  let t = naive - tzOffsetMs(naive, tz);
  t = naive - tzOffsetMs(t, tz);
  return t;
}

// UTC epoch ms → { date:'YYYY-MM-DD', time:'HH:mm' } in `tz`.
function utcToLocal(utcMs, tz) {
  const off = tzOffsetMs(utcMs, tz);
  const iso = new Date(utcMs + off).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

// ─── Validation ──────────────────────────────────────────────────────────────

function parseIso(v) {
  if (typeof v !== 'string' || v.length > 40) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function str(v, max) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return undefined; // signals invalid
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

// Returns { value } or { error }. With `existing`, missing fields fall back to it (PATCH).
function cleanEventInput(body, existing) {
  const b = body && typeof body === 'object' ? body : {};
  const out = {};

  const title = b.title !== undefined || !existing ? str(b.title, 200) : existing.title;
  if (!title) return { error: 'title is required' };
  out.title = title;

  for (const [field, max] of [['notes', 2000], ['location', 200]]) {
    if (b[field] !== undefined) {
      const v = str(b[field], max);
      if (v === undefined) return { error: `${field} must be text` };
      out[field] = v;
    } else {
      out[field] = existing ? existing[field] : null;
    }
  }

  const startMs = b.start_at !== undefined || !existing ? parseIso(b.start_at) : Date.parse(existing.start_at);
  const endMs   = b.end_at   !== undefined || !existing ? parseIso(b.end_at)   : Date.parse(existing.end_at);
  if (startMs === null) return { error: 'start_at must be an ISO date-time' };
  if (endMs === null)   return { error: 'end_at must be an ISO date-time' };
  if (endMs <= startMs) return { error: 'end must be after start' };
  if (endMs - startMs > MAX_EVENT_MS) return { error: 'events can be at most 14 days long' };
  out.start_at = new Date(startMs).toISOString();
  out.end_at = new Date(endMs).toISOString();
  return { value: out };
}

// ─── ICS generation ──────────────────────────────────────────────────────────

function icsEscape(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// RFC 5545 §3.1: lines longer than 75 octets are folded with CRLF + space.
function foldLine(line) {
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    const limit = out.length === 0 ? 75 : 74; // continuation lines lose 1 octet to the leading space
    if (bytes + b > limit) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.map((l, i) => (i === 0 ? l : ' ' + l)).join('\r\n');
}

function icsDate(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function buildIcs(events, calName = 'Core PA') {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Core PA//Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(calName)}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];
  for (const e of events) {
    const start = Date.parse(e.start_at);
    const end = Date.parse(e.end_at);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const stamp = Date.parse(e.updated_at) || Date.now();
    lines.push(
      'BEGIN:VEVENT',
      `UID:corepa-event-${e.id}@corepa`,
      `DTSTAMP:${icsDate(stamp)}`,
      `LAST-MODIFIED:${icsDate(stamp)}`,
      `DTSTART:${icsDate(start)}`,
      `DTEND:${icsDate(end)}`,
      `SUMMARY:${icsEscape(e.title)}`,
    );
    if (e.notes) lines.push(`DESCRIPTION:${icsEscape(e.notes)}`);
    if (e.location) lines.push(`LOCATION:${icsEscape(e.location)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

// ─── Queries shared with the itinerary module ────────────────────────────────

async function getEventsInRange(userId, fromIso, toIso, limit = 500, ownOnly = false) {
  return db.prepare(
    `SELECT id, title, notes, location, start_at, end_at, source, itinerary_id
       FROM calendar_events
      WHERE user_id = ? AND end_at > ? AND start_at < ?${ownOnly ? " AND source NOT LIKE 'import:%'" : ''}
      ORDER BY start_at ASC LIMIT ${Number(limit) | 0}`
  ).all(userId, fromIso, toIso);
}

// Open tasks that carry a date, as read-only calendar markers.
async function getTaskMarkers(userId, fromMs, toMs) {
  const rows = await db.prepare(
    `SELECT id, title, priority, remind_at, start_at, due_at
       FROM tasks WHERE user_id = ? AND status = 'open' LIMIT 500`
  ).all(userId);
  const out = [];
  for (const t of rows) {
    const kind = t.due_at ? 'due' : t.start_at ? 'start' : t.remind_at ? 'remind' : null;
    if (!kind) continue;
    const at = Date.parse(t[kind === 'due' ? 'due_at' : kind === 'start' ? 'start_at' : 'remind_at']);
    if (!Number.isFinite(at) || at < fromMs || at >= toMs) continue;
    out.push({ id: t.id, title: t.title, priority: t.priority, kind, at: new Date(at).toISOString() });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

// ─── Routes ──────────────────────────────────────────────────────────────────

function publicBase(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function feedPayload(req, token) {
  if (!token) return { url: null, webcal: null };
  const url = `${publicBase(req)}/calendar/feed/${token}.ics`;
  return { url, webcal: url.replace(/^https?:/, 'webcal:') };
}

function registerCalendarRoutes(app) {
  const { requireUser } = require('./auth');
  const { rateLimit } = require('./plan');

  ensureCalendarSchema().catch(e => console.error('[calendar] schema init failed:', e.message));
  const gate = async (req, res, next) => { try { await ensureCalendarSchema(); next(); } catch (e) { next(e); } };
  const limitWrites = rateLimit({ windowMs: 60_000, max: 60 });

  // ── Events ──
  app.get('/api/calendar/events', requireUser, gate, async (req, res) => {
    const fromMs = parseIso(req.query.from);
    const toMs = parseIso(req.query.to);
    if (fromMs === null || toMs === null || toMs <= fromMs) {
      return res.status(400).json({ error: 'from and to (ISO date-times) are required' });
    }
    if (toMs - fromMs > MAX_RANGE_DAYS * 86400000) {
      return res.status(400).json({ error: `range too large (max ${MAX_RANGE_DAYS} days)` });
    }
    try { require('./ics-import').refreshStale(req.userId); } catch { /* imports are optional */ }
    const [events, tasks] = await Promise.all([
      getEventsInRange(req.userId, new Date(fromMs).toISOString(), new Date(toMs).toISOString()),
      getTaskMarkers(req.userId, fromMs, toMs),
    ]);
    res.json({ events, tasks });
  });

  app.post('/api/calendar/events', requireUser, gate, limitWrites, async (req, res) => {
    const { value, error } = cleanEventInput(req.body);
    if (error) return res.status(400).json({ error });
    const count = Number((await db.prepare(`SELECT COUNT(*) AS n FROM calendar_events WHERE user_id = ? AND source NOT LIKE 'import:%'`).get(req.userId))?.n || 0);
    if (count >= MAX_EVENTS_PER_USER) return res.status(409).json({ error: 'event limit reached — delete old events first' });
    const now = new Date().toISOString();
    const r = await db.prepare(
      `INSERT INTO calendar_events (user_id, title, notes, location, start_at, end_at, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?)`
    ).run(req.userId, value.title, value.notes, value.location, value.start_at, value.end_at, now, now);
    const row = await db.prepare(`SELECT * FROM calendar_events WHERE id = ? AND user_id = ?`).get(r.lastInsertRowid, req.userId);
    res.status(201).json(row);
  });

  app.patch('/api/calendar/events/:id', requireUser, gate, limitWrites, async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'bad id' });
    const existing = await db.prepare(`SELECT * FROM calendar_events WHERE id = ? AND user_id = ?`).get(Number(req.params.id), req.userId);
    if (!existing) return res.status(404).json({ error: 'event not found' });
    if (String(existing.source).startsWith('import:')) return res.status(403).json({ error: 'Imported events are read-only — edit them in the original calendar.' });
    const { value, error } = cleanEventInput(req.body, existing);
    if (error) return res.status(400).json({ error });
    await db.prepare(
      `UPDATE calendar_events SET title = ?, notes = ?, location = ?, start_at = ?, end_at = ?, updated_at = ?
        WHERE id = ? AND user_id = ?`
    ).run(value.title, value.notes, value.location, value.start_at, value.end_at, new Date().toISOString(), existing.id, req.userId);
    res.json(await db.prepare(`SELECT * FROM calendar_events WHERE id = ? AND user_id = ?`).get(existing.id, req.userId));
  });

  app.delete('/api/calendar/events/:id', requireUser, gate, limitWrites, async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'bad id' });
    const r = await db.prepare(`DELETE FROM calendar_events WHERE id = ? AND user_id = ? AND source NOT LIKE 'import:%'`).run(Number(req.params.id), req.userId);
    if (!r.changes) return res.status(404).json({ error: 'event not found (imported events are read-only)' });
    res.json({ ok: true });
  });

  // ── Subscribe feed (Google / Apple / Outlook) ──
  app.get('/api/calendar/feed', requireUser, gate, async (req, res) => {
    const row = await db.prepare(`SELECT token FROM calendar_feeds WHERE user_id = ?`).get(req.userId);
    res.json(feedPayload(req, row?.token));
  });

  // Create, or rotate (which invalidates the old link immediately).
  app.post('/api/calendar/feed', requireUser, gate, rateLimit({ windowMs: 60_000, max: 10 }), async (req, res) => {
    const token = crypto.randomBytes(24).toString('base64url');
    await db.prepare(`DELETE FROM calendar_feeds WHERE user_id = ?`).run(req.userId);
    await db.prepare(`INSERT INTO calendar_feeds (user_id, token, created_at) VALUES (?, ?, ?)`)
      .run(req.userId, token, new Date().toISOString());
    res.status(201).json(feedPayload(req, token));
  });

  app.delete('/api/calendar/feed', requireUser, gate, async (req, res) => {
    await db.prepare(`DELETE FROM calendar_feeds WHERE user_id = ?`).run(req.userId);
    res.json({ ok: true });
  });

  // Public, token-gated. Generic 404 on any miss so tokens can't be probed for shape.
  app.get('/calendar/feed/:token.ics', rateLimit({ windowMs: 60_000, max: 30, key: req => req.ip }), gate, async (req, res) => {
    const token = req.params.token;
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return res.status(404).end();
    const feed = await db.prepare(`SELECT user_id FROM calendar_feeds WHERE token = ?`).get(token);
    if (!feed) return res.status(404).end();
    const from = new Date(Date.now() - 30 * 86400000).toISOString();
    const to = new Date(Date.now() + 365 * 86400000).toISOString();
    const own = await getEventsInRange(feed.user_id, from, to, 2000, true);
    const markers = await getTaskMarkers(feed.user_id, Date.parse(from), Date.parse(to));
    const taskEvents = markers.map(t => ({
      id: `task-${t.id}`, title: `☐ ${t.title}`,
      notes: `Core PA task (${t.kind === 'due' ? 'due' : t.kind === 'start' ? 'starts' : 'reminder'})`,
      start_at: t.at, end_at: new Date(Date.parse(t.at) + 30 * 60000).toISOString(), updated_at: t.at,
    }));
    const events = [...own, ...taskEvents];
    res.set({
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="core-pa.ics"',
      'Cache-Control': 'private, max-age=300',
      'X-Robots-Tag': 'noindex, nofollow',
      'Referrer-Policy': 'no-referrer',
    });
    res.send(buildIcs(events));
  });

  // ── Read-only imports (iCloud / Google / Outlook links) ──
  require('./ics-import').registerImportRoutes(app, { gate, limitWrites });
}

module.exports = {
  registerCalendarRoutes, ensureCalendarSchema,
  DEFAULT_TZ, isValidTz, tzOffsetMs, isDateStr, isTimeStr, addDays, daysBetween,
  localToUtcMs, utcToLocal, cleanEventInput, buildIcs, foldLine, icsEscape,
  getEventsInRange, getTaskMarkers,
};