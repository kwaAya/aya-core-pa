const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_COOKIE = 'pa_session';
const TOKEN_TTL = '30d';

if (!JWT_SECRET) {
  console.warn('[auth] JWT_SECRET not set — set one in your env vars before using auth in production.');
}

// ─── Password hashing (scrypt — built into Node, no native deps) ──────────────

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  // timing-safe comparison
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(check, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ─── JWT issue/verify ──────────────────────────────────────────────────────────

function issueToken(userId) {
  return jwt.sign({ uid: userId }, JWT_SECRET || 'dev-insecure-secret', { expiresIn: TOKEN_TTL });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET || 'dev-insecure-secret');
  } catch {
    return null;
  }
}

// ─── Middleware — attaches req.userId if a valid session cookie is present ────
// Does NOT block the request if missing — routes decide whether auth is required.

function attachUser(req, res, next) {
  const token = req.cookies?.[TOKEN_COOKIE];
  if (token) {
    const payload = verifyToken(token);
    if (payload) req.userId = payload.uid;
  }
  next();
}

// ─── Middleware — blocks the request if not authenticated ─────────────────────

function requireUser(req, res, next) {
  if (!req.userId) return res.status(401).json({ error: 'not signed in' });
  next();
}

// ─── Routes ─────────────────────────────────────────────────────────────────────

function registerAuthRoutes(app) {
  app.post('/api/auth/signup', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password || password.length < 8) {
      return res.status(400).json({ error: 'email and a password (8+ chars) are required' });
    }
    const existing = await db.prepare(`SELECT id FROM users WHERE email = ?`).get(email.toLowerCase().trim());
    if (existing) return res.status(409).json({ error: 'an account with that email already exists' });

    const { hash, salt } = hashPassword(password);
    const now = new Date().toISOString();
    const result = await db.prepare(
      `INSERT INTO users (email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?)`
    ).run(email.toLowerCase().trim(), hash, salt, now);

    const userId = result.lastInsertRowid;
    const token = issueToken(userId);
    res.cookie(TOKEN_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: true, maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.json({ ok: true, userId });
  });

  app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });

    const user = await db.prepare(`SELECT * FROM users WHERE email = ?`).get(email.toLowerCase().trim());
    if (!user || !verifyPassword(password, user.password_hash, user.password_salt)) {
      return res.status(401).json({ error: 'invalid email or password' });
    }

    const token = issueToken(user.id);
    res.cookie(TOKEN_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: true, maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.json({ ok: true, userId: user.id });
  });

  app.post('/api/auth/logout', (req, res) => {
    res.clearCookie(TOKEN_COOKIE);
    res.status(204).end();
  });

  app.get('/api/auth/me', attachUser, (req, res) => {
    if (!req.userId) return res.status(401).json({ error: 'not signed in' });
    res.json({ userId: req.userId });
  });
}

module.exports = { hashPassword, verifyPassword, issueToken, verifyToken, attachUser, requireUser, registerAuthRoutes };