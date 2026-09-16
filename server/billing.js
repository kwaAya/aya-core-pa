// ─── Billing — PayFast recurring subscriptions (ZAR) ─────────────────────────
// PayFast because you've shipped it before and it settles into a SA bank account
// without the Stripe entity headache. Swap-friendly: everything provider-specific
// is in this file, and the rest of the app only reads users.plan.
//
// Required env vars:
//   PAYFAST_MERCHANT_ID
//   PAYFAST_MERCHANT_KEY
//   PAYFAST_PASSPHRASE        (set one in the PayFast dashboard — not optional here)
//   PAYFAST_MODE=sandbox|live
//   APP_URL=https://aya-core-pa-production.up.railway.app

const crypto = require('crypto');
const db = require('./db');
const { requireUser } = require('./auth');
const { PLANS, usageSummary, rateLimit } = require('./plan');

const MODE = process.env.PAYFAST_MODE === 'live' ? 'live' : 'sandbox';
const PF_HOST = MODE === 'live' ? 'www.payfast.co.za' : 'sandbox.payfast.co.za';
const PF_PROCESS = `https://${PF_HOST}/eng/process`;
const PF_VALIDATE = `https://${PF_HOST}/eng/query/validate`;

// PayFast's published ITN source hosts — we resolve these at call time.
const PF_VALID_HOSTS = [
  'www.payfast.co.za', 'sandbox.payfast.co.za',
  'w1w.payfast.co.za', 'w2w.payfast.co.za',
];

function appUrl() {
  return (process.env.APP_URL || '').replace(/\/$/, '');
}

// ─── Signature ────────────────────────────────────────────────────────────────
// MD5 over the urlencoded param string, in submission order, passphrase appended.
// PayFast encodes spaces as '+' and expects uppercase percent-escapes.

