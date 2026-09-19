/**
 * finance-import.js
 * CSV statement parser + adaptive merchant categorisation.
 *
 * Supports:
 *  - Capitec CSV export (primary target)
 *  - Generic CSV fallback (auto-detects columns)
 *
 * Privacy rules (hard):
 *  - Account numbers, card numbers, ID numbers are stripped and never stored.
 *  - Raw file is deleted from disk immediately after parsing.
 *  - Only date, amount, and sanitised description reach the DB.
 */

const { parse } = require('csv-parse/sync');
const fs         = require('fs');
const db         = require('./db');
// ─── Category keywords (seed rules before user teaches the system) ────────────
const SEED_RULES = [
  // ── Food ──────────────────────────────────────────────────────────────────
  { pattern: 'shoprite',       category: 'food' },
  { pattern: 'checkers',       category: 'food' },
  { pattern: 'sixty60',        category: 'food' },
  { pattern: 'pick n pay',     category: 'food' },
  { pattern: 'spar',           category: 'food' },
  { pattern: 'woolworths food',category: 'food' },
  { pattern: 'food lover',     category: 'food' },
  { pattern: 'mcdonalds',      category: 'food' },
  { pattern: 'mcd ',           category: 'food' },
  { pattern: 'kfc',            category: 'food' },
  { pattern: 'steers',         category: 'food' },
  { pattern: 'nandos',         category: 'food' },
  { pattern: 'debonairs',      category: 'food' },
  { pattern: 'debonair',       category: 'food' },
  { pattern: 'uber eats',      category: 'food' },
  { pattern: 'uber_eats',      category: 'food' },
  { pattern: 'new uber eats',  category: 'food' },
  { pattern: 'dl uber eats',   category: 'food' },
  { pattern: 'dl*uber eats',   category: 'food' },
  { pattern: 'mr delivery',    category: 'food' },
  { pattern: 'bolt food',      category: 'food' },
  { pattern: 'andilbotanics',  category: 'food' },
  { pattern: 'maagroceries',   category: 'food' },
  { pattern: 'sabelosupply',   category: 'food' },
  { pattern: 'hiwaysuper',     category: 'food' },
  { pattern: 'gloryminimarket',category: 'food' },
  { pattern: 'deep see fish',  category: 'food' },
  { pattern: 'cutsport',       category: 'food' },
  { pattern: 'the friend supermarket', category: 'food' },
  { pattern: 'mmops food',     category: 'food' },
  { pattern: 'mozambik',       category: 'food' },
  { pattern: 'braza',          category: 'food' },
  { pattern: 'chicago restaurant', category: 'food' },
  { pattern: 'tinsaecashstore',category: 'food' },
  { pattern: 'goldensupermrkt',category: 'food' },
  { pattern: 'ccn*maa groceries', category: 'food' },
  // ── Transport ─────────────────────────────────────────────────────────────
  { pattern: 'uber',           category: 'transport' },
  { pattern: 'dl uber',        category: 'transport' },
  { pattern: 'dl*uber',        category: 'transport' },
  { pattern: 'bolt',           category: 'transport' },
  { pattern: 'dl bolt',        category: 'transport' },
  { pattern: 'indriver',       category: 'transport' },
  { pattern: 'taxi maxim',     category: 'transport' },
  { pattern: 'dlocal *taxi',   category: 'transport' },
  { pattern: 'intercape',      category: 'transport' },
  { pattern: 'intercal',       category: 'transport' },
  { pattern: 'engen',          category: 'transport' },
  { pattern: 'sasol',          category: 'transport' },
  { pattern: 'shell',          category: 'transport' },
  { pattern: 'bp ',            category: 'transport' },
  { pattern: 'caltex',         category: 'transport' },
  // ── Bills ─────────────────────────────────────────────────────────────────
  { pattern: 'netflix',        category: 'bills' },
  { pattern: 'spotify',        category: 'bills' },
  { pattern: 'showmax',        category: 'bills' },
  { pattern: 'dstv',           category: 'bills' },
  { pattern: 'telkom',         category: 'bills' },
  { pattern: 'vodacom',        category: 'bills' },
  { pattern: 'mtn',            category: 'bills' },
  { pattern: 'cell c',         category: 'bills' },
  { pattern: 'cellphone',      category: 'bills' },
  { pattern: 'prepaid mobile', category: 'bills' },
  { pattern: 'southsidecell',  category: 'bills' },
  { pattern: 'jimmys cell',    category: 'bills' },
  { pattern: 'rain',           category: 'bills' },
  { pattern: 'google one',     category: 'bills' },
  { pattern: 'google *google one', category: 'bills' },
  { pattern: 'apple.com',      category: 'bills' },
  { pattern: 'apple.com/bill', category: 'bills' },
  { pattern: 'electricity',    category: 'bills' },
  { pattern: 'eskom',          category: 'bills' },
  { pattern: 'municipality',   category: 'bills' },
  { pattern: 'rent',           category: 'bills' },
  // ── Income ────────────────────────────────────────────────────────────────
  { pattern: 'salary',         category: 'income' },
  { pattern: 'payroll',        category: 'income' },
  { pattern: 'fundi payment',  category: 'income' },
  { pattern: 'tcps fundi',     category: 'income' },
  { pattern: 'cashfocus',      category: 'income' },
  { pattern: 'payment received', category: 'income' },
  { pattern: 'payshap payment received', category: 'income' },
  // ── General / shopping ───────────────────────────────────────────────────
  { pattern: 'woolworths',     category: 'general' },
  { pattern: 'clicks',         category: 'general' },
  { pattern: 'dischem',        category: 'general' },
  { pattern: 'mr price',       category: 'general' },
  { pattern: 'takealot',       category: 'general' },
  { pattern: 'bash ',          category: 'general' },
  { pattern: 'amazon',         category: 'general' },
  { pattern: 'xmbeautystudio', category: 'general' },
  { pattern: 'dreams for uz',  category: 'general' },
  { pattern: 'computicket',    category: 'general' },
  { pattern: 'nu metro',       category: 'general' },
  { pattern: 'numetro',        category: 'general' },
  { pattern: 'chicago pub',    category: 'other' },
  { pattern: 'hightide',       category: 'other' },
  { pattern: 'high tide',      category: 'other' },
  { pattern: 'sportingbet',    category: 'other' },
  { pattern: 'budtender',      category: 'other' },
  { pattern: 'hashcannabis',   category: 'other' },
];

