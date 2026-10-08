const cron = require('node-cron');
const db = require('./db');
const { sendMessage, nextRecurringDate } = require('./telegram');
const { sendPush } = require('./push');

// ── Notification channel ────────────────────────────────────────────────────
// A user picks telegram, push, or both in Settings. This is the one place
// every reminder in this file routes through, so that choice is honoured
// everywhere instead of each call site deciding for itself.

async function notifyUser(userId, text, title = 'Core PA', data = null) {
  try {
    const row = await db.prepare(`SELECT notification_channel FROM users WHERE id = ?`).get(userId);
    const channel = row?.notification_channel || 'telegram';
    if (channel === 'telegram' || channel === 'both') sendMessage(text, userId);
    if (channel === 'push' || channel === 'both') sendPush(userId, title, text, data);
  } catch (err) {
    console.error('[scheduler] notifyUser failed for user', userId, '—', err.message);
  }
}

// ── Who gets pinged ───────────────────────────────────────────────────────────
// Users with SOME active channel — either Telegram linked or a push
// subscription on file. Everyone else still gets their data processed
// (baselines, recurring re-queues) — they just don't get messages.

async function linkedUsers() {
  return db.prepare(
    `SELECT DISTINCT u.id FROM users u
     LEFT JOIN push_subscriptions p ON p.user_id = u.id
     WHERE u.telegram_chat_id IS NOT NULL OR p.id IS NOT NULL`
  ).all();
}

async function allUsers() {
  return db.prepare(`SELECT id FROM users`).all();
}

// Per-user namespaced key for the shared `settings` table, so one user's
// "already alerted" flag never suppresses another user's alert.
function userKey(userId, key) {
  return `u${userId}_${key}`;
}

async function getFlag(userId, key) {
  const row = await db.prepare(`SELECT value FROM settings WHERE key = ?`).get(userKey(userId, key));
  return row ? row.value : null;
}

async function setFlag(userId, key, value) {
  await db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
  ).run(userKey(userId, key), value);
}

// ── Due reminders ─────────────────────────────────────────────────────────────

async function checkDueReminders() {
  const now = new Date().toISOString();

  // Join on users so an orphaned task (user deleted) never fires.
  const due = await db.prepare(
    `SELECT t.* FROM tasks t
     JOIN users u ON u.id = t.user_id
     WHERE t.status = 'open' AND t.remind_at IS NOT NULL AND t.remind_at <= ? AND t.reminded = 0`
  ).all(now);

  if (due.length) console.log(`[scheduler] ${due.length} task(s) due for reminder`);

  for (const task of due) {
    const priority = task.priority === 'high' ? '🔴 HIGH PRIORITY — ' : '';
    notifyUser(task.user_id, `⏰ ${priority}reminder: ${task.title}${task.notes ? `\n${task.notes}` : ''}`, 'Reminder', { taskId: task.id });

    const mins = await nextPingMinutes(task.user_id, task.priority, 0);
    const next = new Date(Date.now() + mins * 60 * 1000).toISOString();
    await db.prepare(`UPDATE tasks SET reminded = 1, ping_count = 0, next_ping_at = ? WHERE id = ?`)
      .run(next, task.id);
  }
}

// ── Escalating re-pings ───────────────────────────────────────────────────────

// Defaults if a user has never customised this in Settings.
const DEFAULT_PING_TIERS = {
  high:   [5, 15, 60],
  normal: [60],
  low:    [4320],
};

// Per-user override, stored as JSON on users.escalation_prefs, e.g.
// {"high":[10,30,90],"normal":[120],"low":[4320]}. Missing/invalid JSON
// falls back to the defaults above — never breaks reminders over a bad value.
async function getPingTiers(userId) {
  try {
    const row = await db.prepare(`SELECT escalation_prefs FROM users WHERE id = ?`).get(userId);
    if (!row?.escalation_prefs) return DEFAULT_PING_TIERS;
    const parsed = JSON.parse(row.escalation_prefs);
    return {
      high:   Array.isArray(parsed.high)   && parsed.high.length   ? parsed.high   : DEFAULT_PING_TIERS.high,
      normal: Array.isArray(parsed.normal) && parsed.normal.length ? parsed.normal : DEFAULT_PING_TIERS.normal,
      low:    Array.isArray(parsed.low)    && parsed.low.length    ? parsed.low    : DEFAULT_PING_TIERS.low,
    };
  } catch {
    return DEFAULT_PING_TIERS;
  }
}

