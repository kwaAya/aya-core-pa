'use strict';
// ─── History-aware planning context ──────────────────────────────────────────
// No AI, no dependencies. Learns from a user's PAST tasks and reminders:
//   • routines   – titles that keep coming back on the same weekdays/times
//   • rhythms    – when they actually get things done, and which days are light
//   • carry-over – open tasks that keep slipping
// The result is (a) a compact text block for the planner prompt, (b) a few
// plain-English "basis" lines shown to the user, and (c) pre-computed routine
// slots so habits get placed deterministically instead of by model guesswork.

const db = require('./db');
const cal = require('./calendar');

const LOOKBACK_DAYS = 120;
const ACTIVE_WITHIN_DAYS = 45;     // a routine must have been seen this recently
const MIN_OCCURRENCES = 3;
const DEFAULT_SLOT_MIN = 45;
const MAX_SLOTS = 14, MAX_SLOTS_PER_DAY = 3;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const pad = n => String(n).padStart(2, '0');
const toHHMM = m => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
const round15 = m => Math.round(m / 15) * 15;
const dowOf = dateStr => new Date(`${dateStr}T00:00:00Z`).getUTCDay();
const quantile = (sorted, q) => sorted[Math.floor(q * (sorted.length - 1))];

function normTitle(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\b\d+\b/g, ' ').replace(/\s+/g, ' ').trim();
}

// When did this task "happen"? Prefer the time it was scheduled for; fall back to when it was finished.
function hitMs(t) {
  const planned = Date.parse(t.due_at || t.start_at || t.remind_at || '');
  if (Number.isFinite(planned)) return { ms: planned, explicit: true };
  const base = t.status === 'done' ? t.last_touched_at : t.created_at;
  const ms = Date.parse(base || '');
  return Number.isFinite(ms) ? { ms, explicit: false } : null;
}

