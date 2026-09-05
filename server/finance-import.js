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
  { pattern: 'shoprite',      category: 'food' },
  { pattern: 'checkers',      category: 'food' },
  { pattern: 'pick n pay',    category: 'food' },
  { pattern: 'pnp',           category: 'food' },
  { pattern: 'spar',          category: 'food' },
  { pattern: 'woolworths food',category:'food' },
  { pattern: 'food lover',    category: 'food' },
  { pattern: 'mcdonalds',     category: 'food' },
  { pattern: 'kfc',           category: 'food' },
  { pattern: 'steers',        category: 'food' },
  { pattern: 'nandos',        category: 'food' },
  { pattern: 'uber eats',     category: 'food' },
  { pattern: 'mr delivery',   category: 'food' },
  { pattern: 'bolt food',     category: 'food' },
  { pattern: 'uber',          category: 'transport' },
  { pattern: 'bolt',          category: 'transport' },
  { pattern: 'indriver',      category: 'transport' },
  { pattern: 'engen',         category: 'transport' },
  { pattern: 'sasol',         category: 'transport' },
  { pattern: 'shell',         category: 'transport' },
  { pattern: 'bp ',           category: 'transport' },
  { pattern: 'caltex',        category: 'transport' },
  { pattern: 'transnet',      category: 'transport' },
  { pattern: 'prasa',         category: 'transport' },
  { pattern: 'netflix',       category: 'bills' },
  { pattern: 'spotify',       category: 'bills' },
  { pattern: 'showmax',       category: 'bills' },
  { pattern: 'dstv',          category: 'bills' },
  { pattern: 'telkom',        category: 'bills' },
  { pattern: 'vodacom',       category: 'bills' },
  { pattern: 'mtn',           category: 'bills' },
  { pattern: 'cell c',        category: 'bills' },
  { pattern: 'rain',          category: 'bills' },
  { pattern: 'electricity',   category: 'bills' },
  { pattern: 'eskom',         category: 'bills' },
  { pattern: 'municipality',  category: 'bills' },
  { pattern: 'rates',         category: 'bills' },
  { pattern: 'rent',          category: 'bills' },
  { pattern: 'salary',        category: 'income' },
  { pattern: 'payroll',       category: 'income' },
  { pattern: 'payment received',category:'income'},
  { pattern: 'woolworths',    category: 'general' },
  { pattern: 'clicks',        category: 'general' },
  { pattern: 'dischem',       category: 'general' },
  { pattern: 'mr price',      category: 'general' },
  { pattern: 'h&m',           category: 'general' },
  { pattern: 'zara',          category: 'general' },
  { pattern: 'takealot',      category: 'general' },
  { pattern: 'amazon',        category: 'general' },
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

function lookupCategory(merchant) {
  // 1. check learned mappings first (highest priority)
  const learned = db.prepare(
    `SELECT category FROM merchant_category_map WHERE ? LIKE '%' || pattern || '%' ORDER BY hit_count DESC LIMIT 1`
  ).get(merchant);
  if (learned) return learned.category;

  // 2. fall back to seed rules
  for (const rule of SEED_RULES) {
    if (merchant.includes(rule.pattern)) return rule.category;
  }

  return 'general';
}

function seedMerchantMap() {
  const upsert = db.prepare(`
    INSERT INTO merchant_category_map (pattern, category, hit_count, updated_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(pattern) DO NOTHING
  `);
  const now = new Date().toISOString();
  for (const rule of SEED_RULES) {
    upsert.run(rule.pattern, rule.category, now);
  }
}

// call once on module load to ensure seed rules exist
seedMerchantMap();

// ─── Capitec CSV parser ───────────────────────────────────────────────────────
// Capitec exports with columns (approximate, may vary slightly):
// Date, Description, Amount, Balance
// or: Transaction Date, Description, Debit, Credit, Balance
// We auto-detect which format we're looking at.

