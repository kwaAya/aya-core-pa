// ─── Web Push ───────────────────────────────────────────────────────────────
// Real push notifications — arrive even when the app/tab is closed, unlike
// the old `new Notification()` client-side call which only worked while the
// tab was open and actively running (which phones kill the instant you
// background the app). This is what actually reaches a phone.
//
// Needs the `web-push` package (`npm install web-push`) and two env vars:
//   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
// Degrades gracefully to a no-op + warning log if either is missing, same
// pattern as billing.js / telegram.js — never crashes the app over an
// unconfigured optional feature.

const db = require('./db');

let webpush = null;
try {
  webpush = require('web-push');
} catch {
  console.warn('[push] "web-push" package not installed — run `npm install web-push`. Push notifications disabled until then.');
}

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;

function isPushConfigured() {
  return !!(webpush && VAPID_PUBLIC && VAPID_PRIVATE);
}

if (isPushConfigured()) {
  webpush.setVapidDetails('mailto:hello@corepa.app', VAPID_PUBLIC, VAPID_PRIVATE);
} else if (webpush) {
  console.warn('[push] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set — push notifications disabled.');
}

function getPublicKey() {
  return VAPID_PUBLIC || null;
}

async function saveSubscription(userId, sub) {
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    throw new Error('malformed push subscription');
  }
  // one row per device — a user can have several (phone + laptop)
  const existing = await db.prepare(
    `SELECT id FROM push_subscriptions WHERE user_id = ? AND endpoint = ?`
  ).get(userId, sub.endpoint);
  if (existing) return; // already stored
  await db.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, new Date().toISOString());
}

async function removeSubscription(userId, endpoint) {
  await db.prepare(`DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?`).run(userId, endpoint);
}

async function sendPush(userId, title, body, data = null) {
  if (!isPushConfigured()) return;
  try {
    const subs = await db.prepare(`SELECT * FROM push_subscriptions WHERE user_id = ?`).all(userId);
    if (!subs.length) return;

    // `data` rides along so the service worker can deep-link a tap straight
    // to the task instead of just opening the app to whatever's on screen.
    const payload = JSON.stringify({ title, body, data });

    await Promise.all(subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload
        );
      } catch (err) {
        // 404/410 means the browser unsubscribed on its own (uninstalled,
        // cleared data, etc) — clean up rather than retrying forever.
        if (err.statusCode === 404 || err.statusCode === 410) {
          await db.prepare(`DELETE FROM push_subscriptions WHERE id = ?`).run(sub.id);
        } else {
          console.error('[push] send failed for user', userId, '—', err.message);
        }
      }
    }));
  } catch (err) {
    console.error('[push] sendPush error:', err.message);
  }
}

module.exports = { isPushConfigured, getPublicKey, saveSubscription, removeSubscription, sendPush };