function learnHabits(tasks, tz, nowMs = Date.now()) {
  const groups = new Map();
  for (const t of tasks) {
    const k = normTitle(t.title);
    if (k.length < 3) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const habits = [];
  for (const [key, rows] of groups) {
    const recurring = rows.map(r => r.recurring).find(Boolean) || null;
    if (rows.length < MIN_OCCURRENCES && !recurring) continue;

    const hits = [];
    for (const r of rows) {
      const h = hitMs(r); if (!h) continue;
      const l = cal.utcToLocal(h.ms, tz);
      const [hh, mm] = l.time.split(':').map(Number);
      hits.push({ ms: h.ms, dow: dowOf(l.date), min: hh * 60 + mm, explicit: h.explicit });
    }
    if (hits.length < 2 && !recurring) continue;
    const lastMs = Math.max(...hits.map(h => h.ms));
    if (nowMs - lastMs > ACTIVE_WITHIN_DAYS * 86400000) continue;     // gone cold

    const byDow = new Array(7).fill(0);
    hits.forEach(h => byDow[h.dow]++);
    let dows;
    if (recurring === 'daily') dows = [0, 1, 2, 3, 4, 5, 6];
    else {
      dows = byDow.map((n, d) => ({ n, d })).filter(x => x.n >= 2 || (x.n && x.n / hits.length >= 0.3))
        .sort((a, b) => b.n - a.n).slice(0, 3).map(x => x.d).sort((a, b) => a - b);
      const share = dows.reduce((s, d) => s + byDow[d], 0) / Math.max(1, hits.length);
      if (!dows.length || share < 0.6) continue;                      // not a weekday pattern
    }
    const mins = hits.filter(h => dows.includes(h.dow)).map(h => h.min).sort((a, b) => a - b);
    const spread = mins.length > 1 ? quantile(mins, 0.75) - quantile(mins, 0.25) : 0;
    const fixed = mins.length >= 2 && spread <= 120;
    const latest = rows.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
    habits.push({
      key, title: String(latest.title).trim(), dows, count: rows.length, recurring,
      minutes: fixed ? Math.min(23 * 60 + 45, round15(quantile(mins, 0.5))) : null,
    });
  }
  return habits.sort((a, b) => b.count - a.count).slice(0, 8);
}

function rhythms(doneTasks, tz) {
  const hours = new Array(24).fill(0), dows = new Array(7).fill(0);
  let n = 0;
  for (const t of doneTasks) {
    const ms = Date.parse(t.last_touched_at || ''); if (!Number.isFinite(ms)) continue;
    const l = cal.utcToLocal(ms, tz);
    hours[Number(l.time.slice(0, 2))]++; dows[dowOf(l.date)]++; n++;
  }
  if (n < 8) return { n, window: null, light: [] };
  let best = 0, at = 8;
  for (let h = 6; h < 22; h++) { const s = hours[h] + hours[h + 1]; if (s > best) { best = s; at = h; } }
  const window = best / n >= 0.25 ? `${pad(at)}:00–${pad(at + 2)}:00` : null;
  const avg = n / 7;
  const light = dows.map((c, d) => ({ c, d })).filter(x => x.c < avg * 0.6).map(x => DOW[x.d]);
  return { n, window, light };
}

function habitSlots(habits, startDate, endDate, tz, busy, openKeys, nowMs) {
  const slots = [];
  const total = cal.daysBetween(startDate, endDate) + 1;
  for (let i = 0; i < total && slots.length < MAX_SLOTS; i++) {
    const date = cal.addDays(startDate, i), dow = dowOf(date);
    let perDay = 0;
    for (const h of habits) {
      if (h.minutes == null || !h.dows.includes(dow) || openKeys.has(h.key) || perDay >= MAX_SLOTS_PER_DAY) continue;
      const start = toHHMM(h.minutes), end = toHHMM(h.minutes + DEFAULT_SLOT_MIN);
      const s = cal.localToUtcMs(date, start, tz), e = s + DEFAULT_SLOT_MIN * 60000;
      if (s < nowMs) continue;
      if (busy.some(b => b.startMs < e && b.endMs > s)) continue;
      slots.push({ date, start, end, title: h.title }); perDay++;
      if (slots.length >= MAX_SLOTS) break;
    }
  }
  return slots;
}

// Pure core (unit-tested): rows in → context out.
function buildContext({ rows, openTasks, tz, startDate, endDate, busy = [], nowMs = Date.now() }) {
  const habits = learnHabits(rows, tz, nowMs);
  // Routines (gym at 19:00) say nothing about when focused work gets done, so keep them out of the rhythm.
  const habitKeys = new Set(habits.map(h => h.key));
  const rhythm = rhythms(rows.filter(r => r.status === 'done' && !habitKeys.has(normTitle(r.title))), tz);
  const openKeys = new Set(openTasks.map(t => normTitle(t.title)));
  const slots = habitSlots(habits, startDate, endDate, tz, busy, openKeys, nowMs);
  const slipping = openTasks
    .map(t => ({ id: t.id, title: t.title, days: Math.floor((nowMs - Date.parse(t.created_at || '')) / 86400000) }))
    .filter(t => Number.isFinite(t.days) && t.days >= 7).sort((a, b) => b.days - a.days).slice(0, 5);

  const dowList = h => h.dows.length === 7 ? 'daily' : h.dows.map(d => DOW[d]).join(', ');
  const lines = [];
  if (habits.length) lines.push('- Routines: ' + habits.slice(0, 5).map(h => `${h.title} — ${dowList(h)}${h.minutes != null ? ` around ${toHHMM(h.minutes)}` : ' (time varies)'}, seen ${h.count}×`).join('; '));
  if (rhythm.window) lines.push(`- Gets the most done around ${rhythm.window}; put demanding work there.`);
  if (rhythm.light.length) lines.push(`- Usually lighter days: ${rhythm.light.join(', ')}.`);
  if (slipping.length) lines.push('- Slipping (open 7+ days, schedule early): ' + slipping.map(t => `id ${t.id} "${String(t.title).slice(0, 50)}" (${t.days}d)`).join(', '));

  let block = '';
  if (lines.length || slots.length) {
    block = 'What the user\'s history shows (use it to personalise the plan; only mention it when useful):\n' + lines.join('\n');
    if (slots.length) block += '\nRoutine slots to include as items (task_id null) unless they clash:\n' + slots.map(s => `- ${s.date} ${s.start}-${s.end} ${s.title}`).join('\n');
  } else {
    block = 'History: not enough past tasks yet to learn routines.';
  }

  const basis = [];
  if (habits.length) basis.push('Routines: ' + habits.slice(0, 3).map(h => `${h.title} (${dowList(h)}${h.minutes != null ? ` ~${toHHMM(h.minutes)}` : ''})`).join(' · '));
  if (rhythm.window) basis.push(`Most productive: ${rhythm.window}`);
  if (slipping.length) basis.push(`${slipping.length} task${slipping.length === 1 ? ' has' : 's have'} been open over a week — scheduled early`);
  return { block, basis, slots, habits, rhythm, slipping };
}

async function buildHistoryContext(uid, tz, startDate, endDate, busy, openTasks, nowMs = Date.now()) {
  const since = new Date(nowMs - LOOKBACK_DAYS * 86400000).toISOString();
  const rows = await db.prepare(
    `SELECT id, title, status, priority, remind_at, start_at, due_at, recurring, last_touched_at, created_at
       FROM tasks WHERE user_id = ? AND created_at >= ? ORDER BY id DESC LIMIT 800`
  ).all(uid, since);
  return buildContext({ rows, openTasks, tz, startDate, endDate, busy, nowMs });
}

module.exports = { buildHistoryContext, buildContext, learnHabits, rhythms, habitSlots, normTitle };