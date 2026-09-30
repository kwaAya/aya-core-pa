'use strict';

/**
 * Tests for the calendar pod and itinerary generator.
 * Runner: node --test server/calendar.test.js
 *
 * Pure helpers are tested directly; the routes are tested end-to-end against a
 * real (temporary) SQLite database with auth and the AI provider stubbed.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'corepa-cal-'));

// Stub auth (header-driven user id) and the AI provider before anything requires them.
const stub = (id, exports) => { require.cache[require.resolve(id)] = { id, filename: id, loaded: true, exports }; };
stub('./auth', { requireUser: (req, res, next) => { req.userId = Number(req.headers['x-test-user']); next(); } });
const realPlan = require('./plan');
stub('./plan', { ...realPlan, enforceQuota: () => (req, res, next) => next() });

let fakeModelReply = () => '{}';
stub('./ai-providers', {
  getProviderPlan: () => [{ name: 'fake' }],
  fetchWithProviderFallback: async () => ({ json: async () => ({ choices: [{ message: { content: fakeModelReply() } }] }) }),
});

const cal = require('./calendar');
const itin = require('./itinerary');
const db = require('./db');

// ─── Time helpers ────────────────────────────────────────────────────────────

describe('timezone helpers', () => {
  test('Johannesburg is UTC+2 year-round', () => {
    assert.equal(new Date(cal.localToUtcMs('2026-10-01', '08:00', 'Africa/Johannesburg')).toISOString(), '2026-10-01T06:00:00.000Z');
  });

  test('handles DST on both sides of a US spring-forward', () => {
    assert.equal(new Date(cal.localToUtcMs('2026-03-07', '12:00', 'America/New_York')).toISOString(), '2026-03-07T17:00:00.000Z');
    assert.equal(new Date(cal.localToUtcMs('2026-03-08', '12:00', 'America/New_York')).toISOString(), '2026-03-08T16:00:00.000Z');
  });

  test('utcToLocal round-trips', () => {
    const ms = cal.localToUtcMs('2026-12-31', '23:30', 'Europe/London');
    assert.deepEqual(cal.utcToLocal(ms, 'Europe/London'), { date: '2026-12-31', time: '23:30' });
  });

  test('validates timezones, dates and times', () => {
    assert.equal(cal.isValidTz('Africa/Johannesburg'), true);
    assert.equal(cal.isValidTz('Mars/Olympus'), false);
    assert.equal(cal.isDateStr('2026-02-30'), false);
    assert.equal(cal.isDateStr('2026-02-28'), true);
    assert.equal(cal.isTimeStr('24:00'), false);
    assert.equal(cal.isTimeStr('09:05'), true);
    assert.equal(cal.addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(cal.daysBetween('2026-10-01', '2026-10-07'), 6);
  });
});

// ─── Event validation ────────────────────────────────────────────────────────

describe('cleanEventInput', () => {
  const ok = { title: ' Gym ', start_at: '2026-10-01T06:00:00Z', end_at: '2026-10-01T07:00:00Z' };

  test('accepts and normalises a valid event', () => {
    const { value } = cal.cleanEventInput(ok);
    assert.equal(value.title, 'Gym');
    assert.equal(value.start_at, '2026-10-01T06:00:00.000Z');
  });

  test('rejects bad input', () => {
    assert.ok(cal.cleanEventInput({ ...ok, title: '  ' }).error);
    assert.ok(cal.cleanEventInput({ ...ok, end_at: ok.start_at }).error);
    assert.ok(cal.cleanEventInput({ ...ok, start_at: 'soon' }).error);
    assert.ok(cal.cleanEventInput({ ...ok, notes: 42 }).error);
    assert.ok(cal.cleanEventInput({ ...ok, end_at: '2027-10-01T06:00:00Z' }).error);
    assert.ok(cal.cleanEventInput(null).error);
  });

  test('PATCH semantics keep unspecified fields', () => {
    const existing = { title: 'A', notes: 'n', location: 'L', start_at: ok.start_at, end_at: ok.end_at };
    const { value } = cal.cleanEventInput({ title: 'B' }, existing);
    assert.equal(value.title, 'B');
    assert.equal(value.notes, 'n');
    assert.equal(value.end_at, '2026-10-01T07:00:00.000Z');
  });
});

// ─── ICS ─────────────────────────────────────────────────────────────────────

describe('ICS feed output', () => {
  test('folds long and multibyte lines to ≤75 octets', () => {
    const folded = cal.foldLine('SUMMARY:' + 'é'.repeat(200));
    for (const l of folded.split('\r\n')) assert.ok(Buffer.byteLength(l) <= 75, 'line too long');
    assert.equal(folded.replace(/\r\n /g, ''), 'SUMMARY:' + 'é'.repeat(200));
  });

  test('escapes special characters', () => {
    assert.equal(cal.icsEscape('a,b;c\\d\ne'), 'a\\,b\\;c\\\\d\\ne');
  });

  test('produces a well-formed calendar', () => {
    const ics = cal.buildIcs([{ id: 7, title: 'Lunch, with Sam', notes: 'Line1\nLine2', location: 'Café', start_at: '2026-10-01T10:00:00.000Z', end_at: '2026-10-01T11:00:00.000Z', updated_at: '2026-09-30T08:00:00.000Z' }]);
    assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
    assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
    assert.ok(ics.includes('DTSTART:20261001T100000Z'));
    assert.ok(ics.includes('SUMMARY:Lunch\\, with Sam'));
    assert.ok(ics.includes('UID:corepa-event-7@corepa'));
    assert.ok(!/[^\r]\n/.test(ics), 'all line endings are CRLF');
  });
});

// ─── Plan validation ─────────────────────────────────────────────────────────

describe('validatePlan', () => {
  const tz = 'Africa/Johannesburg';
  const ctx = (over = {}) => ({
    startDate: '2030-01-01', endDate: '2030-01-03', dayStart: '08:00', dayEnd: '21:00', tz,
    nowMs: Date.UTC(2029, 11, 31), taskIds: new Set([5]), busy: [], ...over,
  });
  const it = (o) => ({ date: '2030-01-01', start: '09:00', end: '10:00', title: 'Focus', notes: '', task_id: null, ...o });

  test('keeps valid items in order and with stable keys', () => {
    const r = itin.validatePlan({ title: 'T', items: [it({ start: '11:00', end: '12:00', title: 'B' }), it({ title: 'A' })] }, ctx());
    assert.deepEqual(r.items.map(i => i.title), ['A', 'B']);
    assert.match(r.items[0].key, /^[0-9a-f]{12}$/);
    assert.equal(r.items[0].key, itin.validatePlan({ items: [it({ title: 'A' })] }, ctx()).items[0].key);
  });

  test('drops junk: bad dates/times, out of range, reversed, outside window', () => {
    const r = itin.validatePlan({ items: [
      it({ date: '2030-02-30' }), it({ date: '2030-01-09' }), it({ start: '25:00' }),
      it({ start: '10:00', end: '09:00' }), it({ start: '06:00', end: '07:00', title: 'early' }), it({ title: '' }),
    ] }, ctx());
    assert.equal(r.items.length, 0);
    assert.ok(r.warnings.some(w => w.includes('early')));
  });

  test('drops overlaps between items and flags clashes with existing events', () => {
    const busy = [{ startMs: cal.localToUtcMs('2030-01-01', '14:00', tz), endMs: cal.localToUtcMs('2030-01-01', '15:00', tz), title: 'Dentist' }];
    const r = itin.validatePlan({ items: [
      it({ title: 'A', start: '09:00', end: '10:00' }),
      it({ title: 'B', start: '09:30', end: '10:30' }),
      it({ title: 'C', start: '14:30', end: '15:30' }),
    ] }, ctx({ busy }));
    assert.deepEqual(r.items.map(i => i.title), ['A', 'C']);
    assert.equal(r.items[1].conflict, 'Dentist');
    assert.ok(r.warnings.some(w => w.includes('"B"')));
  });

  test('ignores past items and unknown task ids', () => {
    const r = itin.validatePlan({ items: [it({ task_id: 5 }), it({ title: 'X', start: '12:00', end: '13:00', task_id: 99 })] },
      ctx({ nowMs: cal.localToUtcMs('2030-01-01', '09:30', tz) }));
    assert.deepEqual(r.items.map(i => i.title), ['X']);
    assert.equal(r.items[0].task_id, null);
    assert.equal(itin.validatePlan({ items: [it({ task_id: 5 })] }, ctx()).items[0].task_id, 5);
  });

  test('extractJson survives fences and chatter', () => {
    assert.deepEqual(itin.extractJson('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(itin.extractJson('Sure! {"a":1} hope that helps'), { a: 1 });
    assert.equal(itin.extractJson('no json here'), null);
  });

  test('parseRequest enforces limits', () => {
    const now = Date.UTC(2030, 0, 1, 10);
    assert.ok(itin.parseRequest({ prompt: 'hi' }, now).error);
    assert.ok(itin.parseRequest({ prompt: 'plan my week', timezone: 'Nope/Zone' }, now).error);
    assert.ok(itin.parseRequest({ prompt: 'plan my week', start_date: '2029-12-01' }, now).error);
    assert.ok(itin.parseRequest({ prompt: 'plan my week', start_date: '2030-01-02', end_date: '2030-02-20' }, now).error);
    assert.ok(itin.parseRequest({ prompt: 'plan my week', day_start: '21:00', day_end: '08:00' }, now).error);
    assert.equal(itin.parseRequest({ prompt: 'plan my week' }, now).value.startDate, '2030-01-01');
  });
});

// ─── End-to-end routes ───────────────────────────────────────────────────────

describe('routes (real SQLite, stubbed auth + AI)', () => {
  let server, base;
  const call = async (method, url, user, body) => {
    const r = await fetch(base + url, {
      method, headers: { 'content-type': 'application/json', 'x-test-user': String(user) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text, headers: r.headers };
  };

  before(async () => {
    const express = require('express');
    const app = express();
    app.use(express.json());
    cal.registerCalendarRoutes(app);
    itin.registerItineraryRoutes(app);
    await new Promise(r => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
    await cal.ensureCalendarSchema();
  });
  after(() => server.close());

  test('event CRUD with strict per-user isolation', async () => {
    const ev = { title: 'Standup', start_at: '2030-05-01T07:00:00Z', end_at: '2030-05-01T07:15:00Z' };
    const created = await call('POST', '/api/calendar/events', 1, ev);
    assert.equal(created.status, 201);
    const id = created.json.id;

    assert.equal((await call('GET', '/api/calendar/events?from=2030-05-01T00:00:00Z&to=2030-05-02T00:00:00Z', 1)).json.events.length, 1);
    assert.equal((await call('GET', '/api/calendar/events?from=2030-05-01T00:00:00Z&to=2030-05-02T00:00:00Z', 2)).json.events.length, 0);
    assert.equal((await call('PATCH', `/api/calendar/events/${id}`, 2, { title: 'hax' })).status, 404);
    assert.equal((await call('DELETE', `/api/calendar/events/${id}`, 2)).status, 404);

    const patched = await call('PATCH', `/api/calendar/events/${id}`, 1, { title: 'Standup (moved)', end_at: '2030-05-01T07:30:00Z' });
    assert.equal(patched.json.title, 'Standup (moved)');
    assert.equal((await call('DELETE', `/api/calendar/events/${id}`, 1)).status, 200);
    assert.equal((await call('POST', '/api/calendar/events', 1, { title: 'x' })).status, 400);
    assert.equal((await call('GET', '/api/calendar/events?from=2030-01-01T00:00:00Z&to=2031-01-01T00:00:00Z', 1)).status, 400);
  });

  test('task markers appear read-only in the range', async () => {
    const now = new Date().toISOString();
    await db.prepare(`INSERT INTO tasks (title, due_at, last_touched_at, created_at, user_id) VALUES (?, ?, ?, ?, ?)`)
      .run('Pay rent', '2030-06-01T08:00:00Z', now, now, 1);
    const r = await call('GET', '/api/calendar/events?from=2030-06-01T00:00:00Z&to=2030-06-02T00:00:00Z', 1);
    assert.equal(r.json.tasks[0].title, 'Pay rent');
    assert.equal((await call('GET', '/api/calendar/events?from=2030-06-01T00:00:00Z&to=2030-06-02T00:00:00Z', 2)).json.tasks.length, 0);
  });

  test('feed: create, serve, rotate invalidates old link, revoke', async () => {
    const soon = Date.now() + 10 * 86400000;
    const soonEv = (title) => ({ title, start_at: new Date(soon).toISOString(), end_at: new Date(soon + 3600000).toISOString() });
    await call('POST', '/api/calendar/events', 1, soonEv('Feed me'));
    assert.equal((await call('GET', '/api/calendar/feed', 1)).json.url, null);

    const a = (await call('POST', '/api/calendar/feed', 1)).json;
    assert.match(a.url, /\/calendar\/feed\/[A-Za-z0-9_-]{20,}\.ics$/);
    assert.ok(a.webcal.startsWith('webcal://'));

    const served = await fetch(a.url.replace(/^https?:\/\/[^/]+/, base));
    assert.equal(served.status, 200);
    assert.match(served.headers.get('content-type'), /text\/calendar/);
    assert.ok((await served.text()).includes('SUMMARY:Feed me'));

    const b = (await call('POST', '/api/calendar/feed', 1)).json;
    assert.notEqual(a.url, b.url);
    assert.equal((await fetch(a.url.replace(/^https?:\/\/[^/]+/, base))).status, 404);
    assert.equal((await fetch(base + '/calendar/feed/not-a-real-token-at-all-xx.ics')).status, 404);

    // other users never appear in this feed
    await call('POST', '/api/calendar/events', 2, soonEv('Private to 2'));
    const body = await (await fetch(b.url.replace(/^https?:\/\/[^/]+/, base))).text();
    assert.ok(!body.includes('Private to 2'));

    await call('DELETE', '/api/calendar/feed', 1);
    assert.equal((await fetch(b.url.replace(/^https?:\/\/[^/]+/, base))).status, 404);
  });

  test('itinerary: generate draft → confirm (idempotent, with exclusions) → undo', async () => {
    const tz = 'Africa/Johannesburg';
    const today = cal.utcToLocal(Date.now(), tz).date;
    const day = cal.addDays(today, 1);
    await call('POST', '/api/calendar/events', 3, {
      title: 'Dentist',
      start_at: new Date(cal.localToUtcMs(day, '14:00', tz)).toISOString(),
      end_at: new Date(cal.localToUtcMs(day, '15:00', tz)).toISOString(),
    });

    fakeModelReply = () => '```json\n' + JSON.stringify({
      title: 'Focused day', summary: 'Deep work then admin.',
      items: [
        { date: day, start: '09:00', end: '11:00', title: 'Deep work', notes: 'Phone off', task_id: null },
        { date: day, start: '14:30', end: '15:30', title: 'Admin', notes: '', task_id: null },
        { date: day, start: '16:00', end: '17:00', title: 'Gym', notes: '', task_id: null },
      ],
    }) + '\n```';

    const gen = await call('POST', '/api/itinerary/generate', 3, { prompt: 'Plan tomorrow', start_date: day, end_date: day, timezone: tz });
    assert.equal(gen.status, 201, gen.text);
    assert.equal(gen.json.status, 'draft');
    assert.equal(gen.json.plan.items.length, 3);
    assert.equal(gen.json.plan.items[1].conflict, 'Dentist');

    // a draft alone does not touch the calendar
    const range = `from=${encodeURIComponent(new Date(cal.localToUtcMs(day, '00:00', tz)).toISOString())}&to=${encodeURIComponent(new Date(cal.localToUtcMs(cal.addDays(day, 1), '00:00', tz)).toISOString())}`;
    assert.equal((await call('GET', `/api/calendar/events?${range}`, 3)).json.events.length, 1);

    // other users can't see or confirm it
    assert.equal((await call('GET', `/api/itinerary/${gen.json.id}`, 4)).status, 404);
    assert.equal((await call('POST', `/api/itinerary/${gen.json.id}/confirm`, 4, {})).status, 404);

    const adminKey = gen.json.plan.items[1].key;
    const c1 = await call('POST', `/api/itinerary/${gen.json.id}/confirm`, 3, { exclude: [adminKey] });
    assert.deepEqual([c1.json.created, c1.json.skipped], [2, 0]);
    const c2 = await call('POST', `/api/itinerary/${gen.json.id}/confirm`, 3, { exclude: [adminKey] });
    assert.deepEqual([c2.json.created, c2.json.skipped], [0, 2]); // no duplicates

    const evs = (await call('GET', `/api/calendar/events?${range}`, 3)).json.events;
    assert.equal(evs.length, 3);
    const deep = evs.find(e => e.title === 'Deep work');
    assert.equal(deep.start_at, new Date(cal.localToUtcMs(day, '09:00', tz)).toISOString());
    assert.equal(deep.source, 'itinerary');

    const undo = await call('DELETE', `/api/itinerary/${gen.json.id}`, 3);
    assert.equal(undo.json.removed_events, 2);
    const after = (await call('GET', `/api/calendar/events?${range}`, 3)).json.events;
    assert.deepEqual(after.map(e => e.title), ['Dentist']); // user's own event untouched
  });

  test('itinerary: unusable model output → 502 and nothing saved', async () => {
    fakeModelReply = () => 'I cannot do that.';
    const before = (await call('GET', '/api/itinerary', 5)).json.length;
    const r = await call('POST', '/api/itinerary/generate', 5, { prompt: 'Plan my day', timezone: 'Africa/Johannesburg' });
    assert.equal(r.status, 502);
    assert.equal((await call('GET', '/api/itinerary', 5)).json.length, before);
    assert.equal((await call('POST', '/api/itinerary/generate', 5, { prompt: 'x' })).status, 400);
  });
});