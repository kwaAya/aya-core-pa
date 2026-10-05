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
const { getProviderPlan, fetchWithProviderFallback, canonicaliseCategory } = require('./ai-providers');
const { resolveBankCategory } = require('./bank-profiles');
// ─── Category keywords (seed rules before user teaches the system) ────────────
const SEED_RULES = [
  // ── Groceries ──────────────────────────────────────────────────────────────
  { pattern: 'shoprite',            category: 'groceries' },
  { pattern: 'checkers',            category: 'groceries' },
  { pattern: 'sixty60',             category: 'groceries' },
  { pattern: 'pick n pay',          category: 'groceries' },
  { pattern: 'spar',                category: 'groceries' },
  { pattern: 'woolworths food',     category: 'groceries' },
  { pattern: 'food lover',          category: 'groceries' },
  { pattern: 'usave',               category: 'groceries' },
  { pattern: 'boxer',               category: 'groceries' },
  // ── Takeaways (delivery / fast food) ────────────────────────────────────────
  // NOTE: uber eats / bolt food MUST appear before the broader uber / bolt patterns
  { pattern: 'uber eats',           category: 'takeaways' },
  { pattern: 'uber_eats',           category: 'takeaways' },
  { pattern: 'new uber eats',       category: 'takeaways' },
  { pattern: 'dl uber eats',        category: 'takeaways' },
  { pattern: 'dl*uber eats',        category: 'takeaways' },
  { pattern: 'mr delivery',         category: 'takeaways' },
  { pattern: 'bolt food',           category: 'takeaways' },
  { pattern: 'mcdonalds',           category: 'takeaways' },
  { pattern: 'mcd ',                category: 'takeaways' },
  { pattern: 'kfc',                 category: 'takeaways' },
  { pattern: 'steers',              category: 'takeaways' },
  { pattern: 'nandos',              category: 'takeaways' },
  { pattern: 'debonairs',           category: 'takeaways' },
  { pattern: 'debonair',            category: 'takeaways' },
  { pattern: 'chicken licken',      category: 'takeaways' },
  { pattern: "roman's pizza",       category: 'takeaways' },
  // ── Restaurants (sit-down dining) ───────────────────────────────────────────
  { pattern: 'mozambik',            category: 'restaurants' },
  { pattern: 'braza',               category: 'restaurants' },
  { pattern: 'chicago restaurant',  category: 'restaurants' },
  // ── Coffee ──────────────────────────────────────────────────────────────────
  { pattern: 'vida',                category: 'coffee' },
  { pattern: 'mugg & bean',         category: 'coffee' },
  { pattern: 'starbucks',           category: 'coffee' },
  { pattern: 'aroma',               category: 'coffee' },
  { pattern: 'seattle coffee',      category: 'coffee' },
  // ── Fuel ────────────────────────────────────────────────────────────────────
  { pattern: 'engen',               category: 'fuel' },
  { pattern: 'sasol',               category: 'fuel' },
  { pattern: 'shell',               category: 'fuel' },
  { pattern: 'bp ',                 category: 'fuel' },
  { pattern: 'caltex',              category: 'fuel' },
  { pattern: 'total',               category: 'fuel' },
  { pattern: 'astron',              category: 'fuel' },
  // ── Rideshare (must come AFTER takeaways to not match uber eats / bolt food) ─
  { pattern: 'uber',                category: 'rideshare' },
  { pattern: 'dl uber',             category: 'rideshare' },
  { pattern: 'dl*uber',             category: 'rideshare' },
  { pattern: 'bolt',                category: 'rideshare' },
  { pattern: 'dl bolt',             category: 'rideshare' },
  { pattern: 'indriver',            category: 'rideshare' },
  { pattern: 'taxi maxim',          category: 'rideshare' },
  { pattern: 'dlocal *taxi',        category: 'rideshare' },
  // ── Public transport ─────────────────────────────────────────────────────────
  { pattern: 'gautrain',            category: 'public_transport' },
  { pattern: 'myciti',              category: 'public_transport' },
  { pattern: 'rea vaya',            category: 'public_transport' },
  { pattern: 'golden arrow',        category: 'public_transport' },
  { pattern: 'intercape',           category: 'public_transport' },
  { pattern: 'intercal',            category: 'public_transport' },
  { pattern: 'greyhound',           category: 'public_transport' },
  { pattern: 'translux',            category: 'public_transport' },
  // ── Subscriptions ────────────────────────────────────────────────────────────
  { pattern: 'netflix',             category: 'subscriptions' },
  { pattern: 'spotify',             category: 'subscriptions' },
  { pattern: 'showmax',             category: 'subscriptions' },
  { pattern: 'dstv',                category: 'subscriptions' },
  { pattern: 'google one',          category: 'subscriptions' },
  { pattern: 'apple com',           category: 'subscriptions' },
  { pattern: 'amazon prime',        category: 'subscriptions' },
  { pattern: 'youtube premium',     category: 'subscriptions' },
  { pattern: 'microsoft 365',       category: 'subscriptions' },
  { pattern: 'adobe',               category: 'subscriptions' },
  { pattern: 'rain',                category: 'subscriptions' },
  { pattern: 'cell c',              category: 'subscriptions' },
  { pattern: 'cellphone',           category: 'subscriptions' },
  { pattern: 'prepaid mobile',      category: 'subscriptions' },
  { pattern: 'southsidecell',       category: 'subscriptions' },
  { pattern: 'jimmys cell',         category: 'subscriptions' },
  // ── Mobile (airtime / carrier top-ups not already caught above) ──────────────
  { pattern: 'vodacom',             category: 'mobile' },
  { pattern: 'mtn',                 category: 'mobile' },
  { pattern: 'telkom',              category: 'mobile' },
  // ── Utilities ────────────────────────────────────────────────────────────────
  { pattern: 'electricity',         category: 'utilities' },
  { pattern: 'eskom',               category: 'utilities' },
  { pattern: 'city power',          category: 'utilities' },
  { pattern: 'municipality',        category: 'utilities' },
  // ── Rent ─────────────────────────────────────────────────────────────────────
  { pattern: 'rent',                category: 'rent' },
  { pattern: 'lease',               category: 'rent' },
  // ── Insurance ────────────────────────────────────────────────────────────────
  { pattern: 'old mutual',          category: 'insurance' },
  { pattern: 'sanlam',              category: 'insurance' },
  { pattern: 'outsurance',          category: 'insurance' },
  { pattern: 'discovery',           category: 'insurance' },
  { pattern: 'momentum',            category: 'insurance' },
  // ── Medical ──────────────────────────────────────────────────────────────────
  { pattern: 'clicks',              category: 'medical' },
  { pattern: 'dis-chem',            category: 'medical' },
  { pattern: 'dischem',             category: 'medical' },
  { pattern: 'medihelp',            category: 'medical' },
  { pattern: 'bonitas',             category: 'medical' },
  // ── Clothing ─────────────────────────────────────────────────────────────────
  { pattern: 'mr price',            category: 'clothing' },
  { pattern: 'pep ',                category: 'clothing' },
  { pattern: 'jet ',                category: 'clothing' },
  { pattern: 'ackermans',           category: 'clothing' },
  { pattern: 'truworths',           category: 'clothing' },
  { pattern: 'foschini',            category: 'clothing' },
  { pattern: 'cotton on',           category: 'clothing' },
  { pattern: 'superbalist',         category: 'clothing' },
  { pattern: 'bash ',               category: 'clothing' },
  // ── Electronics ──────────────────────────────────────────────────────────────
  { pattern: 'takealot',            category: 'electronics' },
  { pattern: 'incredible connection', category: 'electronics' },
  { pattern: 'hi-fi corporation',   category: 'electronics' },
  // ── Education ────────────────────────────────────────────────────────────────
  { pattern: 'university',          category: 'education' },
  { pattern: 'college',             category: 'education' },
  { pattern: 'fundi payment',       category: 'education' },
  { pattern: 'tcps fundi',          category: 'education' },
  // ── Entertainment ────────────────────────────────────────────────────────────
  { pattern: 'computicket',         category: 'entertainment' },
  { pattern: 'nu metro',            category: 'entertainment' },
  { pattern: 'numetro',             category: 'entertainment' },
  { pattern: 'chicago pub',         category: 'entertainment' },
  { pattern: 'hightide',            category: 'entertainment' },
  { pattern: 'high tide',           category: 'entertainment' },
  { pattern: 'sportingbet',         category: 'entertainment' },
  // ── Beauty ───────────────────────────────────────────────────────────────────
  { pattern: 'xmbeautystudio',      category: 'beauty' },
  // ── Banking fees ─────────────────────────────────────────────────────────────
  { pattern: 'insufficient funds fee', category: 'banking_fees' },
  { pattern: 'immediate fee',          category: 'banking_fees' },
  { pattern: 'prepaid mobile fee',     category: 'banking_fees' },
  { pattern: 'international processing fee', category: 'banking_fees' },
  { pattern: 'notification fee',       category: 'banking_fees' },
  { pattern: 'account admin fee',      category: 'banking_fees' },
  { pattern: 'capitec pay fee',        category: 'banking_fees' },
  // ── Transfers (internal pocket movements — excluded from totals) ─────────────
  { pattern: 'live better round up',           category: 'transfers' },
  { pattern: 'live better savings account',    category: 'transfers' },
  { pattern: 'live better interest sweep',     category: 'transfers' },
  // ── Income ───────────────────────────────────────────────────────────────────
  { pattern: 'salary',              category: 'income' },
  { pattern: 'payroll',             category: 'income' },
  { pattern: 'cashfocus',           category: 'income' },
  { pattern: 'payment received',    category: 'income' },
  { pattern: 'payshap payment received', category: 'income' },
  { pattern: 'interest received',   category: 'income' },
  // ── Cannabis ─────────────────────────────────────────────────────────────────
  { pattern: 'hash cannabis',       category: 'cannabis' },
  { pattern: 'hashcannabis',        category: 'cannabis' },
  { pattern: 'budtender',           category: 'cannabis' },
  // ── General / other ──────────────────────────────────────────────────────────
  { pattern: 'woolworths',          category: 'general' },
  { pattern: 'amazon',              category: 'general' },
  { pattern: 'andilbotanics',       category: 'general' },
  { pattern: 'maagroceries',        category: 'general' },
  { pattern: 'sabelosupply',        category: 'general' },
  { pattern: 'hiwaysuper',          category: 'general' },
  { pattern: 'gloryminimarket',     category: 'general' },
  { pattern: 'deep see fish',       category: 'general' },
  { pattern: 'cutsport',            category: 'general' },
  { pattern: 'the friend supermarket', category: 'general' },
  { pattern: 'mmops food',          category: 'general' },
  { pattern: 'tinsaecashstore',     category: 'general' },
  { pattern: 'goldensupermrkt',     category: 'general' },
  { pattern: 'ccn maa groceries',   category: 'general' },
  { pattern: 'dreams for uz',       category: 'general' },
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
  if (learned) return { category: learned.category, source: 'learned' };

  // 2. fall back to seed rules
  for (const rule of SEED_RULES) {
    if (merchant.includes(rule.pattern)) return { category: rule.category, source: 'seed' };
  }

  // 3. no match at all — flag for batched AI categorisation later.
  // Returning a null category (not 'general') lets the batch step tell
  // "genuinely uncategorised" apart from "explicitly general" on purpose.
  return { category: null, source: null };
}

