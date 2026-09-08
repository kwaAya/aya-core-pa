# Implementation Plan

## smart-scheduling-finance-learning

- [x] 1. Add `engagement_events` schema to `db.js`
  - Add `CREATE TABLE IF NOT EXISTS engagement_events` block to the SQLite `exec()` block
  - Add matching `CREATE TABLE IF NOT EXISTS engagement_events` and index to the Postgres `initSchema()` block
  - Schema: `id`, `task_id INTEGER NOT NULL`, `event_type TEXT NOT NULL` (`'completed'|'touched'|'reminder_set'`), `hour_of_day INTEGER NOT NULL`, `created_at TEXT NOT NULL`
  - Add `CREATE INDEX IF NOT EXISTS idx_engagement_events_hour ON engagement_events(hour_of_day)`
  - Both branches must use the same additive `IF NOT EXISTS` pattern already used throughout the file
  - _Requirements: 1.1, 1.2, 1.4_

- [x] 2. Create `server/analytics.js` — engagement window query
  - Export `getEngagementWindow(db)`: count distinct days in `engagement_events` WHERE `created_at >= now-30days`
  - IF distinct days < 7 → return `{ startHour: 9, endHour: 11, hasSufficientHistory: false }` without throwing
  - IF DB query throws → catch, log, return fallback `{ startHour: 9, endHour: 11, hasSufficientHistory: false }`
  - ELSE → select `hour_of_day, COUNT(*) AS n` grouped and ordered DESC, take first row's hour as `peakHour`, return `{ startHour: peakHour, endHour: peakHour + 2, hasSufficientHistory: true }`
  - _Requirements: 1.3, 1.4, 7.4_

- [x] 3. Create `server/analytics.js` — enriched finance snapshot
  - Export `buildEnrichedFinanceSnapshot(db)` (extend same module from task 2)
  - Port existing `loadFinanceSnapshot()` logic from `reasoning.js` as the base (income, expense, net, top spend, spikes)
  - Add consecutive up-weeks trend: query last 6 weeks of expense spend grouped by `(category, week)` using `strftime('%Y-%W', created_at)`; for each category detect ≥ 2 consecutive weeks of increasing spend; append `"food spend up N weeks in a row"` style label
  - Add uncategorised count: COUNT from `finance_entries` WHERE `category='general' AND source='import'`; if > 0 append to snapshot
  - Add new recurring charges: SELECT keys from `settings` WHERE `key LIKE 'recurring_detected_%'` minus those that have a matching `recurring_notified_%` key; if any, append merchant names
  - Wrap entire function in try/catch; on error log and return the base snapshot string (not enriched)
  - _Requirements: 3.1, 3.2, 3.3, 7.5_

- [x] 4. Create `server/analytics.js` — engagement event recorder
  - Export `recordEngagementEvent(db, taskId, eventType)` in the same module
  - Derive `hourOfDay` from `new Date().getHours()`
  - INSERT into `engagement_events`; wrap in try/catch and log on error — never throws
  - _Requirements: 1.1, 1.2_

- [x] 5. Update `reasoning.js` — replace finance snapshot + inject scheduling context
  - `require('./analytics')` at the top
  - In `buildSystemPrompt()`: call `buildEnrichedFinanceSnapshot(db)` instead of `loadFinanceSnapshot()`; wrap in try/catch and fall back to `loadFinanceSnapshot()` on error (req 7.5)
  - Also in `buildSystemPrompt()`: call `getEngagementWindow(db)`; inject a `<scheduling_context>` block into the system prompt containing `startHour`, `endHour`, and `hasSufficientHistory`; also include the count of open high-priority tasks with reminders in the next 2 hours
  - Wrap `getEngagementWindow` call in try/catch; on error fall back to default `{ startHour: 9, endHour: 11 }` and log (req 7.4)
  - _Requirements: 2.1, 3.1, 3.2, 3.3, 3.4, 7.4, 7.5_

