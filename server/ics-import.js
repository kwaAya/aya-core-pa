'use strict';
// ─── Read-only calendar import (iCloud public calendar, Google "secret address", Outlook, any .ics URL) ───
// The user pastes a calendar link; we fetch it server-side, parse the events and keep a copy in
// calendar_events with source = 'import:<id>'. Imported events are read-only, are NEVER re-exported
// through the Core PA feed, and count as busy time for the planner.
//
// Safety: https only, no credentials in URLs, private/loopback addresses refused (SSRF),
// redirects re-checked, 12 s timeout, 3 MB cap, 3 imports per user.

const dns = require('dns').promises;
const net = require('net');
const db = require('./db');
const cal = require('./calendar');

const DAY = 86400000;
const MAX_IMPORTS = 3;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_EVENTS_PER_IMPORT = 800;
const PAST_DAYS = 14, FUTURE_DAYS = 120;
const STALE_MS = 30 * 60 * 1000;

class ImportError extends Error {}
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);

// ── SSRF guard ───────────────────────────────────────────────────────────────
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v = String(ip).toLowerCase();
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('::ffff:')) { const m = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); return m ? isPrivateIp(m[1]) : true; }
  return /^(fc|fd|fe[89ab])/.test(v);
}

async function assertPublicHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new ImportError('That address is not allowed.');
  if (net.isIP(host)) { if (isPrivateIp(host)) throw new ImportError('That address is not allowed.'); return; }
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch { throw new ImportError("Couldn't find that calendar address."); }
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new ImportError('That address is not allowed.');
}

function normalizeUrl(raw) {
  let s = String(raw || '').trim();
  if (!s || s.length > 2000) throw new ImportError('Paste the calendar link first.');
  s = s.replace(/^webcals?:\/\//i, 'https://');
  let u;
  try { u = new URL(s); } catch { throw new ImportError("That doesn't look like a link."); }
  if (u.protocol !== 'https:') throw new ImportError('Calendar links must start with https:// or webcal://');
  if (u.username || u.password) throw new ImportError('Remove the username/password from the link.');
  return u.toString();
}

async function readLimited(res) {
  const reader = res.body.getReader(); const chunks = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > MAX_BYTES) { try { await reader.cancel(); } catch { /* ignore */ } throw new ImportError('That calendar is too large to import.'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchIcsText(raw) {
  let url = normalizeUrl(raw);
  for (let hop = 0; hop < 4; hop++) {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password) throw new ImportError('Calendar links must start with https:// or webcal://');
    await assertPublicHost(u.hostname);
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 12000);
    let res;
    try {
      res = await fetch(url, { redirect: 'manual', signal: ctrl.signal, headers: { Accept: 'text/calendar, text/plain;q=0.8, */*;q=0.5', 'User-Agent': 'CorePA-CalendarImport/1.0' } });
    } catch { clearTimeout(timer); throw new ImportError("Couldn't reach that calendar link."); }
    try {
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = new URL(res.headers.get('location'), url).toString(); continue; }
      if (!res.ok) throw new ImportError(`That link returned an error (${res.status}). Make sure the calendar is shared publicly.`);
      const text = await readLimited(res);
      if (!/BEGIN:VCALENDAR/i.test(text)) throw new ImportError("That link didn't return a calendar (.ics) file.");
      return text;
    } finally { clearTimeout(timer); }
  }
  throw new ImportError('Too many redirects.');
}

// ── ICS parsing (pure — unit tested) ─────────────────────────────────────────
function splitProp(line) {
  let q = false, idx = -1;
  for (let i = 0; i < line.length; i++) { const c = line[i]; if (c === '"') q = !q; else if (c === ':' && !q) { idx = i; break; } }
  if (idx < 0) return null;
  const parts = line.slice(0, idx).split(';');
  const name = parts.shift().toUpperCase(); const params = {};
  for (const p of parts) { const e = p.indexOf('='); if (e > 0) params[p.slice(0, e).toUpperCase()] = p.slice(e + 1).replace(/^"|"$/g, ''); }
  return { name, params, value: line.slice(idx + 1) };
}
const unescapeText = s => String(s).replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

