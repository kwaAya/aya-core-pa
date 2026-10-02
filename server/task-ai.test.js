'use strict';
// Runner: node --test server/task-ai.test.js
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os'), fs = require('fs'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'corepa-taskai-'));

const stub = (id, exports) => { require.cache[require.resolve(id)] = { id, filename: id, loaded: true, exports }; };
stub('./auth', { requireUser: (req, res, next) => { req.userId = Number(req.headers['x-test-user']); next(); } });
const realPlan = require('./plan');
stub('./plan', { ...realPlan, enforceQuota: () => (req, res, next) => next() });
let modelReply = () => '{}';
stub('./ai-providers', {
  getProviderPlan: () => [{ name: 'fake' }],
  fetchWithProviderFallback: async () => ({ json: async () => ({ choices: [{ message: { content: modelReply() } }] }) }),
});

const db = require('./db');
const cal = require('./calendar');
const ai = require('./task-ai');

const TZ = 'Africa/Johannesburg';
const L = (d, t) => cal.localToUtcMs(d, t, TZ);

describe('findSlot', () => {
  const base = { startDate: '2030-01-07', endDate: '2030-01-07', dayStart: '08:00', dayEnd: '17:00', tz: TZ, durationMin: 60, nowMs: L('2030-01-06', '12:00') };

  test('takes the start of an empty day', () => {
    const s = ai.findSlot({ ...base, busy: [] });
    assert.equal(s.startMs, L('2030-01-07', '08:00'));
    assert.equal(s.endMs - s.startMs, 3600000);
  });

  test('skips busy blocks, adds a 10-minute buffer, and finds gaps between them', () => {
    const busy = [{ startMs: L('2030-01-07', '08:00'), endMs: L('2030-01-07', '10:00') }, { startMs: L('2030-01-07', '11:30'), endMs: L('2030-01-07', '13:00') }];
    assert.equal(ai.findSlot({ ...base, durationMin: 90, busy }).startMs, L('2030-01-07', '13:10'), 'gap too small → next gap');
    assert.equal(ai.findSlot({ ...base, durationMin: 60, busy }).startMs, L('2030-01-07', '10:10'), 'fits between blocks');
  });

  test('never starts in the past today and rounds up to 5 minutes', () => {
    const s = ai.findSlot({ ...base, startDate: '2030-01-06', endDate: '2030-01-06', nowMs: L('2030-01-06', '09:02'), busy: [] });
    assert.equal(s.startMs, L('2030-01-06', '09:05'));
  });

  test('rolls to the next day when today is full, and returns null when nothing fits', () => {
    const full = [{ startMs: L('2030-01-07', '07:00'), endMs: L('2030-01-07', '17:30') }];
    assert.equal(ai.findSlot({ ...base, endDate: '2030-01-08', busy: full }).startMs, L('2030-01-08', '08:00'));
    assert.equal(ai.findSlot({ ...base, busy: full }), null);
  });

  test('respects a deadline', () => {
    const deadline = L('2030-01-07', '08:30');
    assert.equal(ai.findSlot({ ...base, busy: [], deadlineMs: deadline }), null);
    assert.ok(ai.findSlot({ ...base, busy: [], durationMin: 30, deadlineMs: deadline }));
  });
});

describe('validation', () => {
  test('validateSteps cleans, dedupes, caps and drops the echoed title', () => {
    const r = ai.validateSteps({ steps: [
      { text: 'Open the doc', est_min: 3 }, { text: 'open the doc', est_min: 5 }, { text: 'Write report', est_min: 10 },
      { text: 'x' }, { text: '  Draft intro  ', est_min: 999 }, { text: 'Edit', est_min: 'abc' }, ...Array.from({ length: 12 }, (_, i) => ({ text: `Extra step ${i}` })),
    ] }, 'Write report');
    assert.deepEqual(r.slice(0, 3).map(s => s.text), ['Open the doc', 'Draft intro', 'Edit']);
    assert.equal(r[1].est_min, 180); assert.equal(r[2].est_min, null); assert.equal(r.length, 8);
  });
  test('extractJson survives fences', () => { assert.deepEqual(ai.extractJson('```json\n{"steps":[]}\n```'), { steps: [] }); assert.equal(ai.extractJson('nope'), null); });
  test('parseScheduleRequest enforces limits', () => {
    const now = Date.UTC(2030, 0, 1, 10);
    assert.ok(ai.parseScheduleRequest({ when: 'never' }, now).error);
    assert.ok(ai.parseScheduleRequest({ timezone: 'Mars/X' }, now).error);
    assert.ok(ai.parseScheduleRequest({ duration_min: 2 }, now).error);
    assert.ok(ai.parseScheduleRequest({ day_start: '20:00', day_end: '08:00' }, now).error);
    assert.equal(ai.parseScheduleRequest({ duration_min: 47 }, now).value.durationMin, 45);
  });
});