async function nextPingMinutes(userId, priority, pingCount) {
  const tiers = await getPingTiers(userId);
  const steps = tiers[priority] || tiers.normal;
  return steps[Math.min(pingCount, steps.length - 1)];
}

// Shared "Xd Yh" / "Xh Ym" / "Xm" formatter for how long something has been
// sitting — used by both the stale-task nudge and the escalating pings, so
// pings can finally say *how overdue*, not just *that* it's overdue again.
function formatElapsedMinutes(minutesSince) {
  const days  = Math.floor(minutesSince / 1440);
  const hours = Math.floor((minutesSince % 1440) / 60);
  const mins  = Math.floor(minutesSince % 60);
  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

async function checkEscalatingPings() {
  const now = new Date();
  const due = await db.prepare(
    `SELECT t.* FROM tasks t
     JOIN users u ON u.id = t.user_id
     WHERE t.status = 'open' AND t.next_ping_at IS NOT NULL AND t.next_ping_at <= ?`
  ).all(now.toISOString());

  for (const task of due) {
    const priority = task.priority === 'high' ? '🔴 HIGH — ' : '';
    const pingCount = (task.ping_count || 0) + 1;
    const overdueFor = task.remind_at
      ? formatElapsedMinutes((now.getTime() - new Date(task.remind_at).getTime()) / 60000)
      : null;
    const context = overdueFor ? ` — ${overdueFor} overdue (nudge #${pingCount})` : ` (nudge #${pingCount})`;
    notifyUser(task.user_id, `🔁 ${priority}still open: ${task.title}${context}`, 'Still open', { taskId: task.id });

    const mins = await nextPingMinutes(task.user_id, task.priority, pingCount);
    const next = new Date(now.getTime() + mins * 60 * 1000).toISOString();

    await db.prepare(`UPDATE tasks SET ping_count = ?, next_ping_at = ? WHERE id = ?`)
      .run(pingCount, next, task.id);
  }
}

// ── Stale tasks ───────────────────────────────────────────────────────────────

async function checkStaleTasks() {
  const now = Date.now();

  const openTasks = await db.prepare(
    `SELECT t.* FROM tasks t
     JOIN users u ON u.id = t.user_id
     WHERE t.status = 'open'`
  ).all();

  for (const task of openTasks) {
    const lastTouched  = new Date(task.last_touched_at).getTime();
    const minutesSince = (now - lastTouched) / (1000 * 60);

    const threshold = (task.stale_minutes > 0)
      ? task.stale_minutes
      : ((task.stale_days || 3) * 1440);

    if (minutesSince >= threshold) {
      const elapsed = formatElapsedMinutes(minutesSince);

      const priority = task.priority === 'high' ? '🔴 ' : '';
      notifyUser(task.user_id, `👀 ${priority}this has been sitting for ${elapsed}: "${task.title}"`, "Sitting untouched", { taskId: task.id });

      await db.prepare(`UPDATE tasks SET last_touched_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), task.id);
    }
  }
}

// ── Recurring task re-queue ───────────────────────────────────────────────────

async function checkRecurringTasks() {
  const done = await db.prepare(
    `SELECT * FROM tasks WHERE status = 'done' AND recurring IS NOT NULL AND user_id IS NOT NULL`
  ).all();

  for (const task of done) {
    // "already re-queued?" must be scoped to the owner, or two users with a
    // task called "gym" would block each other's recurrence.
    const existing = await db.prepare(
      `SELECT id FROM tasks WHERE title = ? AND status = 'open' AND recurring = ? AND id != ? AND user_id = ?`
    ).get(task.title, task.recurring, task.id, task.user_id);

    if (!existing) {
      const next = nextRecurringDate(task.recurring);
      const now  = new Date().toISOString();
      const staleMins = task.stale_minutes || (task.stale_days || 3) * 1440;
      await db.prepare(
        `INSERT INTO tasks (title, notes, priority, stale_minutes, recurring, remind_at, reminded, last_touched_at, created_at, user_id)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
      ).run(task.title, task.notes, task.priority, staleMins, task.recurring, next, now, now, task.user_id);
    }
  }
}

// ── Recurring transaction detection (monthly, per user) ───────────────────────

async function detectRecurringTransactions() {
  for (const { id: userId } of await allUsers()) {
    try {
      // Month bucketing done in JS so it behaves the same on SQLite and Postgres.
      const rows = await db.prepare(`
        SELECT merchant, amount, category, COALESCE(imported_date, created_at) AS tx_date
        FROM finance_entries
        WHERE merchant IS NOT NULL AND merchant != '' AND type = 'expense' AND user_id = ?
      `).all(userId);

      const byMerchant = {};
      for (const r of rows) {
        const m = byMerchant[r.merchant] || (byMerchant[r.merchant] = { months: new Set(), sum: 0, n: 0, category: r.category });
        m.months.add(String(r.tx_date).slice(0, 7));
        m.sum += r.amount;
        m.n += 1;
      }

      const newlyDetected = [];
      const thisMonth = new Date().toISOString().slice(0, 7);

      for (const [merchant, m] of Object.entries(byMerchant)) {
        if (m.months.size < 2) continue;
        if (await getFlag(userId, `recurring_detected_${merchant}`)) continue;
        await setFlag(userId, `recurring_detected_${merchant}`, thisMonth);
        newlyDetected.push({ merchant, avg: m.sum / m.n, category: m.category });
      }

      if (newlyDetected.length > 0) {
        const lines = newlyDetected
          .map(r => `  • ${r.merchant} — ~R${r.avg.toFixed(0)}/mo (${r.category})`)
          .join('\n');
        notifyUser(
          userId,
          `🔁 spotted ${newlyDetected.length} recurring transaction${newlyDetected.length > 1 ? 's' : ''}:\n${lines}`,
          'Recurring transaction'
        );
      }
    } catch (err) {
      console.error('[scheduler] detectRecurringTransactions failed for user', userId, '—', err.message);
    }
  }
}

// ── Budget baselines (weekly, per user) ───────────────────────────────────────

async function updateBudgetBaselines() {
  const sixWeeksAgo = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 42);
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  })();

  for (const { id: userId } of await allUsers()) {
    try {
      const rows = await db.prepare(`
        SELECT category, amount, COALESCE(imported_date, created_at) AS tx_date
        FROM finance_entries
        WHERE type = 'expense' AND category != 'transfers' AND COALESCE(imported_date, created_at) >= ? AND user_id = ?
      `).all(sixWeeksAgo, userId);

      // bucket category × ISO week in JS
      const map = {};
      for (const row of rows) {
        const d = new Date(row.tx_date);
        const thursday = new Date(d);
        thursday.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 3);
        const yearStart = new Date(thursday.getFullYear(), 0, 1);
        const weekNum = Math.ceil(((thursday - yearStart) / 86400000 + 1) / 7);
        const weekKey = `${thursday.getFullYear()}-${String(weekNum).padStart(2, '0')}`;

        if (!map[row.category]) map[row.category] = {};
        map[row.category][weekKey] = (map[row.category][weekKey] || 0) + row.amount;
      }

      const now = new Date().toISOString();
      for (const [category, weeks] of Object.entries(map)) {
        const totals = Object.values(weeks);
        const avg = totals.reduce((s, v) => s + v, 0) / totals.length;
        await db.prepare(`
          INSERT INTO budget_baselines (user_id, category, avg_weekly, sample_weeks, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (user_id, category) DO UPDATE SET
            avg_weekly   = EXCLUDED.avg_weekly,
            sample_weeks = EXCLUDED.sample_weeks,
            updated_at   = EXCLUDED.updated_at
        `).run(userId, category, avg, totals.length, now);
      }
    } catch (err) {
      console.error('[scheduler] updateBudgetBaselines failed for user', userId, '—', err.message);
    }
  }

  console.log('[scheduler] budget baselines updated');
}

