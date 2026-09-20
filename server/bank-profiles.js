/**
 * bank-profiles.js
 * Some banks export their own transaction category alongside the raw
 * description (Capitec does, via "Parent Category"/"Category" columns).
 * That's free, instant classification — worth trusting for the categories
 * it's actually reliable on, ahead of ever calling AI.
 *
 * It's deliberately NOT trusted blindly for every category the bank
 * provides: some of Capitec's own buckets mix things that need to land in
 * different places for us (e.g. "Personal & Family" contains both real
 * recurring subscriptions and one-off gifts to named people). Those are
 * left out of the map below and handled by seed rules / AI instead — see
 * the comments in finance-import.js's SEED_RULES for how the overlap is
 * resolved by lookup order.
 *
 * Adding a second bank: add one more profile object below with its own
 * categoryColumns + mapCategory. Nothing else in the pipeline needs to
 * change — the learned map, seed rules, and AI step are all bank-agnostic.
 */

const CAPITEC_PARENT_CATEGORY_MAP = {
  'food': 'food',
  'transport': 'transport',
  'communication': 'subscriptions', // prepaid airtime/data — recurring, same idea as a subscription
  'entertainment': 'entertainment',
  'other income': 'income',
  'salary': 'income',
  'interest': 'income',
  'refunds': 'income',
  'account payment received': 'income',
  'fees': 'bills',
  'loans & accounts': 'bills',
  'allowance': 'personal',
  'cash': 'personal',
  // safe now that Apple/Google recurring charges are caught by seed rules
  // first — by the time a "Personal & Family" row reaches this map, it's
  // already been filtered down to real person-to-person payments
  'personal & family': 'personal',
  // 'transfer', 'uncategorised', '' (blank), 'medical', 'household' are
  // deliberately left out: either genuinely mixed (Transfer has real P2P
  // alongside internal sweeps), or Capitec itself doesn't know — those fall
  // through to seed rules / AI instead of a blanket guess.
};

function mapCapitecCategory(raw) {
  if (!raw) return null;
  return CAPITEC_PARENT_CATEGORY_MAP[String(raw).trim().toLowerCase()] || null;
}

const BANK_PROFILES = [
  {
    name: 'capitec',
    // checked in this order — Capitec always has "Parent Category"; some
    // exports also have a narrower "Category" column, used as a fallback
    categoryColumns: ['parent_category', 'category'],
    mapCategory: mapCapitecCategory,
  },
  // Add a new bank here later: { name, categoryColumns, mapCategory }.
];

// headers: normalised header array from the CSV (snake_case, as
// finance-import.js produces). row: the raw row array for one transaction.
// Returns a Core PA category, or null if no bank profile's column matched,
// or the bank's own value didn't map to anything we trust.
function resolveBankCategory(headers, row) {
  for (const profile of BANK_PROFILES) {
    for (const colName of profile.categoryColumns) {
      const idx = headers.findIndex(h => h.includes(colName));
      if (idx !== -1 && row[idx] && row[idx].trim()) {
        const mapped = profile.mapCategory(row[idx].trim());
        if (mapped) return mapped;
      }
    }
  }
  return null;
}

module.exports = { BANK_PROFILES, resolveBankCategory };
