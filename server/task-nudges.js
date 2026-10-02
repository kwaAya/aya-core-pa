// ─── Start / finish nudges + event reminders ─────────────────────────────────
// Fills the gap between the app's client-side alarms (which only fire while the
// app is open) and the existing server ladder (which starts at remind_at):
//
//   start_at  → "time to start"        (once)  → arms the existing ladder
//   due_at    → "was it finished?"     (once)  → arms the existing ladder
//   events    → "starts in N min"      (once)
//
// Once the ladder is armed, scheduler.checkEscalatingPings keeps re-pinging on
// the user's own tiers until the task is ticked off, so "ping again and again"
// is handled by code that already exists and is already configurable.
//
// Safe by construction: each nudge is claimed in a unique-keyed log BEFORE it is
// sent, so overlapping runs or restarts can never double-send, and changing a
// task's time re-arms it automatically (the stamp is part of the key).
// Kill switch: set NUDGES_PLUS_DISABLED=1.

const db = require('./db');
const cal = require('./calendar');

const START_WINDOW_MS = 3 * 3600e3;   // don't announce a start that is hours stale (e.g. after downtime)
const DUE_WINDOW_MS = 12 * 3600e3;
const EVENT_LEAD_MIN = Math.min(Math.max(Number(process.env.EVENT_REMINDER_MINUTES) || 10, 1), 120);
const MAX_PER_RUN = 200;

let schemaPromise = null;
function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await db.ready;
      const pk = db.USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
      await db.exec(`CREATE TABLE IF NOT EXISTS nudge_log (
        id ${pk}, kind TEXT NOT NULL, ref_id INTEGER NOT NULL, stamp TEXT NOT NULL, fired_at TEXT NOT NULL
      )`);
      await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_nudge_log ON nudge_log (kind, ref_id, stamp)`);
    })().catch(err => { schemaPromise = null; throw err; });
  }
  return schemaPromise;
}

// True only for the caller that wins the claim.
async function claim(kind, refId, stamp, nowMs) {
  try {
    await db.prepare(`INSERT INTO nudge_log (kind, ref_id, stamp, fired_at) VALUES (?, ?, ?, ?)`)
      .run(kind, refId, String(stamp), new Date(nowMs).toISOString());
    return true;
  } catch { return false; }
}

async function armLadder(task, nowMs, nextPingMinutes) {
  if (task.next_ping_at) return; // already nagging (e.g. remind_at fired first)
  const mins = await nextPingMinutes(task.user_id, task.priority, 0);
  await db.prepare(`UPDATE tasks SET ping_count = 0, next_ping_at = ? WHERE id = ? AND user_id = ? AND status = 'open'`)
    .run(new Date(nowMs + mins * 60000).toISOString(), task.id, task.user_id);
}

const hi = t => (t.priority === 'high' ? '🔥 ' : '');

async function runTaskNudges({ notify, nextPingMinutes }, nowMs = Date.now()) {
  await ensureSchema();
  const tasks = await db.prepare(
    `SELECT t.id, t.user_id, t.title, t.priority, t.start_at, t.due_at, t.next_ping_at
       FROM tasks t JOIN users u ON u.id = t.user_id
      WHERE t.status = 'open' AND (t.start_at IS NOT NULL OR t.due_at IS NOT NULL)
      LIMIT 5000`
  ).all();

  let sent = 0;
  for (const t of tasks) {
    if (sent >= MAX_PER_RUN) break;
    const startMs = t.start_at ? Date.parse(t.start_at) : NaN;
    const dueMs = t.due_at ? Date.parse(t.due_at) : NaN;

    if (Number.isFinite(startMs) && startMs <= nowMs && nowMs - startMs <= START_WINDOW_MS
        && await claim('task_start', t.id, t.start_at, nowMs)) {
      await notify(t.user_id, `▶️ ${hi(t)}time to start: ${t.title}`, 'Time to start', { taskId: t.id });
      await armLadder(t, nowMs, nextPingMinutes);
      sent++;
    }

    if (Number.isFinite(dueMs) && dueMs <= nowMs && nowMs - dueMs <= DUE_WINDOW_MS
        && await claim('task_due', t.id, t.due_at, nowMs)) {
      await notify(t.user_id, `⏰ ${hi(t)}"${t.title}" was due — is it done? Tick it off, or move it.`, 'Was it finished?', { taskId: t.id });
      await armLadder(t, nowMs, nextPingMinutes);
      sent++;
    }
  }
  return sent;
}

async function runEventReminders({ notify }, nowMs = Date.now()) {
  await ensureSchema();
  await cal.ensureCalendarSchema();
  const events = await db.prepare(
    `SELECT e.id, e.user_id, e.title, e.location, e.start_at
       FROM calendar_events e JOIN users u ON u.id = e.user_id
      WHERE e.start_at > ? AND e.start_at <= ? LIMIT ${MAX_PER_RUN}`
  ).all(new Date(nowMs).toISOString(), new Date(nowMs + EVENT_LEAD_MIN * 60000).toISOString());

  let sent = 0;
  for (const e of events) {
    if (!(await claim('event', e.id, e.start_at, nowMs))) continue;
    const mins = Math.max(1, Math.round((Date.parse(e.start_at) - nowMs) / 60000));
    await notify(e.user_id, `📅 in ${mins} min: ${e.title}${e.location ? ` @ ${e.location}` : ''}`, 'Coming up', { eventId: e.id });
    sent++;
  }
  return sent;
}

async function pruneLog(nowMs = Date.now()) {
  await ensureSchema();
  await db.prepare(`DELETE FROM nudge_log WHERE fired_at < ?`).run(new Date(nowMs - 30 * 86400000).toISOString());
}

// Called once from scheduler.startScheduler().
function register(cron, notify, nextPingMinutes) {
  if (process.env.NUDGES_PLUS_DISABLED === '1') { console.log('[nudges+] disabled via NUDGES_PLUS_DISABLED'); return; }
  const deps = { notify, nextPingMinutes };
  const safe = (name, fn) => async () => { try { await fn(); } catch (e) { console.error(`[nudges+] ${name} failed:`, e.message); } };
  cron.schedule('* * * * *', safe('task nudges', () => runTaskNudges(deps)));
  cron.schedule('* * * * *', safe('event reminders', () => runEventReminders(deps)));
  cron.schedule('17 3 * * *', safe('prune', () => pruneLog()));
}

module.exports = { register, runTaskNudges, runEventReminders, pruneLog, EVENT_LEAD_MIN };