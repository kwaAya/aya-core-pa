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

async function lookupCategory(merchant) {
  // 1. check learned mappings first (highest priority)
  const learned = await db.prepare(
    `SELECT category FROM merchant_category_map WHERE ? LIKE '%' || pattern || '%' ORDER BY hit_count DESC LIMIT 1`
  ).get(merchant);
  if (learned) return learned.category;

  // 2. fall back to seed rules
  for (const rule of SEED_RULES) {
    if (merchant.includes(rule.pattern)) return rule.category;
  }

  return 'general';
}

async function seedMerchantMap() {
  const now = new Date().toISOString();
  for (const rule of SEED_RULES) {
    await db.prepare(`
      INSERT INTO merchant_category_map (pattern, category, hit_count, updated_at)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(pattern) DO NOTHING
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

async function parseCapitecCSV(csvText) {
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
    const category    = await lookupCategory(merchant);

    transactions.push({ importedDate, description, merchant, amount, type, category });
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
async function deduplicateTransactions(transactions) {
  const results = [];
  for (const t of transactions) {
    const existing = await db.prepare(`
      SELECT id FROM finance_entries
      WHERE imported_date = ? AND ABS(amount - ?) < 0.01 AND merchant = ? AND source = 'import'
      LIMIT 1
    `).get(t.importedDate, t.amount, t.merchant);
    if (!existing) results.push(t);
  }
  return results;
}

// ─── Commit to DB ─────────────────────────────────────────────────────────────
async function commitTransactions(transactions) {
  const now = new Date().toISOString();
  await db.transaction(async (t) => {
    await db.prepare(
      `INSERT INTO finance_entries (type, amount, category, note, merchant, source, imported_date, created_at) VALUES (?, ?, ?, ?, ?, 'import', ?, ?)`
    ).run(t.type, t.amount, t.category, t.description, t.merchant, t.importedDate, now);
  })(transactions);
}

// ─── Learning loop ────────────────────────────────────────────────────────────
// Called when user manually corrects a category on a transaction.
async function learnMerchantCategory(merchant, category) {
  if (!merchant || !category) return;
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO merchant_category_map (pattern, category, hit_count, updated_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(pattern) DO UPDATE SET category = excluded.category, hit_count = hit_count + 1, updated_at = excluded.updated_at
  `).run(merchant, category, now);

  // also update all existing imported entries with this merchant that were auto-categorised
  await db.prepare(`
    UPDATE finance_entries SET category = ? WHERE merchant = ? AND source = 'import'
  `).run(category, merchant);
}

// ─── Main parse entry point ───────────────────────────────────────────────────
async function parseStatementFile(filePath) {
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

  const parsed = await parseCapitecCSV(csvText);
  return parsed;
}

module.exports = { parseStatementFile, commitTransactions, deduplicateTransactions, learnMerchantCategory, normaliseMerchant };