// ─── AI categorisation for merchants nothing else recognised ─────────────────
// Called once per import with every still-uncategorised merchant, not per
// transaction — one AI call per batch, not one per row.

// Keep prompts small enough that a reply can't get truncated mid-JSON — a
// truncated reply used to fail the whole import's worth of merchants at once.
const AI_CATEGORISE_CHUNK_SIZE = 30;

async function categoriseChunk(chunk, knownCategories, providers) {
  const prompt = `You are categorising bank statement merchants for a personal finance app.

Existing categories this user already has: ${knownCategories.length ? knownCategories.join(', ') : '(none yet)'}

For each merchant below, either:
- assign one of the existing categories above if it genuinely fits, OR
- propose a new, short, lowercase category name if nothing fits well. Prefer these established subcategories when applicable: groceries, takeaways, restaurants, coffee, fuel, rideshare, public_transport, subscriptions, mobile, utilities, rent, insurance, medical, clothing, electronics, education, entertainment, beauty, gym, banking_fees, transfers, income, savings, cannabis, general

Merchants to categorise:
${chunk.map((m, i) => `${i + 1}. ${m}`).join('\n')}

Respond with ONLY a JSON object, no markdown, no explanation:
{"merchant name exactly as given": "category", ...}`;

  const messages = [{ role: 'user', content: prompt }];

  let raw, usedProvider;
  for (const provider of providers) {
    try {
      const res = await fetchWithProviderFallback(provider, messages, 1024);
      const data = await res.json();
      raw = data.choices?.[0]?.message?.content || '{}';
      usedProvider = provider.name;
      break;
    } catch (err) {
      console.error(`[finance-import] ${provider.name} categorisation failed, trying next provider:`, err.message);
    }
  }
  if (!raw) {
    console.error(`[finance-import] all AI providers failed for a batch of ${chunk.length} merchant(s) — falling back to general`);
    return {};
  }

  try {
    const cleaned = raw.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
    const start = cleaned.indexOf('{');
    const end   = cleaned.lastIndexOf('}');
    const rawResult = JSON.parse(cleaned.slice(start, end + 1));

    // The model doesn't reliably echo merchant keys back byte-for-byte — it
    // can keep the "1. " list prefix, change casing, or add stray whitespace.
    // Callers match with a plain lookup, so any of that used to silently
    // send every unresolved transaction to 'general' with nothing logged.
    // canonicaliseCategory also folds synonyms ("groceries" → "food") so the
    // model doesn't quietly spawn near-duplicate categories over time.
    const result = {};
    for (const [rawKey, rawVal] of Object.entries(rawResult)) {
      const key = String(rawKey).trim().replace(/^\d+[.)]\s*/, '').toLowerCase();
      const val = canonicaliseCategory(rawVal);
      if (key && val) result[key] = val;
    }
    console.log(`[finance-import] ${usedProvider} categorised ${Object.keys(result).length}/${chunk.length} merchants in this batch`);
    return result;
  } catch (err) {
    console.error('[finance-import] AI categorisation parse failed:', err.message, raw);
    return {};
  }
}