function parseCapitecCSV(csvText) {
  const rows = parse(csvText, {
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });

  if (rows.length < 2) throw new Error('CSV appears empty or has no data rows');

  // normalise header names
  const headers = rows[0].map(h => h.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_'));

  // detect column positions flexibly
  const col = name => headers.findIndex(h => h.includes(name));

  const dateCol   = col('date');
  const descCol   = col('description') !== -1 ? col('description') : col('narration');
  const amtCol    = col('amount');
  const debitCol  = col('debit');
  const creditCol = col('credit');

  if (dateCol === -1 || descCol === -1) {
    throw new Error('Could not find required Date and Description columns in CSV. Check the file format.');
  }

  const hasDebitCredit = debitCol !== -1 && creditCol !== -1;
  const transactions = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 2) continue;

    const rawDate = row[dateCol]?.trim();
    const rawDesc = row[descCol]?.trim();

    if (!rawDate || !rawDesc) continue;

    // parse date — handle DD/MM/YYYY, YYYY-MM-DD, DD-MM-YYYY
    const importedDate = parseDate(rawDate);
    if (!importedDate) continue;

    // parse amount
    let amount = 0;
    let type   = 'expense';

    if (hasDebitCredit) {
      const debit  = parseMoney(row[debitCol]);
      const credit = parseMoney(row[creditCol]);
      if (credit > 0)       { amount = credit; type = 'income'; }
      else if (debit > 0)   { amount = debit;  type = 'expense'; }
      else continue;
    } else if (amtCol !== -1) {
      const raw = parseMoney(row[amtCol]);
      if (raw === 0) continue;
      if (raw < 0)  { amount = Math.abs(raw); type = 'expense'; }
      else          { amount = raw;            type = 'income'; }
    } else {
      continue;
    }

    const description = sanitiseDescription(rawDesc);
    const merchant    = normaliseMerchant(description);
    const category    = lookupCategory(merchant);

    transactions.push({ importedDate, description, merchant, amount, type, category });
  }

  return transactions;
}

function parseDate(raw) {
  if (!raw) return null;
  // try YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  // try DD/MM/YYYY or DD-MM-YYYY
  const m = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  // try MM/DD/YYYY
  const m2 = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m2) {
    const year = m2[3].length === 2 ? '20' + m2[3] : m2[3];
    return `${year}-${m2[1].padStart(2,'0')}-${m2[2].padStart(2,'0')}`;
  }
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
function deduplicateTransactions(transactions) {
  return transactions.filter(t => {
    const existing = db.prepare(`
      SELECT id FROM finance_entries
      WHERE imported_date = ? AND ABS(amount - ?) < 0.01 AND merchant = ? AND source = 'import'
      LIMIT 1
    `).get(t.importedDate, t.amount, t.merchant);
    return !existing;
  });
}

// ─── Commit to DB ─────────────────────────────────────────────────────────────
function commitTransactions(transactions) {
  const insert = db.prepare(`
    INSERT INTO finance_entries (type, amount, category, note, merchant, source, imported_date, created_at)
    VALUES (?, ?, ?, ?, ?, 'import', ?, ?)
  `);
  const now = new Date().toISOString();
  const insertMany = db.transaction(rows => {
    for (const t of rows) {
      insert.run(t.type, t.amount, t.category, t.description, t.merchant, t.importedDate, now);
    }
  });
  insertMany(transactions);
}

// ─── Learning loop ────────────────────────────────────────────────────────────
// Called when user manually corrects a category on a transaction.
function learnMerchantCategory(merchant, category) {
  if (!merchant || !category) return;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO merchant_category_map (pattern, category, hit_count, updated_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(pattern) DO UPDATE SET category = excluded.category, hit_count = hit_count + 1, updated_at = excluded.updated_at
  `).run(merchant, category, now);

  // also update all existing imported entries with this merchant that were auto-categorised
  db.prepare(`
    UPDATE finance_entries SET category = ? WHERE merchant = ? AND source = 'import'
  `).run(category, merchant);
}

// ─── Main parse entry point ───────────────────────────────────────────────────
function parseStatementFile(filePath) {
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

  const parsed = parseCapitecCSV(csvText);
  return parsed;
}

module.exports = { parseStatementFile, commitTransactions, deduplicateTransactions, learnMerchantCategory, normaliseMerchant };