function parseDt(prop, userTz) {
  const v = String(prop.value).trim();
  let m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) { const date = `${m[1]}-${m[2]}-${m[3]}`; return { kind: 'date', date, time: '00:00', tz: userTz, ms: cal.localToUtcMs(date, '00:00', userTz) }; }
  m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`, time = `${m[4]}:${m[5]}`;
  if (m[7]) return { kind: 'utc', date, time, tz: 'UTC', ms: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) };
  const tz = prop.params.TZID && cal.isValidTz(prop.params.TZID) ? prop.params.TZID : userTz;   // Windows-style names fall back to the user's zone
  return { kind: 'tz', date, time, tz, ms: cal.localToUtcMs(date, time, tz) };
}

function parseDuration(s) {
  const m = String(s).match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const ms = ((+m[2] || 0) * 7 + (+m[3] || 0)) * DAY + (+m[4] || 0) * 3600000 + (+m[5] || 0) * 60000 + (+m[6] || 0) * 1000;
  return m[1] === '-' ? -ms : ms;
}

const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const dowOf = ds => new Date(`${ds}T00:00:00Z`).getUTCDay();
const mondayOf = ds => cal.addDays(ds, -((dowOf(ds) + 6) % 7));

function parseRrule(s) {
  const r = {};
  for (const part of String(s).split(';')) { const i = part.indexOf('='); if (i > 0) r[part.slice(0, i).toUpperCase()] = part.slice(i + 1); }
  return r;
}

function expand(ev, fromMs, toMs, userTz) {
  const durMs = Math.max(0, ev.endMs - ev.startMs);
  const out = [];
  const push = (startMs) => { const endMs = startMs + durMs; if (endMs > fromMs && startMs < toMs && !ev.exSet.has(startMs)) out.push({ startMs, endMs }); };
  if (!ev.rrule) { push(ev.startMs); return out; }

  const r = parseRrule(ev.rrule), s = ev.start;
  const freq = r.FREQ, interval = Math.max(1, parseInt(r.INTERVAL || '1', 10) || 1);
  const count = r.COUNT ? parseInt(r.COUNT, 10) : Infinity;
  const byday = r.BYDAY ? r.BYDAY.split(',').map(x => x.trim().toUpperCase()) : null;
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq) || ((freq === 'MONTHLY' || freq === 'YEARLY') && byday && byday.some(x => /\d/.test(x)))) {
    push(ev.startMs); return out;                                   // unsupported pattern: keep the first occurrence only
  }
  let untilMs = Infinity;
  if (r.UNTIL) { const u = parseDt({ value: r.UNTIL, params: {} }, s.tz); if (u) untilMs = u.kind === 'date' ? u.ms + DAY : u.ms; }

  const tz = s.tz, time = s.time || '00:00', startDate = s.date;
  const windowStartDate = cal.utcToLocal(fromMs - durMs - DAY, tz).date;
  const windowEndDate = cal.utcToLocal(Math.min(toMs, untilMs), tz).date;
  const days = new Set(byday ? byday.map(x => WD[x.slice(-2)]).filter(x => x !== undefined) : [dowOf(startDate)]);
  const startMonth = startDate.slice(0, 7), sy = +startDate.slice(0, 4), sm = +startDate.slice(5, 7), sd = startDate.slice(8, 10);

  let d = Number.isFinite(count) ? startDate : (windowStartDate > startDate ? windowStartDate : startDate);
  let n = 0, guard = 0;
  if (Number.isFinite(count)) { /* iterate from the start so COUNT is honoured */ }
  for (; d <= windowEndDate && guard < 6000; d = cal.addDays(d, 1), guard++) {
    if (d < startDate) continue;
    let match = false;
    if (freq === 'DAILY') match = cal.daysBetween(startDate, d) % interval === 0;
    else if (freq === 'WEEKLY') match = days.has(dowOf(d)) && Math.round(cal.daysBetween(mondayOf(startDate), mondayOf(d)) / 7) % interval === 0;
    else if (freq === 'MONTHLY') { const mo = (+d.slice(0, 4) - sy) * 12 + (+d.slice(5, 7) - sm); match = d.slice(8, 10) === sd && mo % interval === 0; }
    else { match = d.slice(5) === startDate.slice(5) && (+d.slice(0, 4) - sy) % interval === 0; }
    if (!match) continue;
    const startMs = s.kind === 'utc' ? cal.localToUtcMs(d, time, 'UTC') : cal.localToUtcMs(d, time, tz);
    if (startMs > untilMs) break;
    if (++n > count) break;
    push(startMs);
  }
  void startMonth; void userTz;
  return out;
}

function parseIcs(text, userTz, fromMs, toMs) {
  const lines = String(text).replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const evs = []; let cur = null;
  for (const line of lines) {
    if (/^BEGIN:VEVENT$/i.test(line)) { cur = { ex: [] }; continue; }
    if (/^END:VEVENT$/i.test(line)) { if (cur) evs.push(cur); cur = null; continue; }
    if (!cur) continue;
    const p = splitProp(line); if (!p) continue;
    switch (p.name) {
      case 'UID': cur.uid = p.value.trim(); break;
      case 'SUMMARY': cur.title = unescapeText(p.value); break;
      case 'DESCRIPTION': cur.notes = unescapeText(p.value); break;
      case 'LOCATION': cur.location = unescapeText(p.value); break;
      case 'STATUS': cur.status = p.value.trim().toUpperCase(); break;
      case 'DTSTART': cur.dtstart = p; break;
      case 'DTEND': cur.dtend = p; break;
      case 'DURATION': cur.duration = p.value.trim(); break;
      case 'RRULE': cur.rrule = p.value.trim(); break;
      case 'RECURRENCE-ID': cur.recId = p; break;
      case 'EXDATE': for (const v of p.value.split(',')) cur.ex.push({ value: v, params: p.params }); break;
      default: break;
    }
  }
  const overrides = new Set();
  const prepared = [];
  for (const e of evs) {
    if (!e.dtstart) continue;
    const start = parseDt(e.dtstart, userTz); if (!start) continue;
    let endMs;
    const end = e.dtend ? parseDt(e.dtend, userTz) : null;
    const dur = e.duration ? parseDuration(e.duration) : null;
    if (end) endMs = end.ms; else if (dur != null) endMs = start.ms + dur; else endMs = start.ms + (start.kind === 'date' ? DAY : 30 * 60000);
    if (endMs <= start.ms) endMs = start.ms + (start.kind === 'date' ? DAY : 30 * 60000);
    const uid = e.uid || `${start.ms}-${clip(e.title, 20)}`;
    if (e.recId) { const rid = parseDt(e.recId, userTz); if (rid) overrides.add(`${uid}|${rid.ms}`); }
    prepared.push({ ...e, uid, start, startMs: start.ms, endMs, isOverride: !!e.recId,
      exSet: new Set(e.ex.map(x => parseDt(x, userTz)).filter(Boolean).map(x => x.ms)) });
  }
  const out = []; const seen = new Set();
  for (const e of prepared) {
    if (e.status === 'CANCELLED') continue;
    for (const o of expand(e, fromMs, toMs, userTz)) {
      if (!e.isOverride && overrides.has(`${e.uid}|${o.startMs}`)) continue;
      const key = `${e.uid}|${o.startMs}`;
      if (seen.has(key)) continue; seen.add(key);
      out.push({ uid: e.uid, startMs: o.startMs, endMs: o.endMs, title: e.title || '(no title)', notes: e.notes || '', location: e.location || '' });
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

// ── Sync ─────────────────────────────────────────────────────────────────────
async function syncImport(row) {
  const userTz = row.tz && cal.isValidTz(row.tz) ? row.tz : cal.DEFAULT_TZ;
  const text = await fetchIcsText(row.url);
  const nowMs = Date.now();
  const evs = parseIcs(text, userTz, nowMs - PAST_DAYS * DAY, nowMs + FUTURE_DAYS * DAY).slice(0, MAX_EVENTS_PER_IMPORT);
  const src = `import:${row.id}`, now = new Date().toISOString();
  await db.prepare(`DELETE FROM calendar_events WHERE user_id = ? AND source = ?`).run(row.user_id, src);
  const ins = db.prepare(
    `INSERT INTO calendar_events (user_id, title, notes, location, start_at, end_at, source, item_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const e of evs) {
    await ins.run(row.user_id, clip(e.title, 200), clip(e.notes, 2000) || null, clip(e.location, 200) || null,
      new Date(e.startMs).toISOString(), new Date(e.endMs).toISOString(), src, clip(`${e.uid}|${e.startMs}`, 300), now, now);
  }
  await db.prepare(`UPDATE calendar_imports SET last_synced_at = ?, last_attempt_at = ?, last_error = NULL WHERE id = ?`).run(now, now, row.id);
  return evs.length;
}