- [x] 6. Update `reasoning.js` — add `suggest_reminder` action type to system prompt
  - Add `suggest_reminder` action definition to the system prompt's action list with fields: `type`, `task_id`, `remind_at`, `suggestion_text`
  - Add inline rule: "This action is NEVER executed — it surfaces a suggestion for user confirmation only"
  - Include scheduling guidance in the prompt: high priority → same-day or next engagement window; normal → 24–48 h; low → 3–7 days; if > 3 high-priority tasks in same window → offset by 2 h
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

- [x] 7. Update `reasoning.js` — pending-suggestion state machine
  - Declare module-level `const pendingSuggestions = new Map()` (keyed by `chatId`, value `{ taskId, remindAt, suggestedAt, type }`)
  - At the start of `chat()`: prune entries older than 5 minutes
  - After parsing the model reply: detect any `suggest_reminder` action in `parsed.actions`; if found, store in `pendingSuggestions[chatId]` and remove it from the actions array so `executeAction` never sees it; surface `suggestion_text` in the reply
  - Add `isConfirmation(text)` function: returns true for `/^(yes|yeah|yep|do it|set it|sure|ok|👍|confirm)/i`
  - Before normal chat flow: if `pendingSuggestions.has(chatId)` AND `isConfirmation(userMessage)`, inject a system context message with the stored `taskId` and `remindAt` so the model emits a `set_reminder` action; delete entry from map after execution
  - _Requirements: 2.6, 2.7_

- [x] 8. Update `reasoning.js` — record engagement events after task mutations
  - After the action execution loop in `chat()`: for each `actionResult` where `result.ok` is true, call `recordEngagementEvent(db, result.id, eventType)` mapping action type → event type (`create_task`/`update_task` → `'touched'`, `complete_task` → `'completed'`, `set_reminder` → `'reminder_set'`)
  - _Requirements: 1.1, 1.2_

- [x] 9. Update `reasoning.js` — chat-driven merchant correction detection
  - Add `detectMerchantCorrection(userMessage)` function matching patterns: `/{merchant} is {category}/i`, `/that {merchant} charge is {category}/i`, `/{merchant} should be {category}/i`, `/categorise {merchant} as {category}/i`; returns `{ merchant, category }` or null
  - Add `canonicaliseCategory(raw)` function mapping synonyms: groceries/eats → `'food'`; ride/bolt/uber → `'transport'`; subscription/phone → `'bills'`; salary/payment → `'income'`; shopping → `'general'`; unknown → `raw.toLowerCase()`
  - In `chat()` after reply is parsed: call `detectMerchantCorrection(userMessage)`; if match found:
    - Query `merchant_category_map` for existing entry; if `hit_count >= 5` → do NOT call `learnMerchantCategory`, store a `type: 'merchant_correction'` entry in `pendingSuggestions`, append conflict warning to reply
    - Otherwise → call `learnMerchantCategory(merchant, category)` from `finance-import.js`; get updated-row count; append confirmation + count to reply
  - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [x] 10. Update `finance-import.js` — add `surfaceImportPatterns` export
  - Import `sendMessage` from `./telegram` at top of file (already required in `index.js`; add locally)
  - Implement `async function surfaceImportPatterns(transactions)` — never throws; all sections wrapped individually in try/catch with `console.error` on failure
  - Section 5.1: collect distinct merchants in batch where `category === 'general'`; if any, push "🏷️ N merchant(s) need a category: …"
  - Section 5.2: group batch spend by category; for each, query `budget_baselines.avg_weekly`; if batch amount > `avg_weekly * 4 * 0.5`, push "📈 category: RX imported — over 50% of 4-week baseline"
  - Section 5.3: for each distinct merchant in batch, count `DISTINCT strftime('%Y-%m', imported_date)` from `finance_entries` (prior records, not in current batch); if ≥ 2 and no `recurring_detected_` settings key, push "🔁 possible new recurring: merchant"
  - Section 6.2: compute `matchedCount / transactions.length`; if < 0.5 push "⚠️ auto-categorised M/N — K still need review"
  - Build message: header `"✅ imported N transaction(s)"` + joined lines if any
  - Call `sendMessage(fullMessage)` — wrap in try/catch
  - Export `surfaceImportPatterns`
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 6.2_

