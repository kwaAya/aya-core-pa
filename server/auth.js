const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_COOKIE = 'pa_session';
const TOKEN_TTL = '30d';
const VERIFY_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error(
    '[auth] FATAL: JWT_SECRET is missing or too short (need 32+ chars).\n' +
    '       Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"\n' +
    '       Then set it in Railway Variables.'
  );
  process.exit(1);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function emailDeliveryConfigured() {
  // Local development deliberately logs the OTP instead of silently creating
  // accounts that nobody can verify. Production must have a real sender.
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM) || process.env.NODE_ENV !== 'production';
}

function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  };
}

function issueSession(res, userId) {
  res.cookie(TOKEN_COOKIE, issueToken(userId), sessionCookieOptions());
}

// Password hashing (scrypt - built into Node, no native dependency required)
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(check, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function issueToken(userId) {
  return jwt.sign({ uid: userId }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function issueVerificationToken(userId) {
  return jwt.sign({ uid: userId, purpose: 'email_verification' }, JWT_SECRET, { expiresIn: '15m' });
}

function verifyVerificationToken(token) {
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return payload.purpose === 'email_verification' ? payload : null;
  } catch {
    return null;
  }
}

function codeHash(userId, code) {
  // A raw OTP never reaches the database. The user id makes each stored hash
  // unique even when two people happen to receive the same six digits.
  return crypto.createHmac('sha256', JWT_SECRET).update(`${userId}:${code}`).digest('hex');
}

function generateCode() {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

// Off for now — flip to true once RESEND_API_KEY/EMAIL_FROM are actually configured.
const EMAIL_VERIFICATION_ENABLED = false;

function requiresEmailVerification(user) {
  if (!EMAIL_VERIFICATION_ENABLED) return false;
  return Boolean(user?.email_verification_required) && !user?.email_verified_at;
}

async function sendVerificationEmail(email, code) {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`[auth] DEV ONLY verification code for ${email}: ${code}`);
      return;
    }
    throw new Error('email delivery is not configured');
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to: [email],
      subject: 'Your Core PA verification code',
      text: `Your Core PA verification code is ${code}. It expires in 10 minutes. If you did not create an account, you can ignore this email.`,
      html: `<div style="font-family:Arial,sans-serif;color:#171217"><h2>Verify your Core PA account</h2><p>Use this code to finish creating your account:</p><p style="font-size:32px;letter-spacing:8px;font-weight:700">${code}</p><p>This code expires in 10 minutes. If you did not create an account, you can ignore this email.</p></div>`,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`email provider rejected the request (${response.status}): ${detail.slice(0, 200)}`);
  }
}

async function createVerificationChallenge(user) {
  const code = generateCode();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + VERIFY_TTL_MS).toISOString();
  await db.prepare(
    `UPDATE users SET verification_code_hash = ?, verification_code_expires_at = ?, verification_code_sent_at = ?, verification_attempts = 0 WHERE id = ?`
  ).run(codeHash(user.id, code), expiresAt, now.toISOString(), user.id);
  await sendVerificationEmail(user.email, code);
}

function attachUser(req, res, next) {
  const token = req.cookies?.[TOKEN_COOKIE];
  if (token) {
    const payload = verifyToken(token);
    if (payload) req.userId = payload.uid;
  }
  next();
}

function requireUser(req, res, next) {
  if (!req.userId) return res.status(401).json({ error: 'not signed in' });
  next();
}

