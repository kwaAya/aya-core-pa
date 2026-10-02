'use strict';
// Runner: node --test server/task-nudges.test.js
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os'), fs = require('fs'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'corepa-nudge-'));

const db = require('./db');
const nudges = require('./task-nudges');
const cal = require('./calendar');

const NOW = Date.parse('2030-06-01T10:00:00Z');
const iso = (offMin) => new Date(NOW + offMin * 60000).toISOString();
const sent = []; const deps = {
  notify: async (uid, text, title, data) => { sent.push({ uid, text, title, data }); },
  nextPingMinutes: async (uid, pr, n) => (pr === 'high' ? 5 : 60),
};
let uid;
async function addTask(o) {
  const now = new Date().toISOString();
  const r = await db.prepare(`INSERT INTO tasks (title, priority, start_at, due_at, status, last_touched_at, created_at, user_id) VALUES (?,?,?,?,?,?,?,?)`)
    .run(o.title, o.priority || 'normal', o.start_at || null, o.due_at || null, o.status || 'open', now, now, uid);
  return r.lastInsertRowid;
}
const taskRow = id => db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);

describe('task + event nudges', () => {
  before(async () => {
    await db.ready;
    const r = await db.prepare(`INSERT INTO users (email, password_hash, password_salt, created_at) VALUES (?,?,?,?)`)
      .run('n@test.dev', 'x', 'x', new Date().toISOString());
    uid = r.lastInsertRowid;
  });

  test('start ping fires once, arms the escalation ladder, and re-arms if the time changes', async () => {
    sent.length = 0;
    const id = await addTask({ title: 'Write report', priority: 'high', start_at: iso(-2) });
    assert.equal(await nudges.runTaskNudges(deps, NOW), 1);
    assert.match(sent[0].text, /time to start: Write report/);
    const row = await taskRow(id);
    assert.equal(row.next_ping_at, iso(5), 'ladder armed with the high-priority first step');
    assert.equal(await nudges.runTaskNudges(deps, NOW + 60000), 0, 'never sends twice');

    await db.prepare(`UPDATE tasks SET start_at = ? WHERE id = ?`).run(iso(-1), id);
    assert.equal(await nudges.runTaskNudges(deps, NOW + 120000), 1, 'moved time = fresh nudge');
  });

  test('due check asks "is it done?" and does not disturb an already-running ladder', async () => {
    sent.length = 0;
    const id = await addTask({ title: 'Send invoice', due_at: iso(-10) });
    const existing = iso(30);
    await db.prepare(`UPDATE tasks SET next_ping_at = ?, ping_count = 2 WHERE id = ?`).run(existing, id);
    assert.equal(await nudges.runTaskNudges(deps, NOW), 1);
    assert.match(sent[0].text, /was due — is it done/);
    const row = await taskRow(id);
    assert.equal(row.next_ping_at, existing); assert.equal(row.ping_count, 2);
  });

  test('ignores done tasks, future times, stale times and bad dates', async () => {
    sent.length = 0;
    await addTask({ title: 'done one', start_at: iso(-1), status: 'done' });
    await addTask({ title: 'future', start_at: iso(30), due_at: iso(90) });
    await addTask({ title: 'ancient', start_at: iso(-60 * 24), due_at: iso(-60 * 24) });
    await addTask({ title: 'garbage', start_at: 'whenever', due_at: 'soon' });
    assert.equal(await nudges.runTaskNudges(deps, NOW), 0);
    assert.equal(sent.length, 0);
  });

  test('concurrent runs cannot double-send', async () => {
    sent.length = 0;
    await addTask({ title: 'Race me', start_at: iso(-1) });
    const results = await Promise.all([nudges.runTaskNudges(deps, NOW), nudges.runTaskNudges(deps, NOW)]);
    assert.equal(results[0] + results[1], 1);
    assert.equal(sent.filter(s => /Race me/.test(s.text)).length, 1);
  });

  test('event reminders: only inside the lead window, once, with location', async () => {
    sent.length = 0;
    await cal.ensureCalendarSchema();
    const ins = (title, off, loc) => db.prepare(`INSERT INTO calendar_events (user_id,title,location,start_at,end_at,source,created_at,updated_at) VALUES (?,?,?,?,?, 'manual', ?, ?)`)
      .run(uid, title, loc || null, iso(off), iso(off + 30), iso(0), iso(0));
    await ins('Soon', 6, 'Room 4'); await ins('Later', 45); await ins('Started', -5);
    assert.equal(await nudges.runEventReminders(deps, NOW), 1);
    assert.match(sent[0].text, /in 6 min: Soon @ Room 4/);
    assert.equal(await nudges.runEventReminders(deps, NOW + 60000), 0);
  });

  test('prune only removes old log rows', async () => {
    await nudges.pruneLog(NOW + 40 * 86400000);
    const left = await db.prepare(`SELECT COUNT(*) AS n FROM nudge_log`).get();
    assert.equal(Number(left.n), 0);
  });
});