describe('routes (real SQLite, stubbed auth + AI)', () => {
  let server, base;
  const call = async (method, url, user, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-test-user': String(user) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: r.status, json, text };
  };
  const addUser = async email => (await db.prepare(`INSERT INTO users (email, password_hash, password_salt, created_at) VALUES (?,?,?,?)`).run(email, 'x', 'x', new Date().toISOString())).lastInsertRowid;
  const addTask = async (uid, title, extra = {}) => {
    const now = new Date().toISOString();
    return (await db.prepare(`INSERT INTO tasks (title, notes, status, start_at, due_at, last_touched_at, created_at, user_id) VALUES (?,?,?,?,?,?,?,?)`)
      .run(title, extra.notes || null, extra.status || 'open', extra.start_at || null, extra.due_at || null, now, now, uid)).lastInsertRowid;
  };
  let u1, u2;

  before(async () => {
    await db.ready; await cal.ensureCalendarSchema();
    u1 = await addUser('a@t.dev'); u2 = await addUser('b@t.dev');
    const express = require('express'); const app = express(); app.use(express.json());
    ai.registerTaskAiRoutes(app);
    await new Promise(r => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  test('breakdown → steps, progress, all_done, isolation, replace-protection', async () => {
    const tid = await addTask(u1, 'File my taxes');
    modelReply = () => '```json\n{"steps":[{"text":"Find last year\'s return","est_min":5},{"text":"Gather income documents","est_min":20},{"text":"Fill in the form","est_min":40}]}\n```';
    const b = await call('POST', `/api/tasks/${tid}/breakdown`, u1, {});
    assert.equal(b.status, 201, b.text); assert.equal(b.json.steps.length, 3);

    assert.equal((await call('POST', `/api/tasks/${tid}/breakdown`, u1, {})).status, 409, 'does not clobber existing steps');
    assert.equal((await call('POST', `/api/tasks/${tid}/breakdown`, u2, {})).status, 404, 'other user cannot');
    assert.equal((await call('GET', `/api/tasks/${tid}/steps`, u2)).status, 404);

    const [s1, s2, s3] = b.json.steps;
    await call('PATCH', `/api/tasks/${tid}/steps/${s1.id}`, u1, { done: true });
    assert.equal((await call('PATCH', `/api/tasks/${tid}/steps/${s1.id}`, u2, { done: true })).status, 404);
    const sum = await call('GET', '/api/task-steps/summary', u1);
    assert.deepEqual(sum.json, [{ task_id: Number(tid), total: 3, done: 1 }]);
    assert.deepEqual((await call('GET', '/api/task-steps/summary', u2)).json, []);

    await call('PATCH', `/api/tasks/${tid}/steps/${s2.id}`, u1, { done: true });
    const last = await call('PATCH', `/api/tasks/${tid}/steps/${s3.id}`, u1, { done: true });
    assert.equal(last.json.all_done, true);

    modelReply = () => '{"steps":[{"text":"Brand new first step","est_min":2},{"text":"Brand new second step","est_min":9}]}';
    const re = await call('POST', `/api/tasks/${tid}/breakdown`, u1, { replace: true });
    assert.deepEqual(re.json.steps.map(s => s.text), ['Brand new first step', 'Brand new second step']);
    assert.equal(re.json.steps.every(s => !s.done), true);
  });

  test('bad model output → 502 and existing steps are untouched', async () => {
    const tid = await addTask(u1, 'Plan holiday');
    await call('POST', `/api/tasks/${tid}/steps`, u1, { text: 'My own step' });
    modelReply = () => 'sorry, no';
    assert.equal((await call('POST', `/api/tasks/${tid}/breakdown`, u1, { replace: true })).status, 502);
    assert.deepEqual((await call('GET', `/api/tasks/${tid}/steps`, u1)).json.steps.map(s => s.text), ['My own step']);
    assert.equal((await call('POST', `/api/tasks/${tid}/steps`, u1, { text: '   ' })).status, 400);
    const step = (await call('GET', `/api/tasks/${tid}/steps`, u1)).json.steps[0];
    assert.equal((await call('DELETE', `/api/tasks/${tid}/steps/${step.id}`, u2)).status, 404);
    assert.equal((await call('DELETE', `/api/tasks/${tid}/steps/${step.id}`, u1)).json.steps.length, 0);
  });

  test('done tasks cannot be broken down or scheduled', async () => {
    const tid = await addTask(u1, 'Old thing', { status: 'done' });
    assert.equal((await call('POST', `/api/tasks/${tid}/breakdown`, u1, {})).status, 409);
    assert.equal((await call('POST', `/api/tasks/${tid}/schedule`, u1, {})).status, 409);
  });

  test('schedule: sums step estimates, avoids calendar events + other scheduled tasks, returns undo info', async () => {
    const day = cal.addDays(cal.utcToLocal(Date.now(), TZ).date, 1);
    const evIns = (s, e) => db.prepare(`INSERT INTO calendar_events (user_id,title,start_at,end_at,source,created_at,updated_at) VALUES (?,?,?,?, 'manual', ?, ?)`)
      .run(u1, 'Busy', new Date(L(day, s)).toISOString(), new Date(L(day, e)).toISOString(), new Date().toISOString(), new Date().toISOString());
    await evIns('08:00', '09:00');
    await addTask(u1, 'Already scheduled', { start_at: new Date(L(day, '09:10')).toISOString(), due_at: new Date(L(day, '10:00')).toISOString() });

    const tid = await addTask(u1, 'Write essay', { due_at: new Date(L(day, '08:00')).toISOString() });
    await db.prepare(`UPDATE tasks SET due_at = NULL WHERE id = ?`).run(tid);
    await db.prepare(`INSERT INTO task_steps (task_id,user_id,position,text,est_min,done,created_at) VALUES (?,?,?,?,?,?,?)`).run(tid, u1, 0, 'a', 20, 0, 'x');
    await db.prepare(`INSERT INTO task_steps (task_id,user_id,position,text,est_min,done,created_at) VALUES (?,?,?,?,?,?,?)`).run(tid, u1, 1, 'b', 25, 0, 'x');
    await db.prepare(`INSERT INTO task_steps (task_id,user_id,position,text,est_min,done,created_at) VALUES (?,?,?,?,?,?,?)`).run(tid, u1, 2, 'c', 99, 1, 'x');

    const r = await call('POST', `/api/tasks/${tid}/schedule`, u1, { when: 'tomorrow', timezone: TZ });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.duration_min, 45, 'sum of undone step estimates');
    assert.equal(r.json.start_at, new Date(L(day, '10:10')).toISOString(), 'after event, other task, and buffer');
    assert.equal(r.json.end_at, new Date(L(day, '10:55')).toISOString());
    assert.deepEqual(r.json.previous, { start_at: null, due_at: null });
    const row = await db.prepare(`SELECT start_at, due_at FROM tasks WHERE id = ?`).get(tid);
    assert.equal(row.start_at, r.json.start_at);
    assert.equal((await call('POST', `/api/tasks/${tid}/schedule`, u2, {})).status, 404);
  });

  test('schedule: fully booked range → friendly 409, nothing changed', async () => {
    const day = cal.addDays(cal.utcToLocal(Date.now(), TZ).date, 2);
    await db.prepare(`INSERT INTO calendar_events (user_id,title,start_at,end_at,source,created_at,updated_at) VALUES (?,?,?,?, 'manual', ?, ?)`)
      .run(u2, 'All day', new Date(L(day, '00:00')).toISOString(), new Date(L(day, '23:59')).toISOString(), 'x', 'x');
    const tid = await addTask(u2, 'Squeeze in');
    const r = await call('POST', `/api/tasks/${tid}/schedule`, u2, { when: 'tomorrow', timezone: TZ, duration_min: 600 });
    assert.equal(r.status, 400);
    const r2 = await call('POST', `/api/tasks/${tid}/schedule`, u2, { when: 'tomorrow', timezone: TZ, day_start: '08:00', day_end: '08:20', duration_min: 30 });
    assert.equal(r2.status, 409);
    assert.equal((await db.prepare(`SELECT start_at FROM tasks WHERE id = ?`).get(tid)).start_at, null);
  });
});