async function categoriseWithAI(merchants, userId) {
  if (!merchants.length) return {};

  const providers = getProviderPlan();
  if (!providers.length) {
    console.warn('[finance-import] no AI provider configured (GROQ_API_KEY / GEMINI_API_KEY / OPENROUTER_API_KEY) — these will fall back to general');
    return {};
  }

  const existing = await db.prepare(
    `SELECT DISTINCT category FROM finance_entries WHERE user_id = ? AND category IS NOT NULL`
  ).all(userId);
  const existingCategories = [...new Set(existing.map(r => r.category))];
  const userCats = await db.prepare(`SELECT name FROM categories WHERE user_id = ?`).all(userId);
  const knownCategories = [...new Set([...existingCategories, ...userCats.map(c => c.name)])];

  const chunks = [];
  for (let i = 0; i < merchants.length; i += AI_CATEGORISE_CHUNK_SIZE) {
    chunks.push(merchants.slice(i, i + AI_CATEGORISE_CHUNK_SIZE));
  }

  const merged = {};
  for (const chunk of chunks) {
    Object.assign(merged, await categoriseChunk(chunk, knownCategories, providers));
  }

  // any category the AI proposed that we don't already have gets created
  const now = new Date().toISOString();
  const knownCategoriesLower = knownCategories.map(c => c.toLowerCase());
  const newCats = [...new Set(Object.values(merged))].filter(c => !knownCategoriesLower.includes(c));
  for (const cat of newCats) {
    await db.prepare(
      `INSERT INTO categories (user_id, name, created_at) VALUES (?, ?, ?) ON CONFLICT (user_id, name) DO NOTHING`
    ).run(userId, cat, now);
  }

  return merged;
}

