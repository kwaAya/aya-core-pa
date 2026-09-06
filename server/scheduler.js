const cron = require('node-cron');
const db = require('./db');
const { sendMessage, nextRecurringDate } = require('./telegram');

// ─── Existing: due reminders ──────────────────────────────────────────────────

function checkDueReminders() {
  const now = new Date().toISOString();
  const due = db.prepare(
    `SELECT * FROM tasks WHERE status = 'open' AND remind_at IS NOT NULL AND remind_at <= ? AND reminded = 0`
  ).all(now);

  for (const task of due) {
    const priority = task.priority === 'high' ? '🔴 HIGH PRIORITY — ' : '';
    sendMessage(`⏰ ${priority}reminder: ${task.title}${task.notes ? `\n${task.notes}` : ''}`);
    db.prepare(`UPDATE tasks SET reminded = 1 WHERE id = ?`).run(task.id);
  }
}

// ─── Existing: stale tasks ────────────────────────────────────────────────────

function checkStaleTasks() {
  const openTasks = db.prepare(`SELECT * FROM tasks WHERE status = 'open'`).all();
  const now = Date.now();

  for (const task of openTasks) {
    const lastTouched = new Date(task.last_touched_at).getTime();
    const daysSince = (now - lastTouched) / (1000 * 60 * 60 * 24);

    if (daysSince >= task.stale_days) {
      const priority = task.priority === 'high' ? '🔴 ' : '';
      sendMessage(`👀 ${priority}this has been sitting for ${Math.floor(daysSince)} day(s): "${task.title}"`);
      db.prepare(`UPDATE tasks SET last_touched_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), task.id);
    }
  }
}

// ─── Existing: recurring task re-queue ───────────────────────────────────────

function checkRecurringTasks() {
  const done = db.prepare(
    `SELECT * FROM tasks WHERE status = 'done' AND recurring IS NOT NULL`
  ).all();

  for (const task of done) {
    const existing = db.prepare(
      `SELECT id FROM tasks WHERE title = ? AND status = 'open' AND recurring = ? AND id != ?`
    ).get(task.title, task.recurring, task.id);

    if (!existing) {
      const next = nextRecurringDate(task.recurring);
      const now  = new Date().toISOString();
      db.prepare(
        `INSERT INTO tasks (title, notes, priority, stale_days, recurring, remind_at, reminded, last_touched_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
      ).run(task.title, task.notes, task.priority, task.stale_days, task.recurring, next, now, now);
    }
  }
}

// ─── NEW: recurring transaction detection ────────────────────────────────────
// Runs monthly. Finds merchants that appear in 2+ distinct calendar months
// and flags them as recurring so they show up distinctly in the UI.

function detectRecurringTransactions() {
  // find merchants with entries in at least 2 different months
  const candidates = db.prepare(`
    SELECT merchant,
           COUNT(DISTINCT strftime('%Y-%m', COALESCE(imported_date, created_at))) AS month_count,
           AVG(amount) AS avg_amount,
           category
    FROM finance_entries
    WHERE merchant IS NOT NULL AND merchant != '' AND type = 'expense'
    GROUP BY merchant
    HAVING month_count >= 2
  `).all();

  if (!candidates.length) return;

  // upsert into merchant_category_map with a 'recurring' hint in the note
  // and notify if any new ones were just detected this month
  const thisMonth = new Date().toISOString().slice(0, 7);
  const newlyDetected = [];

  for (const c of candidates) {
    // check if we already knew about this one
    const known = db.prepare(
      `SELECT value FROM settings WHERE key = ?`
    ).get(`recurring_detected_${c.merchant}`);

    if (!known) {
      db.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run(`recurring_detected_${c.merchant}`, thisMonth);
      newlyDetected.push({ merchant: c.merchant, avg: c.avg_amount, category: c.category });
    }
  }

  if (newlyDetected.length > 0) {
    const lines = newlyDetected
      .map(r => `  • ${r.merchant} — ~R${r.avg.toFixed(0)}/mo (${r.category})`)
      .join('\n');
    sendMessage(`🔁 spotted ${newlyDetected.length} recurring transaction${newlyDetected.length > 1 ? 's' : ''}:\n${lines}`);
  }
}

// ─── NEW: budget baselines update ────────────────────────────────────────────
// Runs weekly. Updates rolling average weekly spend per category.
// Used by budget alerts to know what "normal" looks like.

function updateBudgetBaselines() {
  const sixWeeksAgo = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 42);
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  })();

  // get weekly totals per category over the last 6 weeks
  const rows = db.prepare(`
    SELECT
      category,
      strftime('%Y-%W', COALESCE(imported_date, created_at)) AS week,
      SUM(amount) AS total
    FROM finance_entries
    WHERE type = 'expense'
      AND COALESCE(imported_date, created_at) >= ?
    GROUP BY category, week
  `).all(sixWeeksAgo);

  // group by category and average the weekly totals
  const map = {};
  for (const row of rows) {
    if (!map[row.category]) map[row.category] = [];
    map[row.category].push(row.total);
  }

  const now = new Date().toISOString();
  for (const [category, weeks] of Object.entries(map)) {
    const avg = weeks.reduce((s, v) => s + v, 0) / weeks.length;
    db.prepare(`
      INSERT INTO budget_baselines (category, avg_weekly, sample_weeks, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(category) DO UPDATE SET
        avg_weekly   = excluded.avg_weekly,
        sample_weeks = excluded.sample_weeks,
        updated_at   = excluded.updated_at
    `).run(category, avg, weeks.length, now);
  }

  console.log('[scheduler] budget baselines updated for', Object.keys(map).length, 'categories');
}