// ── Budget alerts (daily, per user) ───────────────────────────────────────────

async function checkBudgetAlerts() {
  const weekStart = (() => {
    const d = new Date();
    const day = d.getDay() || 7; // Sunday (0) -> 7, so Monday is day 1
    d.setDate(d.getDate() - day + 1);
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  })();

  const weekKey = new Date().toISOString().slice(0, 7) + '-W' + getWeekNumber(new Date());

  for (const { id: userId } of await linkedUsers()) {
    try {
      const baselines = await db.prepare(
        `SELECT * FROM budget_baselines WHERE sample_weeks >= 2 AND user_id = ?`
      ).all(userId);
      if (!baselines.length) continue;

      const thisWeek = await db.prepare(`
        SELECT category, SUM(amount) AS total
        FROM finance_entries
        WHERE type = 'expense' AND category != 'transfers' AND COALESCE(imported_date, created_at) >= ? AND user_id = ?
        GROUP BY category
      `).all(weekStart, userId);

      for (const row of thisWeek) {
        const baseline = baselines.find(b => b.category === row.category);
        if (!baseline || baseline.avg_weekly === 0) continue;

        const ratio = row.total / baseline.avg_weekly;
        if (ratio < 1.5) continue;

        if (await getFlag(userId, `budget_alert_${row.category}_${weekKey}`)) continue;

        const pct      = Math.round((ratio - 1) * 100);
        const daysLeft = Math.max(0, 7 - new Date().getDay());
        notifyUser(
          userId,
          `💸 heads up — you've spent R${row.total.toFixed(0)} on ${row.category} this week, ` +
          `that's ${pct}% over your usual R${baseline.avg_weekly.toFixed(0)}. ` +
          `still ${daysLeft} day${daysLeft === 1 ? '' : 's'} left in the week.`,
          'Budget alert'
        );

        await setFlag(userId, `budget_alert_${row.category}_${weekKey}`, new Date().toISOString());
      }
    } catch (err) {
      console.error('[scheduler] checkBudgetAlerts failed for user', userId, '—', err.message);
    }
  }
}

