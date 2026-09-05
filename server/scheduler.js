const cron = require('node-cron');
const db = require('./db');
const { sendMessage, nextRecurringDate } = require('./telegram');

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

function checkStaleTasks() {
  const openTasks = db.prepare(`SELECT * FROM tasks WHERE status = 'open'`).all();
  const now = Date.now();

  for (const task of openTasks) {
    const lastTouched = new Date(task.last_touched_at).getTime();
    const daysSince = (now - lastTouched) / (1000 * 60 * 60 * 24);

    if (daysSince >= task.stale_days) {
      const priority = task.priority === 'high' ? '🔴 ' : '';
      sendMessage(`👀 ${priority}this has been sitting for ${Math.floor(daysSince)} day(s): "${task.title}"`);
      // push forward so it doesn't nudge again until another full window
      db.prepare(`UPDATE tasks SET last_touched_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), task.id);
    }
  }
}

function checkRecurringTasks() {
  // find done recurring tasks that haven't been re-queued
  const done = db.prepare(
    `SELECT * FROM tasks WHERE status = 'done' AND recurring IS NOT NULL`
  ).all();

  for (const task of done) {
    // match by title + recurring + created_at to avoid false dedup on same-name tasks
    const existing = db.prepare(
      `SELECT id FROM tasks WHERE title = ? AND status = 'open' AND recurring = ? AND id != ?`
    ).get(task.title, task.recurring, task.id);

    if (!existing) {
      const next = nextRecurringDate(task.recurring);
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO tasks (title, notes, priority, stale_days, recurring, remind_at, reminded, last_touched_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
      ).run(task.title, task.notes, task.priority, task.stale_days, task.recurring, next, now, now);
    }
  }
}

function startScheduler() {
  // every 5 minutes — due reminders
  cron.schedule('*/5 * * * *', checkDueReminders);
  // every day at 9am — stale task nudges
  cron.schedule('0 9 * * *', checkStaleTasks);
  // every day at midnight — re-queue recurring tasks
  cron.schedule('0 0 * * *', checkRecurringTasks);

  console.log('[scheduler] running — reminders every 5min, stale+recurring checks daily');
}

module.exports = { startScheduler, checkDueReminders, checkStaleTasks, checkRecurringTasks };
