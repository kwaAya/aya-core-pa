// ─── Plans, quotas and usage metering ────────────────────────────────────────
// This is the layer that protects your margin. Every AI call and every statement
// import costs you real money; without metering, one user on a free account can
// run up your Groq/Gemini bill with no ceiling.

const db = require('./db');

const PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    priceZAR: 0,
    limits: { ai_message: 40, statement_import: 2, transcribe: 15, task: 30 },
    blurb: 'Try the whole thing. Resets monthly.',
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceZAR: 99,
    limits: { ai_message: 1500, statement_import: 40, transcribe: 400, task: Infinity },
    blurb: 'Everything, effectively uncapped for normal use.',
  },
};

const DEFAULT_PLAN = 'free';

// ─── Plan lookup ──────────────────────────────────────────────────────────────

async function getUserPlan(userId) {
  const row = await db.prepare(
    `SELECT plan, plan_expires_at FROM users WHERE id = ?`
  ).get(userId);

  let planId = row?.plan || DEFAULT_PLAN;

  // expired paid plan silently falls back to free
  if (planId !== 'free' && row?.plan_expires_at) {
    if (new Date(row.plan_expires_at) < new Date()) planId = 'free';
  }
  return PLANS[planId] || PLANS.free;
}

// ─── Usage counting (calendar month) ──────────────────────────────────────────

function monthStart() {
  return new Date().toISOString().slice(0, 7) + '-01T00:00:00.000Z';
}

async function getUsage(userId, kind) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM usage_events
     WHERE user_id = ? AND kind = ? AND created_at >= ?`
  ).get(userId, kind, monthStart());
  return row ? Number(row.n || 0) : 0;
}

async function recordUsage(userId, kind, units = 1) {
  const now = new Date().toISOString();
  for (let i = 0; i < units; i++) {
    await db.prepare(
      `INSERT INTO usage_events (user_id, kind, created_at) VALUES (?, ?, ?)`
    ).run(userId, kind, now);
  }
}

async function usageSummary(userId) {
  const plan = await getUserPlan(userId);
  const out = {};
  for (const kind of Object.keys(plan.limits)) {
    const limit = plan.limits[kind];
    const used = kind === 'task'
      ? Number((await db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE user_id = ? AND status = 'open'`).get(userId))?.n || 0)
      : await getUsage(userId, kind);
    out[kind] = { used, limit: limit === Infinity ? null : limit };
  }
  return { plan: { id: plan.id, name: plan.name, priceZAR: plan.priceZAR }, usage: out };
}

// ─── Middleware — blocks the request when the quota is spent ──────────────────
// Usage is recorded only after the handler succeeds, so failed calls are free.

function enforceQuota(kind) {
  return async function (req, res, next) {
    try {
      const plan = await getUserPlan(req.userId);
      const limit = plan.limits[kind];
      if (limit === undefined || limit === Infinity) return next();

      const used = kind === 'task'
        ? Number((await db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE user_id = ? AND status = 'open'`).get(req.userId))?.n || 0)
        : await getUsage(req.userId, kind);

      if (used >= limit) {
        return res.status(402).json({
          error: 'quota_exceeded',
          kind,
          used,
          limit,
          plan: plan.id,
          message: `You've hit your ${plan.name} plan limit for this. Upgrade to keep going.`,
        });
      }

      // record on the way out, only if the handler actually succeeded
      if (kind !== 'task') {
        res.on('finish', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            recordUsage(req.userId, kind).catch(e =>
              console.error('[plan] recordUsage failed:', e.message)
            );
          }
        });
      }
      next();
    } catch (err) {
      console.error('[plan] enforceQuota error:', err.message);
      next(); // fail open — never lock a paying user out because of a metering bug
    }
  };
}

// ─── Simple in-memory rate limiter (no new dependency) ───────────────────────
// Stops brute-force on /api/auth/login and abuse bursts on expensive routes.
// Single-instance only — if you ever scale Railway past one replica, move this
// to Postgres or Redis.

const buckets = new Map();

function rateLimit({ windowMs = 60_000, max = 30, key } = {}) {
  return function (req, res, next) {
    const id = (key ? key(req) : null) || req.userId || req.ip;
    const bucketKey = `${req.path}:${id}`;
    const now = Date.now();
    let b = buckets.get(bucketKey);
    if (!b || now > b.reset) {
      b = { count: 0, reset: now + windowMs };
      buckets.set(bucketKey, b);
    }
    b.count++;
    if (b.count > max) {
      res.set('Retry-After', String(Math.ceil((b.reset - now) / 1000)));
      return res.status(429).json({ error: 'too many requests, slow down a sec' });
    }
    next();
  };
}

// keep the map from growing forever
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k);
}, 5 * 60_000).unref();

module.exports = {
  PLANS, getUserPlan, getUsage, recordUsage, usageSummary, enforceQuota, rateLimit,
};