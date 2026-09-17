const cron = require('node-cron');
const db = require('./db');
const { sendMessage, nextRecurringDate } = require('./telegram');
const { sendPush } = require('./push');

// ── Notification channel ────────────────────────────────────────────────────
// A user picks telegram, push, or both in Settings. This is the one place
// every reminder in this file routes through, so that choice is honoured
// everywhere instead of each call site deciding for itself.

async function notifyUser(userId, text, title = 'Core PA') {
  try {
    const row = await db.prepare(`SELECT notification_channel FROM users WHERE id = ?`).get(userId);
    const channel = row?.notification_channel || 'telegram';
    if (channel === 'telegram' || channel === 'both') sendMessage(text, userId);
    if (channel === 'push' || channel === 'both') sendPush(userId, title, text);
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
    notifyUser(task.user_id, `⏰ ${priority}reminder: ${task.title}${task.notes ? `\n${task.notes}` : ''}`, 'Reminder');

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

async function checkEscalatingPings() {
  const now = new Date();
  const due = await db.prepare(
    `SELECT t.* FROM tasks t
     JOIN users u ON u.id = t.user_id
     WHERE t.status = 'open' AND t.next_ping_at IS NOT NULL AND t.next_ping_at <= ?`
  ).all(now.toISOString());

  for (const task of due) {
    const priority = task.priority === 'high' ? '🔴 HIGH — ' : '';
    notifyUser(task.user_id, `🔁 ${priority}still open: ${task.title}`, 'Still open');

    const pingCount = (task.ping_count || 0) + 1;
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
      const days    = Math.floor(minutesSince / 1440);
      const hours   = Math.floor((minutesSince % 1440) / 60);
      const mins    = Math.floor(minutesSince % 60);
      const elapsed = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

      const priority = task.priority === 'high' ? '🔴 ' : '';
      notifyUser(task.user_id, `👀 ${priority}this has been sitting for ${elapsed}: "${task.title}"`, "Sitting untouched");

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
        WHERE type = 'expense' AND COALESCE(imported_date, created_at) >= ? AND user_id = ?
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
        WHERE type = 'expense' AND COALESCE(imported_date, created_at) >= ? AND user_id = ?
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
        WHERE type = 'expense' AND COALESCE(imported_date, created_at) >= ? AND user_id = ?
        GROUP BY category ORDER BY total DESC
      `).all(weekStart, userId);

      if (!rows.length) {
        notifyUser(userId, '📊 weekly digest: no spend logged this week. living rent-free 👀', 'Weekly digest');
        continue;
      }

      const totalSpend = rows.reduce((s, r) => s + r.total, 0);
      const incomeRow  = await db.prepare(`
        SELECT SUM(amount) AS total FROM finance_entries
        WHERE type = 'income' AND COALESCE(imported_date, created_at) >= ? AND user_id = ?
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

function startScheduler() {
  cron.schedule('*/5 * * * *', checkDueReminders);
  cron.schedule('*/5 * * * *', checkEscalatingPings);
  cron.schedule('*/5 * * * *', checkStaleTasks);
  cron.schedule('0 0 * * *',  checkRecurringTasks);
  cron.schedule('0 10 * * *', checkBudgetAlerts);
  cron.schedule('0 3 * * 1',  updateBudgetBaselines);
  cron.schedule('0 20 * * 0', sendWeeklyDigest);
  cron.schedule('0 2 1 * *',  detectRecurringTransactions);

  console.log('[scheduler] running — reminders+stale every 5min, recurring daily, budget/digest weekly');
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
};