- [x] 11. Update `index.js` — call `surfaceImportPatterns` after commit + handle zero-dedup case
  - Import `surfaceImportPatterns` from `'./finance-import'`
  - In `/api/finance/import/commit` route: after `commitTransactions(valid)` succeeds, call `surfaceImportPatterns(valid)` in a try/catch — log error but do not re-throw and do not affect the response (req 7.3)
  - In the zero-dedup path of `/api/finance/import/preview` or in the commit route's `valid.length === 0` guard: call `sendMessage('✅ statement received — all transactions were already recorded, nothing new to import.')` before returning the 400 response (req 5.5)
  - Import `sendMessage` from `'./telegram'` if not already imported in `index.js`
  - _Requirements: 5.4, 5.5, 7.3_

- [x] 12. Write unit tests for `analytics.js`
  - Set up a test file `server/analytics.test.js` using Node's built-in `node:test` runner (no extra packages needed)
  - `getEngagementWindow`: returns fallback when `engagement_events` table is empty; returns fallback when < 7 distinct days; returns correct `peakHour` when history is sufficient; returns fallback without throwing when DB errors
  - `buildEnrichedFinanceSnapshot`: includes trend label when 2+ consecutive up-weeks exist; omits trend label when spend is flat; includes uncategorised count when > 0; omits when = 0; does not throw when underlying query fails
  - `recordEngagementEvent`: inserts a row with correct `hour_of_day`; handles DB error without throwing
  - Use an in-memory SQLite database (via `better-sqlite3`) seeded with known fixture data for each test case
  - _Requirements: 1.3, 1.4, 3.1, 3.2, 7.4, 7.5_

- [x] 13. Write unit tests for `reasoning.js` — state machine + merchant detection
  - `isConfirmation`: returns true for "yes", "do it", "set it", "sure", "ok", "👍", "confirm"; returns false for "no", "cancel", "not yet", random strings
  - Pending suggestion stored when model emits `suggest_reminder`; `executeAction` NOT called for that action in the same turn
  - Pending suggestion consumed and `set_reminder` IS executed when `isConfirmation` returns true on next call
  - Expired entries (> 5 min) pruned at start of next `chat()` call
  - `detectMerchantCorrection`: matches "Uber Eats is food", "that SPAR charge is groceries", "categorise bolt as transport"; returns null for unrelated messages
  - `canonicaliseCategory`: maps synonyms correctly; passes through unknown values as lowercase
  - High-confidence conflict (hit_count ≥ 5): `learnMerchantCategory` NOT called; pending correction stored
  - Normal correction: `learnMerchantCategory` called; correct updated-count appended to reply
  - Mock Groq API fetch using a simple stub
  - _Requirements: 2.6, 2.7, 4.1, 4.2, 4.3, 4.4_

- [x] 14. Write unit tests for `finance-import.js` — `surfaceImportPatterns`
  - Returns without throwing when all internal queries fail (seed broken DB handles)
  - Identifies uncategorised merchants correctly (transactions with `category === 'general'`)
  - Correctly computes spike threshold against `avg_weekly * 4 * 0.5`
  - Does not double-report already-detected recurring merchants (settings key exists)
  - Includes low-hit-rate warning when < 50% of transactions matched
  - Mock `sendMessage` to capture calls without hitting Telegram
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 6.2, 7.3_

- [x] 15. Checkpoint — run all tests and verify no regressions
  - Run `node --test server/analytics.test.js server/reasoning.test.js server/finance-import.test.js` (or equivalent test runner command)
  - Confirm all new tests pass
  - Confirm existing scheduler, task CRUD, and finance import routes still work (smoke test with the dev server)
  - Ensure `server/index.js` starts without errors after all changes
  - Ask the user if any issues arise before marking done
