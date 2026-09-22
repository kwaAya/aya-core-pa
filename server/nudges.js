const db = require('./db');

// Only one nudge is ever shown at a time, picked by priority (top match wins).
// Once dismissed, no nudge is shown again for the rest of that day — this is
// deliberately blunt rather than per-type, because the goal is "don't annoy
// me", not "let me dismiss my way through a list".

async function getDismissedDate(userId) {
  const row = await db.prepare(`SELECT value FROM settings WHERE key = ?`).get(`u${userId}_nudge_dismissed_date`);
  return row ? row.value : null;
}

async function dismissNudge(userId) {
  const today = new Date().toISOString().slice(0, 10);
  await db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
  ).run(`u${userId}_nudge_dismissed_date`, today);
}

// Rule A — a high-priority task is due imminently (or already overdue) and still open.
async function ruleUrgentTaskDue(userId) {
  const twoHoursFromNow = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const row = await db.prepare(
    `SELECT title, remind_at FROM tasks
     WHERE user_id = ? AND status = 'open' AND priority = 'high' AND remind_at IS NOT NULL AND remind_at <= ?
     ORDER BY remind_at ASC LIMIT 1`
  ).get(userId, twoHoursFromNow);
  if (!row) return null;
  const overdue = new Date(row.remind_at) < new Date();
  return {
    id: 'urgent_task_due',
    message: overdue
      ? `"${row.title}" was due and it's still open — want a fresh reminder in 30 minutes, or push it to tomorrow?`
      : `"${row.title}" is due soon and it's still open — want a reminder, or is it already handled?`,
    actions: [
      { id: 'remind_30', label: 'remind me in 30' },
      { id: 'dismiss', label: overdue ? 'push to tomorrow' : 'leave it' },
    ],
  };
}

// Rule B — this week's spend on a category is running well above last week's.
async function ruleSpendSpike(userId) {
  const wkStart  = (() => { const d = new Date(); d.setDate(d.getDate() - d.getDay()); d.setHours(0,0,0,0); return d.toISOString(); })();
  const lwkStart = (() => { const d = new Date(); d.setDate(d.getDate() - d.getDay() - 7); d.setHours(0,0,0,0); return d.toISOString(); })();
  const lwkEnd   = (() => { const d = new Date(); d.setDate(d.getDate() - d.getDay() - 1); d.setHours(23,59,59,999); return d.toISOString(); })();
  const tw = await db.prepare(`SELECT category, SUM(amount) as total FROM finance_entries WHERE type='expense' AND category != 'transfers' AND created_at>=? AND user_id=? GROUP BY category`).all(wkStart, userId);
  const lw = await db.prepare(`SELECT category, SUM(amount) as total FROM finance_entries WHERE type='expense' AND category != 'transfers' AND created_at>=? AND created_at<=? AND user_id=? GROUP BY category`).all(lwkStart, lwkEnd, userId);
  const lwMap = Object.fromEntries(lw.map(r => [r.category, r.total]));
  const spikes = tw
    .map(r => ({ category: r.category, total: r.total, prev: lwMap[r.category] || 0 }))
    .filter(r => r.prev > 0 && r.total > r.prev * 1.4)
    .sort((a, b) => (b.total / b.prev) - (a.total / a.prev));
  if (!spikes.length) return null;
  const s = spikes[0];
  return {
    id: 'spend_spike',
    message: `you're R${Math.round(s.total - s.prev)} over your usual ${s.category} spend for this point in the week — flag it or leave it?`,
    actions: [
      { id: 'flag', label: 'flag it' },
      { id: 'dismiss', label: 'leave it' },
    ],
  };
}

// Rule C — quiet day: nothing due today, streak is alive, offer to line up tomorrow.
async function ruleQuietDay(userId) {
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const todayEnd    = new Date(); todayEnd.setHours(23,59,59,999);
  const dueToday = await db.prepare(
    `SELECT COUNT(*) as n FROM tasks WHERE user_id = ? AND status = 'open' AND remind_at >= ? AND remind_at <= ?`
  ).get(userId, todayStart.toISOString(), todayEnd.toISOString());
  if (dueToday.n > 0) return null;
  const doneRows = await db.prepare(
    `SELECT last_touched_at FROM tasks WHERE status = 'done' AND user_id = ? ORDER BY last_touched_at DESC LIMIT 30`
  ).all(userId);
  const doneDates = new Set(doneRows.map(r => r.last_touched_at.slice(0, 10)));
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  if (!doneDates.has(yesterday.toISOString().slice(0, 10)) && !doneDates.has(new Date().toISOString().slice(0, 10))) return null;
  return {
    id: 'quiet_day',
    message: `nothing's due today and your streak's alive — want me to line up tomorrow's priorities tonight instead?`,
    actions: [
      { id: 'plan_tomorrow', label: 'line it up' },
      { id: 'dismiss', label: 'not now' },
    ],
  };
}

async function computeNudge(userId) {
  if (!userId) return null;
  const dismissedDate = await getDismissedDate(userId);
  const today = new Date().toISOString().slice(0, 10);
  if (dismissedDate === today) return null;

  for (const rule of [ruleUrgentTaskDue, ruleSpendSpike, ruleQuietDay]) {
    try {
      const nudge = await rule(userId);
      if (nudge) return nudge;
    } catch (err) {
      console.error(`[nudges] rule failed:`, err.message);
    }
  }
  return null;
}

module.exports = { computeNudge, dismissNudge };