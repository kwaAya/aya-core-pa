'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

// reasoning.js loads ./db at require-time; that's fine — we only exercise
// the pure helper functions and never call chat().
const {
  isConfirmation,
  detectMerchantCorrection,
  canonicaliseCategory,
  pendingSuggestions,
} = require('./reasoning');

// ─── isConfirmation ───────────────────────────────────────────────────────────

describe('isConfirmation', () => {
  // truthy cases
  it('returns true for "yes"',     () => assert.equal(isConfirmation('yes'),     true));
  it('returns true for "yeah"',    () => assert.equal(isConfirmation('yeah'),    true));
  it('returns true for "do it"',   () => assert.equal(isConfirmation('do it'),   true));
  it('returns true for "set it"',  () => assert.equal(isConfirmation('set it'),  true));
  it('returns true for "sure"',    () => assert.equal(isConfirmation('sure'),    true));
  it('returns true for "ok"',      () => assert.equal(isConfirmation('ok'),      true));
  it('returns true for "confirm"', () => assert.equal(isConfirmation('confirm'), true));
  it('returns true for "👍"',      () => assert.equal(isConfirmation('👍'),      true));

  // falsy cases
  it('returns false for "no"',             () => assert.equal(isConfirmation('no'),             false));
  it('returns false for "cancel"',         () => assert.equal(isConfirmation('cancel'),         false));
  it('returns false for "not yet"',        () => assert.equal(isConfirmation('not yet'),        false));
  it('returns false for "what time is it"',() => assert.equal(isConfirmation('what time is it'),false));
});

// ─── detectMerchantCorrection ─────────────────────────────────────────────────

describe('detectMerchantCorrection', () => {
  it('matches "Uber Eats is food"', () => {
    const result = detectMerchantCorrection('Uber Eats is food');
    assert.deepEqual(result, { merchant: 'Uber Eats', category: 'food' });
  });

  it('matches "that SPAR charge is groceries" — category canonicalised to "food"', () => {
    const result = detectMerchantCorrection('that SPAR charge is groceries');
    assert.ok(result !== null, 'expected a match');
    assert.match(result.merchant, /SPAR/i);
    assert.equal(result.category, 'food');
  });

  it('matches "categorise bolt as transport"', () => {
    const result = detectMerchantCorrection('categorise bolt as transport');
    assert.deepEqual(result, { merchant: 'bolt', category: 'transport' });
  });

  it('returns null for "how much did I spend on food"', () => {
    assert.equal(detectMerchantCorrection('how much did I spend on food'), null);
  });

  it('returns null for "add a task"', () => {
    assert.equal(detectMerchantCorrection('add a task'), null);
  });
});

// ─── canonicaliseCategory ─────────────────────────────────────────────────────

describe('canonicaliseCategory', () => {
  it('"groceries" → "food"',                    () => assert.equal(canonicaliseCategory('groceries'),          'food'));
  it('"eats" → "food"',                         () => assert.equal(canonicaliseCategory('eats'),               'food'));
  it('"ride" → "transport"',                    () => assert.equal(canonicaliseCategory('ride'),               'transport'));
  it('"uber" → "transport"',                    () => assert.equal(canonicaliseCategory('uber'),               'transport'));
  it('"subscription" → "bills"',                () => assert.equal(canonicaliseCategory('subscription'),       'bills'));
  it('"salary" → "income"',                     () => assert.equal(canonicaliseCategory('salary'),             'income'));
  it('"shopping" → "general"',                  () => assert.equal(canonicaliseCategory('shopping'),           'general'));
  it('unknown word is lowercased passthrough',  () => assert.equal(canonicaliseCategory('SomeUnknownCategory'),'someunknowncategory'));
});

// ─── pendingSuggestions map ───────────────────────────────────────────────────

describe('pendingSuggestions', () => {
  before(() => pendingSuggestions.clear());

  it('is a Map instance', () => assert.ok(pendingSuggestions instanceof Map));
  it('starts empty after clear()', () => assert.equal(pendingSuggestions.size, 0));
});