async function recordFailure(id, err) {
  const msg = err instanceof ImportError ? err.message : "Couldn't refresh this calendar.";
  await db.prepare(`UPDATE calendar_imports SET last_error = ?, last_attempt_at = ? WHERE id = ?`).run(msg, new Date().toISOString(), id).catch(() => {});
  return msg;
}

const inflight = new Set();
function refreshStale(userId) {
  db.prepare(`SELECT * FROM calendar_imports WHERE user_id = ?`).all(userId).then(rows => {
    for (const r of rows) {
      const last = Math.max(Date.parse(r.last_synced_at || '') || 0, Date.parse(r.last_attempt_at || '') || 0);
      if (Date.now() - last < STALE_MS || inflight.has(r.id)) continue;
      inflight.add(r.id);
      syncImport(r).catch(e => recordFailure(r.id, e)).finally(() => inflight.delete(r.id));
    }
  }).catch(() => {});
}

// ── Routes ───────────────────────────────────────────────────────────────────
async function shape(r) {
  let host = ''; try { host = new URL(r.url).hostname; } catch { /* ignore */ }
  const n = Number((await db.prepare(`SELECT COUNT(*) AS n FROM calendar_events WHERE user_id = ? AND source = ?`).get(r.user_id, `import:${r.id}`))?.n || 0);
  return { id: r.id, name: r.name, host, last_synced_at: r.last_synced_at, last_error: r.last_error || null, event_count: n };
}

