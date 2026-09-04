const cron = require('node-cron');
const db = require('./db');
const { sendMessage } = require('./telegram');

function checkDueReminders() {
  const now = new Date().toISOString();
  const due = db.prepare(
    `SELECT * FROM tasks WHERE status = 'open' AND remind_at IS NOT NULL AND remind_at <= ? AND reminded = 0`
  ).all(now);

  for (const task of due) {
    sendMessage(`⏰ reminder: ${task.title}${task.notes ? `\n${task.notes}` : ''}`);
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
      sendMessage(`👀 this has been sitting for ${Math.floor(daysSince)} day(s): "${task.title}"`);
      // push last_touched_at forward so it doesn't nudge again every single run —
      // nudges again after another full stale_days window
      db.prepare(`UPDATE tasks SET last_touched_at = ? WHERE id = ?`).run(new Date().toISOString(), task.id);
    }
  }
}

function startScheduler() {
  // check every 5 minutes for time-based reminders
  cron.schedule('*/5 * * * *', checkDueReminders);
  // check once a day for stale/untouched tasks
  cron.schedule('0 9 * * *', checkStaleTasks);
  console.log('[scheduler] running — reminders every 5min, stale check daily at 9am');
}

module.exports = { startScheduler, checkDueReminders, checkStaleTasks };