// ─── Web merchant lookup (Brave Search) ──────────────────────────────────────
// Look up an unknown merchant on Brave Search to determine what it is.
async function lookupMerchantOnWeb(merchantName) {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key || !merchantName) return null;
  try {
    const q = encodeURIComponent(`${merchantName} South Africa what is this business`);
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${q}&count=3&country=za`, {
      headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': key },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const snippet = data.web?.results?.slice(0,3).map(r => r.description || r.title || '').join(' ').slice(0, 600) || '';
    if (!snippet) return null;

    const cats = ['groceries','takeaways','restaurants','coffee','fuel','rideshare','public_transport',
      'subscriptions','mobile','utilities','rent','insurance','medical','clothing','electronics',
      'education','entertainment','beauty','gym','banking_fees','transfers','income','savings','general'];

    const prompt = `Merchant: "${merchantName}"\nWeb search result: "${snippet}"\n\nWhat category does this merchant belong to? Reply with ONLY one word from this list: ${cats.join(', ')}`;

    const providers = getProviderPlan();
    if (!providers.length) return null;

    for (const provider of providers) {
      try {
        const r = await fetchWithProviderFallback(provider, [
          { role: 'system', content: 'You are a financial transaction categoriser. Reply with exactly one category word.' },
          { role: 'user', content: prompt }
        ], 20);
        const d = await r.json();
        const raw = (d.choices?.[0]?.message?.content || '').trim().toLowerCase().split(/\s/)[0];
        if (cats.includes(raw)) return raw;
        return canonicaliseCategory(raw) || null;
      } catch { continue; }
    }
  } catch (err) {
    console.error('[web-lookup] failed for', merchantName, '—', err.message);
  }
  return null;
}

async function seedMerchantMap() {
  const now = new Date().toISOString();
  for (const rule of SEED_RULES) {
    await db.prepare(`
      INSERT INTO merchant_category_map (user_id, pattern, category, hit_count, updated_at)
      VALUES (NULL, ?, ?, 1, ?)
      ON CONFLICT (pattern) WHERE user_id IS NULL DO NOTHING
    `).run(rule.pattern, rule.category, now);
  }
}

// call once on module load to ensure seed rules exist — but only after the
// schema migration (which creates the unique indexes ON CONFLICT relies on)
// has actually finished, or this races the index creation on every boot.
db.ready.then(seedMerchantMap).catch(err => console.error('[finance-import] seed failed:', err.message));

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
    const merchant     = normaliseMerchant(description);
    let { category, source } = await lookupCategory(merchant, userId);

    // 3. bank's own category (Capitec's "Parent Category" etc.) — checked
    // after seed rules on purpose, so a specific keyword rule (e.g. cannabis)
    // always wins over a broader/inconsistent bank bucket.
    if (category === null) {
      const bankCategory = resolveBankCategory(headers, row);
      if (bankCategory) { category = bankCategory; source = 'bank'; }
    }

    transactions.push({ importedDate, description, merchant, amount, type, category, source });
  }

  // Batch-resolve anything nothing else recognised — one AI call per batch,
  // not one per transaction.
  const unresolved = [...new Set(transactions.filter(t => t.category === null).map(t => t.merchant))];
  if (unresolved.length > 0) {
    const resolved = await categoriseWithAI(unresolved, userId);
    const now = new Date().toISOString();
    for (const t of transactions) {
      if (t.category === null) {
        const assigned = resolved[t.merchant];
        if (assigned) {
          t.category = assigned;
          t.source   = 'ai';
          // learn it immediately so a future statement never re-asks the AI for this merchant
          await db.prepare(`
            INSERT INTO merchant_category_map (user_id, pattern, category, hit_count, updated_at)
            VALUES (?, ?, ?, 1, ?)
            ON CONFLICT (user_id, pattern) DO NOTHING
          `).run(userId, t.merchant, assigned, now);
        } else {
          // AI unavailable/failed for this merchant — show it as 'general'
          // for now, but do NOT write it to merchant_category_map. Writing
          // it here used to mean a transient outage permanently taught the
          // system "this merchant = general" forever, since the learned
          // lookup is checked before AI is ever asked again.
          t.category = 'general';
          t.source   = 'fallback';
        }
      }
    }
  }

  // Web lookup pass — fires only if BRAVE_SEARCH_API_KEY is set
  if (process.env.BRAVE_SEARCH_API_KEY) {
    const stillUnknown = transactions.filter(t => !t.category || t.category === 'general');
    for (const t of stillUnknown) {
      const webCategory = await lookupMerchantOnWeb(t.merchant);
      if (webCategory && webCategory !== 'general') {
        t.category = webCategory;
        t.source = 'web';
        const now = new Date().toISOString();
        await db.prepare(`
          INSERT INTO merchant_category_map (user_id, pattern, category, hit_count, updated_at)
          VALUES (?, ?, ?, 1, ?)
          ON CONFLICT (user_id, pattern) DO NOTHING
        `).run(userId, t.merchant, webCategory, now);
      }
    }
  }

  const stats = transactions.reduce((s, t) => {
    const key = t.source || 'unknown';
    s[key] = (s[key] || 0) + 1;
    return s;
  }, {});

  return { transactions, stats };
}

// Shared tail for non-CSV sources (PDF): clean description → merchant → learned/seed category → one batched AI call.
async function finishTransactions(items, userId) {
  const transactions = [];
  for (const it of items) {
    const description = sanitiseDescription(it.description);
    const merchant = normaliseMerchant(description);
    // bank fees (no merchant to look up) are always "bills"
    const { category, source } = it.fee ? { category: 'bills', source: 'bank' } : await lookupCategory(merchant, userId);
    transactions.push({ importedDate: it.importedDate, description, merchant, amount: it.amount, type: it.type, category, source });
  }
  const unresolved = [...new Set(transactions.filter(t => t.category === null).map(t => t.merchant))];
  if (unresolved.length > 0) {
    const resolved = await categoriseWithAI(unresolved, userId);
    const now = new Date().toISOString();
    for (const t of transactions) {
      if (t.category !== null) continue;
      const assigned = resolved[t.merchant];
      if (assigned) {
        t.category = assigned; t.source = 'ai';
        await db.prepare(`
          INSERT INTO merchant_category_map (user_id, pattern, category, hit_count, updated_at)
          VALUES (?, ?, ?, 1, ?)
          ON CONFLICT (user_id, pattern) DO NOTHING
        `).run(userId, t.merchant, assigned, now);
      } else { t.category = 'general'; t.source = 'fallback'; }
    }
  }
  // Web lookup pass — fires only if BRAVE_SEARCH_API_KEY is set
  if (process.env.BRAVE_SEARCH_API_KEY) {
    const stillUnknown = transactions.filter(t => !t.category || t.category === 'general');
    for (const t of stillUnknown) {
      const webCategory = await lookupMerchantOnWeb(t.merchant);
      if (webCategory && webCategory !== 'general') {
        t.category = webCategory;
        t.source = 'web';
        // persist to merchant_category_map so future imports don't re-query
        const now = new Date().toISOString();
        await db.prepare(`
          INSERT INTO merchant_category_map (user_id, pattern, category, hit_count, updated_at)
          VALUES (?, ?, ?, 1, ?)
          ON CONFLICT (user_id, pattern) DO NOTHING
        `).run(userId, t.merchant, webCategory, now);
      }
    }
  }
  const stats = transactions.reduce((s, t) => { const k = t.source || 'unknown'; s[k] = (s[k] || 0) + 1; return s; }, {});
  return { transactions, stats };
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

// ─── How many existing entries fall inside a statement period ─────────────────
async function countEntriesInPeriod(userId, from, to) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM finance_entries WHERE user_id = ? AND imported_date BETWEEN ? AND ?`
  ).get(userId, from, to);
  return row?.n ?? 0;
}