function registerImportRoutes(app, { gate, limitWrites }) {
  const { requireUser } = require('./auth');
  const { rateLimit } = require('./plan');
  const limitSync = rateLimit({ windowMs: 60_000, max: 8 });
  const own = (id, uid) => db.prepare(`SELECT * FROM calendar_imports WHERE id = ? AND user_id = ?`).get(Number(id), uid);

  app.get('/api/calendar/imports', requireUser, gate, async (req, res) => {
    const rows = await db.prepare(`SELECT * FROM calendar_imports WHERE user_id = ? ORDER BY id`).all(req.userId);
    res.json({ imports: await Promise.all(rows.map(shape)) });
  });

  app.post('/api/calendar/imports', requireUser, gate, limitSync, async (req, res) => {
    let url;
    try { url = normalizeUrl(req.body && req.body.url); } catch (e) { return res.status(400).json({ error: e.message }); }
    const count = Number((await db.prepare(`SELECT COUNT(*) AS n FROM calendar_imports WHERE user_id = ?`).get(req.userId))?.n || 0);
    if (count >= MAX_IMPORTS) return res.status(409).json({ error: `You can link up to ${MAX_IMPORTS} calendars. Remove one first.` });
    const dup = await db.prepare(`SELECT id FROM calendar_imports WHERE user_id = ? AND url = ?`).get(req.userId, url);
    if (dup) return res.status(409).json({ error: 'That calendar is already linked.' });
    let host = 'Calendar'; try { host = new URL(url).hostname; } catch { /* ignore */ }
    const name = clip((req.body && req.body.name) || '', 60).trim() || host;
    const tz = req.body && typeof req.body.timezone === 'string' && cal.isValidTz(req.body.timezone) ? req.body.timezone : cal.DEFAULT_TZ;
    const now = new Date().toISOString();
    const ins = await db.prepare(`INSERT INTO calendar_imports (user_id, url, name, tz, created_at) VALUES (?, ?, ?, ?, ?)`).run(req.userId, url, name, tz, now);
    const row = await own(ins.lastInsertRowid, req.userId);
    try {
      const n = await syncImport(row);
      res.status(201).json({ import: await shape(await own(row.id, req.userId)), imported: n });
    } catch (e) {
      await db.prepare(`DELETE FROM calendar_events WHERE user_id = ? AND source = ?`).run(req.userId, `import:${row.id}`).catch(() => {});
      await db.prepare(`DELETE FROM calendar_imports WHERE id = ?`).run(row.id).catch(() => {});
      if (!(e instanceof ImportError)) console.error('[calendar-import] failed:', e.message);
      res.status(400).json({ error: e instanceof ImportError ? e.message : "Couldn't read that calendar." });
    }
  });

  app.post('/api/calendar/imports/:id/sync', requireUser, gate, limitSync, async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'bad id' });
    const row = await own(req.params.id, req.userId);
    if (!row) return res.status(404).json({ error: 'calendar not found' });
    try { const n = await syncImport(row); res.json({ import: await shape(await own(row.id, req.userId)), imported: n }); }
    catch (e) { res.status(400).json({ error: await recordFailure(row.id, e) }); }
  });

  app.delete('/api/calendar/imports/:id', requireUser, gate, limitWrites, async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'bad id' });
    const row = await own(req.params.id, req.userId);
    if (!row) return res.status(404).json({ error: 'calendar not found' });
    await db.prepare(`DELETE FROM calendar_events WHERE user_id = ? AND source = ?`).run(req.userId, `import:${row.id}`);
    await db.prepare(`DELETE FROM calendar_imports WHERE id = ? AND user_id = ?`).run(row.id, req.userId);
    res.json({ ok: true });
  });
}

module.exports = { registerImportRoutes, refreshStale, syncImport, parseIcs, expand, isPrivateIp, normalizeUrl, ImportError };