function registerAuthRoutes(app) {
  app.post('/api/auth/signup', async (req, res) => {
    const { email, password, name } = req.body || {};
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail || !password || password.length < 8) {
      return res.status(400).json({ error: 'email and a password (8+ characters) are required' });
    }
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (EMAIL_VERIFICATION_ENABLED && !emailDeliveryConfigured()) {
      return res.status(503).json({ error: 'account verification email is not configured yet; please try again later' });
    }

    const existing = await db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
    if (existing) return res.status(409).json({ error: 'an account with that email already exists' });

    const { hash, salt } = hashPassword(password);
    const now = new Date().toISOString();

    if (!EMAIL_VERIFICATION_ENABLED) {
      const result = await db.prepare(
        `INSERT INTO users (email, name, password_hash, password_salt, created_at, email_verification_required)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(normalizedEmail, name.trim(), hash, salt, now, 0);
      issueSession(res, result.lastInsertRowid);
      return res.status(201).json({ ok: true, userId: result.lastInsertRowid, name: name.trim(), emailVerified: true });
    }

    try {
      const result = await db.prepare(
        `INSERT INTO users (email, name, password_hash, password_salt, created_at, email_verification_required)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(normalizedEmail, name.trim(), hash, salt, now, 1);
      const user = { id: result.lastInsertRowid, email: normalizedEmail, name: name.trim() };
      await createVerificationChallenge(user);
      res.status(201).json({
        ok: true,
        verificationRequired: true,
        email: normalizedEmail,
        verificationToken: issueVerificationToken(user.id),
      });
    } catch (err) {
      console.error('[auth] signup verification setup failed:', err.message);
      // Do not leave a permanently unusable account behind when the first
      // verification email cannot be prepared or delivered.
      await db.prepare('DELETE FROM users WHERE email = ? AND email_verified_at IS NULL').run(normalizedEmail).catch(() => {});
      res.status(502).json({ error: 'we could not send your verification code; please try again' });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body || {};
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail || !password) return res.status(400).json({ error: 'email and password required' });

    const user = await db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);
    if (!user || !verifyPassword(password, user.password_hash, user.password_salt)) {
      return res.status(401).json({ error: 'invalid email or password' });
    }
    if (requiresEmailVerification(user)) {
      return res.status(403).json({
        error: 'verify your email to continue',
        verificationRequired: true,
        email: user.email,
        verificationToken: issueVerificationToken(user.id),
      });
    }

    issueSession(res, user.id);
    res.json({ ok: true, userId: user.id, name: user.name, emailVerified: Boolean(user.email_verified_at) });
  });

  app.post('/api/auth/resend-verification', async (req, res) => {
    const payload = verifyVerificationToken(req.body?.verificationToken);
    if (!payload) return res.status(401).json({ error: 'your verification session expired; sign in again' });

    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid);
    if (!user || !requiresEmailVerification(user)) return res.status(400).json({ error: 'this account does not need verification' });
    const lastSent = user.verification_code_sent_at ? Date.parse(user.verification_code_sent_at) : 0;
    const retryIn = RESEND_COOLDOWN_MS - (Date.now() - lastSent);
    if (retryIn > 0) {
      return res.status(429).json({ error: `wait ${Math.ceil(retryIn / 1000)} seconds before requesting another code` });
    }
    if (!emailDeliveryConfigured()) return res.status(503).json({ error: 'account verification email is not configured yet' });

    try {
      await createVerificationChallenge(user);
      res.json({ ok: true, verificationToken: issueVerificationToken(user.id) });
    } catch (err) {
      console.error('[auth] resend verification failed:', err.message);
      res.status(502).json({ error: 'we could not resend your code; please try again' });
    }
  });

  app.post('/api/auth/verify-email', async (req, res) => {
    const { verificationToken, code } = req.body || {};
    const payload = verifyVerificationToken(verificationToken);
    if (!payload) return res.status(401).json({ error: 'your verification session expired; sign in again' });
    if (!/^\d{6}$/.test(String(code || ''))) return res.status(400).json({ error: 'enter the six-digit code from your email' });

    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid);
    if (!user || !requiresEmailVerification(user)) return res.status(400).json({ error: 'this account does not need verification' });
    if (!user.verification_code_expires_at || Date.parse(user.verification_code_expires_at) < Date.now()) {
      return res.status(400).json({ error: 'that code has expired; request a new one' });
    }
    if (Number(user.verification_attempts || 0) >= MAX_VERIFY_ATTEMPTS) {
      return res.status(429).json({ error: 'too many incorrect codes; request a new one' });
    }

    const expected = Buffer.from(codeHash(user.id, String(code)), 'hex');
    const stored = Buffer.from(user.verification_code_hash || '', 'hex');
    const matches = stored.length === expected.length && crypto.timingSafeEqual(stored, expected);
    if (!matches) {
      await db.prepare('UPDATE users SET verification_attempts = verification_attempts + 1 WHERE id = ?').run(user.id);
      return res.status(400).json({ error: 'that code is not correct' });
    }

    const verifiedAt = new Date().toISOString();
    await db.prepare(
      `UPDATE users SET email_verified_at = ?, verification_code_hash = NULL, verification_code_expires_at = NULL,
       verification_code_sent_at = NULL, verification_attempts = 0 WHERE id = ?`
    ).run(verifiedAt, user.id);
    issueSession(res, user.id);
    res.json({ ok: true, userId: user.id, name: user.name, emailVerified: true });
  });

  app.post('/api/auth/logout', (req, res) => {
    res.clearCookie(TOKEN_COOKIE, sessionCookieOptions());
    res.status(204).end();
  });

  app.get('/api/auth/me', attachUser, async (req, res) => {
    if (!req.userId) return res.status(401).json({ error: 'not signed in' });
    const user = await db.prepare('SELECT id, email, name, email_verified_at, email_verification_required FROM users WHERE id = ?').get(req.userId);
    if (!user) return res.status(401).json({ error: 'not signed in' });
    res.json({ userId: req.userId, email: user.email, name: user.name, emailVerified: !requiresEmailVerification(user) });
  });

  // Legacy rows were created before accounts existed. This can only be run by
  // the explicitly configured owner; otherwise a new account could claim data
  // it does not own simply because user_id is NULL.
  app.post('/api/auth/claim-legacy-data', requireUser, async (req, res) => {
    const ownerEmail = normalizeEmail(process.env.LEGACY_DATA_OWNER_EMAIL);
    const user = await db.prepare('SELECT email FROM users WHERE id = ?').get(req.userId);
    if (!ownerEmail || normalizeEmail(user?.email) !== ownerEmail) {
      return res.status(403).json({ error: 'legacy data migration is restricted to the configured owner' });
    }
    try {
      const tasksResult = await db.prepare('UPDATE tasks SET user_id = ? WHERE user_id IS NULL').run(req.userId);
      const finResult = await db.prepare('UPDATE finance_entries SET user_id = ? WHERE user_id IS NULL').run(req.userId);
      res.json({ ok: true, tasksClaimed: tasksResult.changes || 0, financeClaimed: finResult.changes || 0 });
    } catch (err) {
      console.error('[auth] claim-legacy-data failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = {
  hashPassword,
  verifyPassword,
  issueToken,
  verifyToken,
  attachUser,
  requireUser,
  registerAuthRoutes,
};