// ─── Replace mode: wipe the period then insert fresh from the statement ────────
// Deletes ALL entries (import + manual) whose imported_date falls in [from, to],
// then inserts the new batch. Runs in a single transaction so it's atomic.
async function replaceAndCommitTransactions(transactions, userId, from, to) {
  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO finance_entries (type, amount, category, note, merchant, source, imported_date, created_at, user_id) VALUES (?, ?, ?, ?, ?, 'import', ?, ?, ?)`
  );
  await db.transaction(() => {
    db.prepare(
      `DELETE FROM finance_entries WHERE user_id = ? AND imported_date BETWEEN ? AND ?`
    ).run(userId, from, to);
    for (const t of transactions) {
      insert.run(t.type, t.amount, t.category, t.description, t.merchant, t.importedDate, now, userId);
    }
  })();
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
  // PDF? (magic bytes, not the file name) — parsed from its text layer, then categorised like a CSV.
  let isPdf = false;
  try { const fd = fs.openSync(filePath, 'r'); const b = Buffer.alloc(5); fs.readSync(fd, b, 0, 5, 0); fs.closeSync(fd); isPdf = b.toString('latin1') === '%PDF-'; } catch { /* fall through to the CSV path */ }
  if (isPdf) {
    try {
      const pdf = require('./statement');
      const out = await pdf.parsePdfStatement(filePath);
      // Normalise period keys: statement.js uses {start,end}; the rest of the
      // pipeline (index.js countEntriesInPeriod, frontend replace logic) expects {from,to}
      const period = out.period
        ? { from: out.period.start ?? out.period.from, to: out.period.end ?? out.period.to }
        : null;
      const done = await finishTransactions(out.transactions.map(t => ({ importedDate: t.date, description: t.description, amount: t.amount, type: t.type, fee: t.fee })), userId);
      return { ...done, bank: out.bank, period, warnings: out.warnings, reconciled: out.reconciled, source: 'pdf' };
    } finally {
      try { fs.unlinkSync(filePath); } catch { /* already gone */ }   // never keep the raw statement
    }
  }
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
  return { ...parsed, source: 'csv' };
}

// ─── Lightweight in-app import summary ───────────────────────────────────────
// A trimmed, synchronous version of surfaceImportPatterns' first checks
// (no DB calls) so the app itself can show a one-line "here's what I noticed"
// right after import, instead of that reasoning only reaching Telegram.
// surfaceImportPatterns still runs separately for the fuller, DB-backed
// checks (spend spikes vs baseline, new recurring charges).
function buildImportSummary(transactions) {
  const lines = [];

  // Only 'fallback' means "nothing recognised it, not even the AI" — a
  // transaction that's genuinely category 'general' via a seed rule or a
  // learned mapping isn't uncategorised, it's just correctly general.
  const uncatMerchants = new Set(
    transactions.filter(t => t.source === 'fallback' || (!t.source && t.category === 'general'))
      .map(t => t.merchant).filter(Boolean)
  );
  if (uncatMerchants.size > 0) {
    lines.push(`${uncatMerchants.size} merchant${uncatMerchants.size === 1 ? '' : 's'} still need a category (${[...uncatMerchants].slice(0, 3).join(', ')}${uncatMerchants.size > 3 ? '…' : ''})`);
  }

  const total = transactions.length;
  const confident = transactions.filter(t => t.source === 'learned' || t.source === 'seed' || t.source === 'bank' || t.source === 'ai').length;
  if (total > 0) {
    if (confident / total < 0.5) {
      lines.push(`only ${confident}/${total} categorised confidently — the rest are best guesses, worth a glance`);
    } else {
      lines.push(`${confident}/${total} categorised automatically`);
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
      ).get(category, userId);
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
        SELECT COUNT(DISTINCT strftime('%Y-%m', imported_date)) AS month_count
        FROM finance_entries
        WHERE merchant = ? AND source = 'import' AND user_id = ? AND imported_date IS NOT NULL
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

// ─── Recurring detection ──────────────────────────────────────────────────────
// A merchant is "recurring" if the same merchant appears in 2+ distinct calendar
// months with an amount within 5% of its median across those months.
async function detectRecurring(userId) {
  const rows = await db.prepare(
    `SELECT merchant, amount, SUBSTR(COALESCE(imported_date, created_at), 1, 7) AS month
     FROM finance_entries
     WHERE user_id = ? AND merchant IS NOT NULL AND merchant != '' AND type = 'expense'
     ORDER BY merchant, month`
  ).all(userId);

  // Group by merchant
  const byMerchant = {};
  for (const r of rows) {
    if (!byMerchant[r.merchant]) byMerchant[r.merchant] = [];
    byMerchant[r.merchant].push({ month: r.month, amount: r.amount });
  }

  const recurring = [];
  for (const [merchant, hits] of Object.entries(byMerchant)) {
    const months = [...new Set(hits.map(h => h.month))];
    if (months.length < 2) continue;
    const amounts = hits.map(h => h.amount).sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)];
    // All amounts within 5% of median = consistent charge
    const consistent = amounts.every(a => Math.abs(a - median) / median < 0.05);
    if (consistent) recurring.push({ merchant, amount: median, months: months.length });
  }
  return recurring;
}

module.exports = { parseStatementFile, commitTransactions, deduplicateTransactions, countEntriesInPeriod, replaceAndCommitTransactions, learnMerchantCategory, normaliseMerchant, surfaceImportPatterns, categoriseWithAI, buildImportSummary, detectRecurring, SEED_RULES };