// ─── NEW: budget alerts ───────────────────────────────────────────────────────
// Runs daily. Checks if current week's spend in any category is significantly
// over the rolling average. Only fires once per week per category.

function checkBudgetAlerts() {
  const baselines = db.prepare(`SELECT * FROM budget_baselines WHERE sample_weeks >= 2`).all();
  if (!baselines.length) return; // not enough history yet

  const weekStart = (() => {
    const d = new Date();
    d.setDate(d.getDate() - d.getDay());
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  })();

  const thisWeek = db.prepare(`
    SELECT category, SUM(amount) AS total
    FROM finance_entries
    WHERE type = 'expense' AND COALESCE(imported_date, created_at) >= ?
    GROUP BY category
  `).all(weekStart);

  const weekKey = new Date().toISOString().slice(0, 10).slice(0, 7) +
    '-W' + getWeekNumber(new Date());

  for (const row of thisWeek) {
    const baseline = baselines.find(b => b.category === row.category);
    if (!baseline || baseline.avg_weekly === 0) continue;

    const ratio = row.total / baseline.avg_weekly;
    if (ratio < 1.5) continue; // only alert at 150%+ of average

    // check we haven't already alerted this week for this category
    const alreadyAlerted = db.prepare(
      `SELECT value FROM settings WHERE key = ?`
    ).get(`budget_alert_${row.category}_${weekKey}`);

    if (alreadyAlerted) continue;

    const pct = Math.round((ratio - 1) * 100);
    sendMessage(
      `💸 heads up — you've spent R${row.total.toFixed(0)} on ${row.category} this week, ` +
      `that's ${pct}% over your usual R${baseline.avg_weekly.toFixed(0)}. ` +
      `still ${Math.max(0, 7 - new Date().getDay())} day${Math.max(0,7-new Date().getDay())===1?'':'s'} left in the week.`
    );

    // record so we don't double-alert
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(`budget_alert_${row.category}_${weekKey}`, new Date().toISOString());
  }
}

function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

// ─── NEW: weekly spend digest ─────────────────────────────────────────────────
// Fires every Sunday at 8pm. Summarises the week's spend by category.

function sendWeeklyDigest() {
  const weekStart = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 6); // last 7 days
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  })();

  const rows = db.prepare(`
    SELECT category, SUM(amount) AS total, COUNT(*) AS txn_count
    FROM finance_entries
    WHERE type = 'expense'
      AND COALESCE(imported_date, created_at) >= ?
    GROUP BY category
    ORDER BY total DESC
  `).all(weekStart);

  if (!rows.length) {
    sendMessage(`📊 weekly digest: no spend logged this week. living rent-free 👀`);
    return;
  }

  const totalSpend = rows.reduce((s, r) => s + r.total, 0);
  const lines = rows.map(r => {
    const baseline = db.prepare(`SELECT avg_weekly FROM budget_baselines WHERE category = ?`).get(r.category);
    const vs = baseline ? ` (avg R${baseline.avg_weekly.toFixed(0)})` : '';
    return `  ${r.category}: R${r.total.toFixed(0)}${vs}`;
  }).join('\n');

  // check income this week too
  const income = db.prepare(`
    SELECT SUM(amount) AS total FROM finance_entries
    WHERE type = 'income' AND COALESCE(imported_date, created_at) >= ?
  `).get(weekStart)?.total || 0;

  const net = income - totalSpend;
  const netSign = net >= 0 ? '+' : '';

  sendMessage(
    `📊 week in review\n\n` +
    `spent: R${totalSpend.toFixed(0)}\n` +
    (income > 0 ? `earned: R${income.toFixed(0)}\nnet: ${netSign}R${net.toFixed(0)}\n\n` : '\n') +
    `breakdown:\n${lines}`
  );
}

// ─── Start ────────────────────────────────────────────────────────────────────

function startScheduler() {
  // every 5 minutes — due reminders
  cron.schedule('*/5 * * * *', checkDueReminders);

  // every day at 9am — stale task nudges
  cron.schedule('0 9 * * *', checkStaleTasks);

  // every day at midnight — re-queue recurring tasks
  cron.schedule('0 0 * * *', checkRecurringTasks);

  // every day at 10am — budget alerts (needs baselines to exist first)
  cron.schedule('0 10 * * *', checkBudgetAlerts);

  // every Monday at 3am — update rolling spend baselines
  cron.schedule('0 3 * * 1', updateBudgetBaselines);

  // every Sunday at 8pm — weekly spend digest
  cron.schedule('0 20 * * 0', sendWeeklyDigest);

  // 1st of every month at 2am — detect recurring transactions
  cron.schedule('0 2 1 * *', detectRecurringTransactions);

  console.log('[scheduler] running — reminders every 5min, stale+recurring daily, budget alerts daily, weekly digest Sundays');
}

module.exports = {
  startScheduler,
  checkDueReminders,
  checkStaleTasks,
  checkRecurringTasks,
  detectRecurringTransactions,
  updateBudgetBaselines,
  checkBudgetAlerts,
  sendWeeklyDigest,
};