function getWeekNumber(date) {
  const d      = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

// ── Morning brief (daily 07:00 SAST = 05:00 UTC, opt-in per user) ────────────
//
// Sends a concise good-morning message to every user who has:
//   1. morning_brief_enabled = 1
//   2. at least one notification channel configured (Telegram or push)
//
// Structure:
//   • Greeting + date
//   • Weather (if available)
//   • Top tasks (up to 3 high-priority, then next 2 normal)
//   • Finance net this month
//   • AI one-liner framing the day (non-blocking — skipped on failure)
//
async function sendMorningBrief() {
  const cal    = require('./calendar');
  const SAST   = 'Africa/Johannesburg';
  const local  = cal.utcToLocal(Date.now(), SAST);
  const today  = local.date; // YYYY-MM-DD in SAST
  const dow    = new Date(today + 'T00:00:00').toLocaleDateString('en-ZA', { weekday: 'long', timeZone: SAST });

  // Only users who opted in
  const users = await db.prepare(
    `SELECT DISTINCT u.id FROM users u
     LEFT JOIN push_subscriptions p ON p.user_id = u.id
     WHERE u.morning_brief_enabled = 1
       AND (u.telegram_chat_id IS NOT NULL OR p.id IS NOT NULL)`
  ).all();

  if (!users.length) return;
  console.log(`[scheduler] sending morning brief to ${users.length} user(s)`);

  for (const { id: userId } of users) {
    try {
      // ── Tasks ──────────────────────────────────────────────────────────────
      const open = await db.prepare(
        `SELECT title, priority, remind_at, due_at FROM tasks
         WHERE status = 'open' AND user_id = ?
         ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 ELSE 1 END ASC,
                  COALESCE(due_at, remind_at) ASC NULLS LAST
         LIMIT 10`
      ).all(userId);

      // Up to 3 high-priority + 2 others
      const high   = open.filter(t => t.priority === 'high').slice(0, 3);
      const others = open.filter(t => t.priority !== 'high').slice(0, 2);
      const shown  = [...high, ...others];

      // ── Finance ────────────────────────────────────────────────────────────
      const monthStart = today.slice(0, 7) + '-01';
      const finRows = await db.prepare(
        `SELECT type, SUM(amount) AS total FROM finance_entries
         WHERE COALESCE(imported_date, created_at) >= ? AND user_id = ? AND category != 'transfers'
         GROUP BY type`
      ).all(monthStart, userId);
      const income  = finRows.find(r => r.type === 'income')?.total  || 0;
      const expense = finRows.find(r => r.type === 'expense')?.total || 0;
      const net     = income - expense;
      const netStr  = `${net >= 0 ? '+' : '−'}R${Math.abs(net).toFixed(0)}`;

      // ── Weather ────────────────────────────────────────────────────────────
      let weatherLine = '';
      try {
        const w = await require('./weather').getUserWeather(userId);
        if (w) weatherLine = `🌤 ${w.temp}°C, ${w.condition}${w.nextRainAt ? ` — rain around ${w.nextRainAt}` : ''}\n`;
      } catch { /* weather is best-effort */ }

      // ── Task lines ─────────────────────────────────────────────────────────
      let taskBlock = '';
      if (shown.length) {
        const lines = shown.map(t => {
          const flag = t.priority === 'high' ? '🔴' : '🟡';
          const when = t.due_at || t.remind_at;
          const timeStr = when ? ` · ${new Date(when).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', timeZone: SAST })}` : '';
          return `${flag} ${t.title}${timeStr}`;
        }).join('\n');
        taskBlock = `\n📋 on your plate:\n${lines}\n`;
      } else {
        taskBlock = `\n📋 no open tasks — rare energy 👀\n`;
      }

      // ── AI one-liner ───────────────────────────────────────────────────────
      // Non-blocking: if AI fails for any reason, skip it gracefully.
      let aiLine = '';
      try {
        const { getProviderPlan, fetchWithProviderFallback } = require('./ai-providers');
        const providers = getProviderPlan();
        if (providers.length && open.length) {
          const taskSummary = shown.map(t => `- [${t.priority}] ${t.title}`).join('\n');
          const prompt = `Today is ${dow}, ${today}. Net this month: ${netStr}. Open tasks:\n${taskSummary}\n\nWrite ONE short sentence (max 12 words) to frame this person's day — not generic, specific to what they're actually facing. No emoji, no greeting.`;
          const msgs = [
            { role: 'system', content: 'You are a concise personal assistant. Reply with exactly one short, punchy sentence.' },
            { role: 'user', content: prompt }
          ];
          for (const provider of providers) {
            try {
              const res = await fetchWithProviderFallback(provider, msgs, 60);
              const data = await res.json();
              const raw = data.choices?.[0]?.message?.content?.trim() || '';
              if (raw) { aiLine = `\n💬 ${raw}\n`; break; }
            } catch { /* try next provider */ }
          }
        }
      } catch { /* AI is best-effort, never block the brief */ }

      // ── Assemble and send ──────────────────────────────────────────────────
      const message =
        `☀️ morning, ${dow}.\n` +
        weatherLine +
        taskBlock +
        `💰 net this month: ${netStr}\n` +
        aiLine;

      await notifyUser(userId, message.trim(), 'Morning brief');

      // ── Self-reflection engine (owner-only, non-blocking) ──────────────────
      const ownerRow = await db.prepare(`SELECT is_owner FROM users WHERE id = ?`).get(userId);
      if (ownerRow?.is_owner === true || ownerRow?.is_owner === 1) {
        checkAndSendObservation(userId).catch(e => console.error('[scheduler] reflection failed:', e.message));
      }

    } catch (err) {
      console.error(`[scheduler] morning brief failed for user ${userId}:`, err.message);
    }
  }
}

// ── Weekly plan draft (Sundays 16:00 UTC, owner-only) ────────────────────────
//
// Fires every Sunday and sends the owner a structured look at the week ahead:
// their life anchors, top open tasks, and a single AI-generated framing line.
// Entirely non-blocking — all failures are console.error'd and never re-thrown.

async function sendWeeklyPlan() {
  try {
    const isOwnerVal = db.USE_PG ? 'TRUE' : '1';
    const owner = await db.prepare(
      `SELECT id, telegram_chat_id FROM users WHERE is_owner = ${isOwnerVal} LIMIT 1`
    ).get();

    if (!owner || !owner.telegram_chat_id) return;

    // ── Anchors ──────────────────────────────────────────────────────────────
    const anchors = await db.prepare(
      `SELECT * FROM life_anchors WHERE user_id = ? ORDER BY day_of_week ASC, date ASC`
    ).all(owner.id);

    // ── Top 5 open tasks ─────────────────────────────────────────────────────
    const tasks = await db.prepare(
      `SELECT title, priority FROM tasks
       WHERE user_id = ? AND status = 'open'
       ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 ELSE 1 END ASC
       LIMIT 5`
    ).all(owner.id);

    // ── Week range: today is Sunday; Mon = +1, Sun = +7 ─────────────────────
    const today = new Date();
    const mon   = new Date(today); mon.setDate(today.getDate() + 1);
    const sun   = new Date(today); sun.setDate(today.getDate() + 7);
    const fmtOpts = { weekday: 'short', day: 'numeric' };
    const monStr  = mon.toLocaleDateString('en-ZA', fmtOpts);
    const sunStr  = sun.toLocaleDateString('en-ZA', fmtOpts);

    // ── Anchor lines ─────────────────────────────────────────────────────────
    const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const anchorLines = anchors.map(a => {
      const label = a.anchor_type === 'one_off' ? a.date : DOW_NAMES[a.day_of_week] || '?';
      const time  = (a.start_time && a.end_time) ? ` ${a.start_time}–${a.end_time}` : '';
      return `  ${label}${time} — ${a.title}`;
    }).join('\n');

    // ── Task lines ───────────────────────────────────────────────────────────
    const taskLines = tasks.map(t => {
      const dot = t.priority === 'high' ? '🔴' : t.priority === 'low' ? '🟢' : '🟡';
      return `  ${dot} ${t.title}`;
    }).join('\n');

    // ── AI framing line (non-blocking) ───────────────────────────────────────
    let aiLine = '';
    try {
      const { getProviderPlan, fetchWithProviderFallback } = require('./ai-providers');
      const providers = getProviderPlan();
      if (providers.length) {
        const context = [
          anchors.length ? 'Anchors: ' + anchors.map(a => a.title).join(', ') : '',
          tasks.length   ? 'Tasks: '   + tasks.map(t => `[${t.priority}] ${t.title}`).join(', ') : '',
        ].filter(Boolean).join('. ');
        const msgs = [
          { role: 'system', content: 'You are a concise personal assistant. Reply with exactly one short sentence, max 15 words. No emoji, no greeting.' },
          { role: 'user',   content: `Week ahead (${monStr} to ${sunStr}). ${context}. Give one sentence framing the week.` },
        ];
        for (const provider of providers) {
          try {
            const res  = await fetchWithProviderFallback(provider, msgs, 60);
            const data = await res.json();
            const raw  = data.choices?.[0]?.message?.content?.trim() || '';
            if (raw) { aiLine = raw; break; }
          } catch { /* try next */ }
        }
      }
    } catch { /* AI is best-effort */ }

    // ── Assemble message ─────────────────────────────────────────────────────
    const message =
      `📅 week ahead — ${monStr} to ${sunStr}\n\n` +
      (anchors.length ? `ANCHORED:\n${anchorLines}\n\n` : '') +
      `OPEN TASKS (top 5):\n${taskLines || '  (none)'}` +
      (aiLine ? `\n\n💡 ${aiLine}` : '');

    await sendMessage(message, owner.id);

  } catch (err) {
    console.error('[scheduler] sendWeeklyPlan failed:', err.message);
  }
}

// ── Self-reflection engine (hooked into morning brief, owner-only) ─────────────
//
// Runs three observations against the owner's data and sends the highest-
// priority applicable one. Non-blocking — all failures are console.error'd.

async function checkAndSendObservation(userId) {
  try {
    let obsA = null;
    let obsB = null;
    let obsC = null;

    // ── Observation C: stale high-priority tasks (priority: highest) ─────────
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const staleTasks = await db.prepare(
      `SELECT title FROM tasks
       WHERE user_id = ? AND status = 'open' AND priority = 'high' AND last_touched_at <= ?`
    ).all(userId, sevenDaysAgo.toISOString());

    if (staleTasks.length) {
      const titles = staleTasks.map(t => t.title).join(', ');
      obsC = `🪞 Vis noticed: ${staleTasks.length} high-priority task(s) haven't been touched in 7+ days — ${titles}`;
    }

    // ── Observation B: 3 consecutive months net-negative finances ────────────
    if (!obsC) {
      const now = new Date();
      let allNegative = true;
      let monthsChecked = 0;

      for (let i = 1; i <= 3; i++) {
        const mStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const mEnd   = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
        const rows   = await db.prepare(
          `SELECT type, SUM(amount) AS total
           FROM finance_entries
           WHERE user_id = ? AND COALESCE(imported_date, created_at) >= ? AND COALESCE(imported_date, created_at) < ?
             AND category != 'transfers'
           GROUP BY type`
        ).all(userId, mStart.toISOString(), mEnd.toISOString());

        if (!rows.length) { allNegative = false; break; }

        const income  = rows.find(r => r.type === 'income')?.total  || 0;
        const expense = rows.find(r => r.type === 'expense')?.total || 0;
        if (income - expense >= 0) { allNegative = false; break; }
        monthsChecked++;
      }

      if (allNegative && monthsChecked === 3) {
        obsB = `🪞 Vis noticed: your finances have been net-negative three months in a row — might be worth a look.`;
      }
    }

    // ── Observation A: low task completion rate last 30 days ─────────────────
    if (!obsC && !obsB) {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const isoThirty = thirtyDaysAgo.toISOString();

      const totalRow = await db.prepare(
        `SELECT COUNT(*) AS total FROM tasks WHERE user_id = ? AND created_at >= ?`
      ).get(userId, isoThirty);
      const doneRow  = await db.prepare(
        `SELECT COUNT(*) AS done FROM tasks WHERE user_id = ? AND status = 'done' AND created_at >= ?`
      ).get(userId, isoThirty);

      const total = totalRow?.total || 0;
      const done  = doneRow?.done   || 0;

      if (total >= 5 && done / total < 0.30) {
        obsA = `🪞 Vis noticed: you've completed less than 30% of tasks created in the last 30 days — want to clear the backlog together?`;
      }
    }

    // ── Send highest-priority observation: C > B > A ─────────────────────────
    const obs = obsC || obsB || obsA;
    if (obs) {
      await notifyUser(userId, obs);
    }

  } catch (err) {
    console.error('[scheduler] checkAndSendObservation failed for user', userId, '—', err.message);
  }
}

// ── Weekly spend digest (Sundays, per user) ───────────────────────────────────

async function sendWeeklyDigest() {
  const weekStart = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 6);
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  })();

  for (const { id: userId } of await linkedUsers()) {
    try {
      const rows = await db.prepare(`
        SELECT category, SUM(amount) AS total
        FROM finance_entries
        WHERE type = 'expense' AND category != 'transfers' AND COALESCE(imported_date, created_at) >= ? AND user_id = ?
        GROUP BY category ORDER BY total DESC
      `).all(weekStart, userId);

      if (!rows.length) {
        notifyUser(userId, '📊 weekly digest: no spend logged this week. living rent-free 👀', 'Weekly digest');
        continue;
      }

      const totalSpend = rows.reduce((s, r) => s + r.total, 0);
      const incomeRow  = await db.prepare(`
        SELECT SUM(amount) AS total FROM finance_entries
        WHERE type = 'income' AND category != 'transfers' AND COALESCE(imported_date, created_at) >= ? AND user_id = ?
      `).get(weekStart, userId);
      const income = incomeRow?.total || 0;

      const net     = income - totalSpend;
      const netSign = net >= 0 ? '+' : '';

      const linePromises = rows.map(async r => {
        const bl = await db.prepare(
          `SELECT avg_weekly FROM budget_baselines WHERE category = ? AND user_id = ?`
        ).get(r.category, userId);
        const vs = bl ? ` (avg R${bl.avg_weekly.toFixed(0)})` : '';
        return `  ${r.category}: R${r.total.toFixed(0)}${vs}`;
      });
      const lines = (await Promise.all(linePromises)).join('\n');

      notifyUser(
        userId,
        `📊 week in review\n\n` +
        `spent: R${totalSpend.toFixed(0)}\n` +
        (income > 0 ? `earned: R${income.toFixed(0)}\nnet: ${netSign}R${net.toFixed(0)}\n\n` : '\n') +
        `breakdown:\n${lines}`,
        'Weekly digest'
      );
    } catch (err) {
      console.error('[scheduler] sendWeeklyDigest failed for user', userId, '—', err.message);
    }
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

// ── Evening check-in (daily 20:00 SAST = 18:00 UTC, owner only) ────────────
// A gentle daily check-in from Vis. Rotates through questions covering
// eating, meds, energy, mood, and the day's intentions.

const CHECKIN_QUESTIONS = [
  "hey — how'd today actually go? did you eat properly and drink enough water?",
  "quick check-in: did you take your meds today? and how's your energy right now?",
  "end of day: what's one thing you did today that you're okay with? also — did you eat?",
  "checking in. how are you feeling? anything still on your mind that you want to put somewhere before you wind down?",
  "did today go the way you planned? and did you actually rest at some point?",
  "late evening check-in: how's your stomach, your head, and your mood? be honest.",
  "what's one thing you want to do differently tomorrow? also — did you eat dinner?",
];

async function sendEveningCheckin() {
  try {
    const isOwnerVal = db.USE_PG ? 'TRUE' : '1';
    const owners = await db.prepare(`SELECT id FROM users WHERE is_owner = ${isOwnerVal}`).all();
    if (!owners.length) return;

    const dayOfYear = Math.floor(Date.now() / 86400000);
    const question = CHECKIN_QUESTIONS[dayOfYear % CHECKIN_QUESTIONS.length];

    for (const { id: userId } of owners) {
      try {
        await notifyUser(userId, `🌙 ${question}`, 'Vis · evening check-in');
      } catch (err) {
        console.error(`[scheduler] evening check-in failed for user ${userId}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[scheduler] sendEveningCheckin failed:', err.message);
  }
}

// ── Missed plan task follow-ups (every 30 min, owner only) ────────────────────
// When a plan-sourced task's remind_at was 30–90 min ago and it's still open,
// send a single follow-up. Deduped via settings table flags.
async function checkMissedPlanTasks() {
  try {
    const isOwnerVal = db.USE_PG ? 'TRUE' : '1';
    const owners = await db.prepare(`SELECT id FROM users WHERE is_owner = ${isOwnerVal}`).all();
    if (!owners.length) return;

    const now = new Date();
    const ninetyMinsAgo = new Date(now.getTime() - 90 * 60 * 1000).toISOString();
    const thirtyMinsAgo = new Date(now.getTime() - 30 * 60 * 1000).toISOString();

    for (const { id: userId } of owners) {
      try {
        const missed = await db.prepare(
          `SELECT * FROM tasks
           WHERE user_id = ?
             AND status = 'open'
             AND source = 'plan'
             AND remind_at IS NOT NULL
             AND remind_at >= ?
             AND remind_at <= ?
           ORDER BY remind_at ASC
           LIMIT 3`
        ).all(userId, ninetyMinsAgo, thirtyMinsAgo);

        for (const task of missed) {
          const flagKey = `missed_ping_${task.id}`;
          const alreadySent = await getFlag(userId, flagKey);
          if (alreadySent) continue;

          const minutesAgo = Math.round((now.getTime() - new Date(task.remind_at).getTime()) / 60000);
          const msg = `hey — "${task.title}" was supposed to happen ${minutesAgo} minutes ago. did you do it? if not, want me to reschedule it?`;
          await notifyUser(userId, msg, 'Vis · missed task');
          await setFlag(userId, flagKey, now.toISOString());
        }
      } catch (err) {
        console.error(`[scheduler] checkMissedPlanTasks failed for user ${userId}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[scheduler] checkMissedPlanTasks failed:', err.message);
  }
}

function startScheduler() {
  cron.schedule('*/5 * * * *', checkDueReminders);
  cron.schedule('*/5 * * * *', checkEscalatingPings);
  cron.schedule('*/5 * * * *', checkStaleTasks);
  cron.schedule('*/30 * * * *', checkMissedPlanTasks);
  cron.schedule('0 0 * * *',  checkRecurringTasks);
  cron.schedule('0 5 * * *',  sendMorningBrief);      // 07:00 SAST = 05:00 UTC
  cron.schedule('0 10 * * *', checkBudgetAlerts);
  cron.schedule('0 3 * * 1',  updateBudgetBaselines);
  cron.schedule('0 20 * * 0', sendWeeklyDigest);
  cron.schedule('0 16 * * 0', sendWeeklyPlan);
  cron.schedule('0 2 1 * *',  detectRecurringTransactions);
  cron.schedule('0 18 * * *', sendEveningCheckin);    // 20:00 SAST = 18:00 UTC
  require('./task-nudges').register(cron, notifyUser, nextPingMinutes);

  console.log('[scheduler] running — reminders+stale every 5min, morning brief 07:00 SAST, evening check-in 20:00 SAST, budget/digest weekly');
}

module.exports = {
  startScheduler,
  checkDueReminders,
  checkEscalatingPings,
  checkStaleTasks,
  checkRecurringTasks,
  detectRecurringTransactions,
  updateBudgetBaselines,
  checkBudgetAlerts,
  sendWeeklyDigest,
  sendWeeklyPlan,
  checkAndSendObservation,
  sendMorningBrief,
  sendEveningCheckin,
  checkMissedPlanTasks,
};