// ─── Privacy patterns to strip from descriptions ──────────────────────────────
const PRIVACY_STRIP = [
  /\b\d{13}\b/g,                     // SA ID numbers (13 digits)
  /\b\d{16}\b/g,                     // Card numbers (16 digits)
  /\b\d{10,12}\b/g,                  // Account numbers (10-12 digits)
  /\baccount\s*:?\s*\d+\b/gi,        // "account: 1234..."
  /\bcard\s*:?\s*[\d*]+\b/gi,        // "card: 4123..."
  /\b\d{4}\s\d{4}\s\d{4}\s\d{4}\b/g,// spaced card format
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sanitiseDescription(raw) {
  if (!raw) return '';
  let s = raw.trim();
  for (const pattern of PRIVACY_STRIP) s = s.replace(pattern, '***');
  // collapse multiple spaces
  return s.replace(/\s{2,}/g, ' ').trim();
}

function normaliseMerchant(description) {
  return description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    // remove common noise words from SA bank statements
    .replace(/\b(pos|payment|purchase|debit|credit|transfer|ref|rfn|trn|za|south africa)\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 60); // cap length
}

async function lookupCategory(merchant, userId) {
  // 1. check this user's learned mappings first (highest priority)
  const learned = await db.prepare(
    `SELECT category FROM merchant_category_map WHERE ? LIKE '%' || pattern || '%' AND user_id = ? ORDER BY hit_count DESC LIMIT 1`
  ).get(merchant, userId);
  if (learned) return learned.category;

  // 2. fall back to seed rules
  for (const rule of SEED_RULES) {
    if (merchant.includes(rule.pattern)) return rule.category;
  }

  // 3. no match at all — flag for batched AI categorisation later.
  // Returning null (not 'general') lets the batch step tell "genuinely
  // uncategorised" apart from "explicitly general" on purpose.
  return null;
}

// ─── AI categorisation for merchants nothing else recognised ─────────────────
// Called once per import with every still-uncategorised merchant, not per
// transaction — one AI call for the whole batch, not one per row.
async function categoriseWithAI(merchants, userId) {
  if (!merchants.length) return {};

  // Same provider fallback order as reasoning.js's chat assistant (Groq →
  // Gemini → OpenRouter). This used to only try Groq/Gemini, so once the
  // Gemini key ran out of quota and OpenRouter became the working provider,
  // this function silently returned {} on every import — every unresolved
  // merchant fell through to 'general' with no error surfaced anywhere.
  const providers = [];
  if (process.env.GROQ_API_KEY) {
    providers.push({
      name: 'groq',
      url: 'https://api.groq.com/openai/v1/chat/completions',
      model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    });
  }
  if (process.env.GEMINI_API_KEY) {
    providers.push({
      name: 'gemini',
      url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      model: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GEMINI_API_KEY}` },
    });
  }
  if (process.env.OPENROUTER_API_KEY) {
    providers.push({
      name: 'openrouter',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      model: process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': process.env.APP_URL || 'https://corepa.app',
        'X-Title': process.env.APP_NAME || 'Core PA',
      },
    });
  }
  if (!providers.length) return {};

  const existing = await db.prepare(
    `SELECT DISTINCT category FROM finance_entries WHERE user_id = ? AND category IS NOT NULL`
  ).all(userId);
  const existingCategories = [...new Set(existing.map(r => r.category))];
  const userCats = await db.prepare(`SELECT name FROM categories WHERE user_id = ?`).all(userId);
  const knownCategories = [...new Set([...existingCategories, ...userCats.map(c => c.name)])];

  const prompt = `You are categorising bank statement merchants for a personal finance app.

Existing categories this user already has: ${knownCategories.length ? knownCategories.join(', ') : '(none yet)'}

For each merchant below, either:
- assign one of the existing categories above if it genuinely fits, OR
- propose a new, short, lowercase category name (one or two words, e.g. "nightlife", "subscriptions", "health") if nothing existing fits well

Merchants to categorise:
${merchants.map((m, i) => `${i + 1}. ${m}`).join('\n')}

Respond with ONLY a JSON object, no markdown, no explanation:
{"merchant name exactly as given": "category", ...}`;

  const callAI = async (provider) => {
    const res = await fetch(provider.url, {
      method: 'POST',
      headers: provider.headers,
      body: JSON.stringify({ model: provider.model, max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) throw new Error(`${provider.name} categorisation error (${res.status})`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '{}';
  };

  let raw;
  for (const provider of providers) {
    try {
      raw = await callAI(provider);
      break;
    } catch (err) {
      console.error(`[finance-import] ${provider.name} categorisation failed, trying next provider:`, err.message);
    }
  }
  if (!raw) {
    console.error('[finance-import] all AI providers failed for categorisation — falling back to general');
    return {};
  }

  try {
    const cleaned = raw.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
    const start = cleaned.indexOf('{');
    const end   = cleaned.lastIndexOf('}');
    const rawResult = JSON.parse(cleaned.slice(start, end + 1));

    // The model doesn't reliably echo merchant keys back byte-for-byte — it
    // can keep the "1. " list prefix, change casing, or add stray whitespace.
    // Callers match with a plain `resolved[t.merchant]`, so any of that
    // silently sent every unresolved transaction to 'general' with nothing
    // logged anywhere. Normalise both sides the same way before returning.
    const result = {};
    for (const [rawKey, rawVal] of Object.entries(rawResult)) {
      const key = String(rawKey).trim().replace(/^\d+[.)]\s*/, '').toLowerCase();
      const val = String(rawVal).trim().toLowerCase();
      if (key && val) result[key] = val;
    }

    // any category the AI proposed that we don't already have gets created
    const now = new Date().toISOString();
    const knownCategoriesLower = knownCategories.map(c => c.toLowerCase());
    const newCats = [...new Set(Object.values(result))].filter(c => !knownCategoriesLower.includes(c));
    for (const cat of newCats) {
      await db.prepare(
        `INSERT INTO categories (user_id, name, created_at) VALUES (?, ?, ?) ON CONFLICT (user_id, name) DO NOTHING`
      ).run(userId, cat, now);
    }
    return result;
  } catch (err) {
    console.error('[finance-import] AI categorisation parse failed:', err.message, raw);
    return {};
  }
}

async function seedMerchantMap() {
  const now = new Date().toISOString();
  for (const rule of SEED_RULES) {
    await db.prepare(`
      INSERT INTO merchant_category_map (pattern, category, hit_count, updated_at)
      VALUES (?, ?, 1, ?)
      ON CONFLICT (pattern) DO NOTHING
    `).run(rule.pattern, rule.category, now);
  }
}

// call once on module load to ensure seed rules exist
seedMerchantMap().catch(err => console.error('[finance-import] seed failed:', err.message));

// ─── Capitec CSV parser ───────────────────────────────────────────────────────
// Real Capitec format (from the banking app CSV export):
// Nr, Account, Posting Date, Transaction Date, Description, Original Description,
// Parent Category, Category, Money In, Money Out, Fee, Balance
//
// Also handles generic fallbacks (Amount, Debit/Credit columns).

async function parseCapitecCSV(csvText, userId) {
  const rows = parse(csvText, {
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });

  if (rows.length < 2) throw new Error('CSV appears empty or has no data rows');

  // normalise header names → snake_case
  const headers = rows[0].map(h =>
    h.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
  );

  const col  = name => headers.findIndex(h => h.includes(name));
  const colE = (...names) => { for (const n of names) { const i = col(n); if (i !== -1) return i; } return -1; };

  // Capitec-specific columns
  const transDateCol = colE('transaction_date', 'posting_date', 'date');
  const descCol      = colE('description');
  const moneyInCol   = colE('money_in');
  const moneyOutCol  = colE('money_out');
  const feeCol       = colE('fee');
  const balanceCol   = colE('balance');

  // Generic fallback columns
  const amtCol    = colE('amount');
  const debitCol  = colE('debit');
  const creditCol = colE('credit');

  if (transDateCol === -1 || descCol === -1) {
    throw new Error(
      `Could not find required columns. Found: ${headers.join(', ')}. ` +
      `Expected: Date and Description (or Transaction Date, Posting Date).`
    );
  }

  const isCapitecFormat = moneyInCol !== -1 && moneyOutCol !== -1;
  const isDebitCredit   = debitCol !== -1 && creditCol !== -1;

  const transactions = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 3) continue;

    const rawDate = row[transDateCol]?.trim();
    const rawDesc = row[descCol]?.trim();

    // skip rows with no date or description
    if (!rawDate || !rawDesc) continue;

    // skip "Insf. Funds" notification rows (zero-value balance entries)
    if (rawDesc.startsWith('Insf. Funds') || rawDesc.startsWith('INSF. FUNDS')) continue;

    // skip pending transactions (Balance column empty, marked as Pending)
    if (balanceCol !== -1 && !row[balanceCol]?.trim()) continue;

    // parse the transaction date (Capitec uses "YYYY-MM-DD HH:MM" format)
    const importedDate = parseDate(rawDate);
    if (!importedDate) continue;

    let amount = 0;
    let type   = 'expense';

    if (isCapitecFormat) {
      const moneyIn  = parseMoney(row[moneyInCol]);
      const moneyOut = Math.abs(parseMoney(row[moneyOutCol])); // Capitec exports as negative
      const fee      = feeCol !== -1 ? Math.abs(parseMoney(row[feeCol])) : 0;

      if (moneyIn > 0) {
        amount = moneyIn;
        type   = 'income';
      } else if (moneyOut > 0) {
        amount = moneyOut;
        type   = 'expense';
      } else if (Math.abs(fee) > 0) {
        // Fee-only rows (e.g. "Monthly Account Admin Fee")
        amount = Math.abs(fee);
        type   = 'expense';
      } else {
        continue; // truly zero row, skip
      }
    } else if (isDebitCredit) {
      const debit  = parseMoney(row[debitCol]);
      const credit = parseMoney(row[creditCol]);
      if (credit > 0)    { amount = credit; type = 'income'; }
      else if (debit > 0){ amount = debit;  type = 'expense'; }
      else continue;
    } else if (amtCol !== -1) {
      const raw = parseMoney(row[amtCol]);
      if (raw === 0) continue;
      amount = Math.abs(raw);
      type   = raw < 0 ? 'expense' : 'income';
    } else {
      continue;
    }

    // use Description column (not Original Description — it's the messy raw bank text)
    const description = sanitiseDescription(rawDesc);
    const merchant    = normaliseMerchant(description);
    const category    = await lookupCategory(merchant, userId);

    transactions.push({ importedDate, description, merchant, amount, type, category });
  }

  // Batch-resolve anything nothing else recognised — one AI call for the
  // whole statement, not one per transaction.
  const unresolved = [...new Set(transactions.filter(t => t.category === null).map(t => t.merchant))];
  if (unresolved.length > 0) {
    const resolved = await categoriseWithAI(unresolved, userId);
    const now = new Date().toISOString();
    for (const t of transactions) {
      if (t.category === null) {
        const assigned = resolved[t.merchant] || 'general';
        t.category = assigned;
        // learn it immediately so a future statement never re-asks the AI for this merchant
        await db.prepare(`
          INSERT INTO merchant_category_map (user_id, pattern, category, hit_count, updated_at)
          VALUES (?, ?, ?, 1, ?)
          ON CONFLICT (user_id, pattern) DO NOTHING
        `).run(userId, t.merchant, assigned, now);
      }
    }
  }

  return transactions;
}

function parseDate(raw) {
  if (!raw) return null;
  // Capitec format: "YYYY-MM-DD HH:MM" — just take the date part
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  // DD/MM/YYYY or DD-MM-YYYY
  const m = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  return null;
}

function parseMoney(raw) {
  if (!raw || raw.trim() === '' || raw.trim() === '-') return 0;
  // remove currency symbols, spaces, commas in thousands
  const cleaned = raw.replace(/[R$£€\s]/g, '').replace(/,(\d{3})/g, '$1');
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

// ─── Deduplication ────────────────────────────────────────────────────────────
// Same date + same amount + same description within 1 day = duplicate
async function deduplicateTransactions(transactions, userId) {
  const results = [];
  for (const t of transactions) {
    const d = new Date(t.importedDate);
    const dayBefore = new Date(d); dayBefore.setDate(d.getDate() - 1);
    const dayAfter  = new Date(d); dayAfter.setDate(d.getDate() + 1);
    const existing = await db.prepare(`
      SELECT id FROM finance_entries
      WHERE imported_date BETWEEN ? AND ?
        AND ABS(amount - ?) < 0.01 AND merchant = ? AND source = 'import' AND user_id = ?
      LIMIT 1
    `).get(dayBefore.toISOString().slice(0,10), dayAfter.toISOString().slice(0,10), t.amount, t.merchant, userId);
    if (!existing) results.push(t);
  }
  return results;
}

// ─── Commit to DB ─────────────────────────────────────────────────────────────
async function commitTransactions(transactions, userId) {
  const now = new Date().toISOString();
  await db.transaction(async (t) => {
    await db.prepare(
      `INSERT INTO finance_entries (type, amount, category, note, merchant, source, imported_date, created_at, user_id) VALUES (?, ?, ?, ?, ?, 'import', ?, ?, ?)`
    ).run(t.type, t.amount, t.category, t.description, t.merchant, t.importedDate, now, userId);
  })(transactions);
}

// ─── Learning loop ────────────────────────────────────────────────────────────
// Called when user manually corrects a category on a transaction.
async function learnMerchantCategory(merchant, category, userId) {
  if (!merchant || !category || !userId) return;
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO merchant_category_map (user_id, pattern, category, hit_count, updated_at)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT (user_id, pattern) DO UPDATE SET category = EXCLUDED.category, hit_count = merchant_category_map.hit_count + 1, updated_at = EXCLUDED.updated_at
  `).run(userId, merchant, category, now);

  // only this user's imported entries
  await db.prepare(`
    UPDATE finance_entries SET category = ? WHERE merchant = ? AND source = 'import' AND user_id = ?
  `).run(category, merchant, userId);
}

// ─── Main parse entry point ───────────────────────────────────────────────────
async function parseStatementFile(filePath, userId) {
  let csvText;
  try {
    csvText = fs.readFileSync(filePath, 'utf-8');
  } catch {
    // try latin1 fallback (some SA bank exports use this)
    csvText = fs.readFileSync(filePath, 'latin1');
  } finally {
    // delete raw file immediately — we never store it
    try { fs.unlinkSync(filePath); } catch {}
  }

  // strip BOM if present
  if (csvText.charCodeAt(0) === 0xFEFF) csvText = csvText.slice(1);

  const parsed = await parseCapitecCSV(csvText, userId);
  return parsed;
}

// ─── Lightweight in-app import summary ───────────────────────────────────────
// A trimmed, synchronous version of surfaceImportPatterns' first checks
// (no DB calls) so the app itself can show a one-line "here's what I noticed"
// right after import, instead of that reasoning only reaching Telegram.
// surfaceImportPatterns still runs separately for the fuller, DB-backed
// checks (spend spikes vs baseline, new recurring charges).
function buildImportSummary(transactions) {
  const lines = [];

  const uncatMerchants = new Set(
    transactions.filter(t => t.category === 'general').map(t => t.merchant).filter(Boolean)
  );
  if (uncatMerchants.size > 0) {
    lines.push(`${uncatMerchants.size} merchant${uncatMerchants.size === 1 ? '' : 's'} still need a category (${[...uncatMerchants].slice(0, 3).join(', ')}${uncatMerchants.size > 3 ? '…' : ''})`);
  }

  const total = transactions.length;
  const matched = transactions.filter(t => t.category !== 'general').length;
  if (total > 0) {
    if (matched / total < 0.5) {
      lines.push(`only ${matched}/${total} categorised confidently — the rest are best guesses, worth a glance`);
    } else {
      lines.push(`${matched}/${total} categorised automatically`);
    }
  }

  return lines.join(' · ');
}

// ─── Post-import pattern surfacing ───────────────────────────────────────────
async function surfaceImportPatterns(transactions, userId) {
  const lines = [];

  // Section 5.1 — Uncategorised merchants
  try {
    const uncatMerchants = new Set(
      transactions.filter(t => t.category === 'general').map(t => t.merchant).filter(Boolean)
    );
    if (uncatMerchants.size > 0) {
      lines.push(`🏷️ ${uncatMerchants.size} merchant(s) need a category: ${[...uncatMerchants].slice(0, 5).join(', ')}${uncatMerchants.size > 5 ? ` +${uncatMerchants.size - 5} more` : ''}`);
    }
  } catch (err) {
    console.error('[import] surfaceImportPatterns section 5.1 error:', err.message);
  }

  // Section 5.2 — Spend spikes vs 4-week baseline
  try {
    const spendByCategory = {};
    for (const t of transactions) {
      if (t.type === 'expense') {
        spendByCategory[t.category] = (spendByCategory[t.category] || 0) + t.amount;
      }
    }
    for (const [category, total] of Object.entries(spendByCategory)) {
      const baseline = await db.prepare(
        `SELECT avg_weekly FROM budget_baselines WHERE category = ? AND user_id = ?`
      ).get(category);
      if (baseline && baseline.avg_weekly > 0 && total > baseline.avg_weekly * 4 * 0.5) {
        lines.push(`📈 ${category}: R${total.toFixed(0)} imported — over 50% of 4-week baseline (avg R${(baseline.avg_weekly * 4).toFixed(0)})`);
      }
    }
  } catch (err) {
    console.error('[import] surfaceImportPatterns section 5.2 error:', err.message);
  }

  // Section 5.3 — New recurring charges
  try {
    const merchants = [...new Set(transactions.map(t => t.merchant).filter(Boolean))];
    for (const merchant of merchants) {
      const priorRow = await db.prepare(`
        SELECT COUNT(DISTINCT strftime('%Y-%m', COALESCE(imported_date, created_at))) AS month_count
        FROM finance_entries
        WHERE merchant = ? AND source = 'import' AND user_id = ?
      `).get(merchant, userId);
      const priorMonths = priorRow ? (priorRow.month_count || 0) : 0;
      if (priorMonths >= 2) {
        const alreadyDetected = await db.prepare(
          `SELECT value FROM settings WHERE key = ?`
        ).get(`recurring_detected_${merchant}`);
        if (!alreadyDetected) {
          lines.push(`🔁 possible new recurring: ${merchant}`);
        }
      }
    }
  } catch (err) {
    console.error('[import] surfaceImportPatterns section 5.3 error:', err.message);
  }

  // Section 6.2 — Low auto-categorisation hit rate
  try {
    const total = transactions.length;
    const matched = transactions.filter(t => t.category !== 'general').length;
    if (total > 0 && matched / total < 0.5) {
      lines.push(`⚠️ auto-categorised ${matched}/${total} — ${total - matched} still need review`);
    }
  } catch (err) {
    console.error('[import] surfaceImportPatterns section 6.2 error:', err.message);
  }

  // Section 5.4 — Consolidated Telegram message
  const header = `✅ imported ${transactions.length} transaction${transactions.length === 1 ? '' : 's'}`;
  const message = lines.length > 0 ? `${header}\n\n${lines.join('\n')}` : header;
  try {
    const { sendMessage } = require('./telegram');
    await sendMessage(message, userId);
  } catch (err) {
    console.error('[import] surfaceImportPatterns sendMessage error:', err.message);
  }
}

module.exports = { parseStatementFile, commitTransactions, deduplicateTransactions, learnMerchantCategory, normaliseMerchant, surfaceImportPatterns, categoriseWithAI, buildImportSummary };