function pfEncode(value) {
  return encodeURIComponent(String(value).trim())
    .replace(/%20/g, '+')
    .replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function signature(params, passphrase) {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${pfEncode(v)}`);
  if (passphrase) parts.push(`passphrase=${pfEncode(passphrase)}`);
  return crypto.createHash('md5').update(parts.join('&')).digest('hex');
}

// ─── ITN verification ─────────────────────────────────────────────────────────

async function isValidPayfastHost(ip) {
  const dns = require('dns').promises;
  for (const host of PF_VALID_HOSTS) {
    try {
      const addrs = await dns.resolve4(host);
      if (addrs.includes(ip)) return true;
    } catch { /* keep checking */ }
  }
  return false;
}

async function confirmWithPayfast(rawBody) {
  try {
    const res = await fetch(PF_VALIDATE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: rawBody,
    });
    const text = (await res.text()).trim();
    return text === 'VALID';
  } catch (err) {
    console.error('[billing] PayFast validate call failed:', err.message);
    return false;
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

function registerBillingRoutes(app) {
  // Public: what's on offer
  app.get('/api/billing/plans', (req, res) => {
    res.json(Object.values(PLANS).map(p => ({
      id: p.id, name: p.name, priceZAR: p.priceZAR, blurb: p.blurb,
      limits: Object.fromEntries(
        Object.entries(p.limits).map(([k, v]) => [k, v === Infinity ? null : v])
      ),
    })));
  });

  // Current plan + usage — drives the upgrade prompts in the UI
  app.get('/api/billing/me', requireUser, async (req, res) => {
    try {
      res.json(await usageSummary(req.userId));
    } catch (err) {
      console.error('[billing] me failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Build a signed PayFast subscription form. The frontend POSTs these fields to `action`.
  app.post('/api/billing/checkout', requireUser, rateLimit({ max: 10, windowMs: 60_000 }), async (req, res) => {
    const merchantId = process.env.PAYFAST_MERCHANT_ID;
    const merchantKey = process.env.PAYFAST_MERCHANT_KEY;
    const passphrase = process.env.PAYFAST_PASSPHRASE;

    if (!merchantId || !merchantKey || !passphrase) {
      return res.status(503).json({ error: 'billing not configured' });
    }

    const planId = (req.body?.plan || 'pro').toLowerCase();
    const plan = PLANS[planId];
    if (!plan || plan.priceZAR <= 0) return res.status(400).json({ error: 'not a payable plan' });

    const user = await db.prepare(`SELECT id, email, name FROM users WHERE id = ?`).get(req.userId);
    if (!user) return res.status(404).json({ error: 'user not found' });

    const base = appUrl();
    // Field order matters — PayFast signs in submission order.
    const params = {
      merchant_id: merchantId,
      merchant_key: merchantKey,
      return_url: `${base}/app.html?billing=success`,
      cancel_url: `${base}/app.html?billing=cancelled`,
      notify_url: `${base}/api/billing/payfast/itn`,
      name_first: (user.name || '').split(' ')[0] || 'Member',
      email_address: user.email,
      m_payment_id: `u${user.id}-${planId}-${Date.now()}`,
      amount: plan.priceZAR.toFixed(2),
      item_name: `Aya Core PA — ${plan.name}`,
      custom_str1: String(user.id),
      custom_str2: planId,
      subscription_type: '1',
      billing_date: new Date().toISOString().slice(0, 10),
      recurring_amount: plan.priceZAR.toFixed(2),
      frequency: '3', // monthly
      cycles: '0',    // until cancelled
    };

    params.signature = signature(params, passphrase);
    res.json({ action: PF_PROCESS, fields: params });
  });

  // ITN webhook. Mounted with a raw body parser in index.js so we can both
  // verify the signature and echo the exact payload back to PayFast.
  app.post('/api/billing/payfast/itn', async (req, res) => {
    // Always 200 fast — PayFast retries on anything else and we don't want a retry storm.
    res.status(200).end();

    try {
      const rawBody = req.body instanceof Buffer ? req.body.toString('utf8') : String(req.body || '');
      const data = Object.fromEntries(new URLSearchParams(rawBody));
      const passphrase = process.env.PAYFAST_PASSPHRASE;

      // 1. signature
      const received = data.signature;
      const { signature: _drop, ...rest } = data;
      if (!received || signature(rest, passphrase) !== received) {
        return console.warn('[billing] ITN rejected: bad signature');
      }

      // 2. source host
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
      const cleanIp = String(ip).replace(/^::ffff:/, '');
      if (!(await isValidPayfastHost(cleanIp))) {
        return console.warn('[billing] ITN rejected: untrusted source', cleanIp);
      }

      // 3. echo back for server-side confirmation
      if (!(await confirmWithPayfast(rawBody))) {
        return console.warn('[billing] ITN rejected: PayFast said INVALID');
      }

      const userId = parseInt(data.custom_str1, 10);
      const planId = data.custom_str2 || 'pro';
      const plan = PLANS[planId];
      if (!userId || !plan) return console.warn('[billing] ITN missing user/plan');

      // 4. amount matches what we charge — blocks a tampered R1 "upgrade"
      const paid = parseFloat(data.amount_gross || data.amount || '0');
      if (Math.abs(paid - plan.priceZAR) > 0.01) {
        return console.warn('[billing] ITN amount mismatch:', paid, 'vs', plan.priceZAR);
      }

      // 5. idempotency — PayFast can deliver the same ITN more than once
      const pfId = data.pf_payment_id || data.m_payment_id;
      const seen = await db.prepare(`SELECT id FROM billing_events WHERE provider_ref = ?`).get(String(pfId));
      if (seen) return;

      await db.prepare(
        `INSERT INTO billing_events (user_id, provider, provider_ref, status, amount, plan, payload, created_at)
         VALUES (?, 'payfast', ?, ?, ?, ?, ?, ?)`
      ).run(userId, String(pfId), data.payment_status || 'UNKNOWN', paid, planId, rawBody.slice(0, 4000), new Date().toISOString());

      const status = (data.payment_status || '').toUpperCase();
      if (status === 'COMPLETE') {
        // 35 days of grace so a late recurring charge doesn't lock someone out mid-month
        const expires = new Date(Date.now() + 35 * 24 * 60 * 60 * 1000).toISOString();
        await db.prepare(
          `UPDATE users SET plan = ?, plan_expires_at = ?, payfast_token = ? WHERE id = ?`
        ).run(planId, expires, data.token || null, userId);
        console.log(`[billing] user ${userId} → ${planId} until ${expires}`);
      } else if (status === 'CANCELLED') {
        await db.prepare(`UPDATE users SET plan = 'free' WHERE id = ?`).run(userId);
        console.log(`[billing] user ${userId} subscription cancelled`);
      }
    } catch (err) {
      console.error('[billing] ITN handler error:', err.message);
    }
  });
}

module.exports = { registerBillingRoutes, signature, pfEncode };