# Smart Auto-Scheduling & Finance Pattern Learning — Design

## Overview

This design covers two interlocked feature areas that make Aya's PA proactive rather than reactive.

**Smart Auto-Scheduling** adds time-of-day pattern analysis on top of the existing `last_touched_at` and task-completion records. When the AI creates a task without a reminder the system prompt supplies a derived "high-engagement window" and an open-task count; the model suggests a human-readable time and waits for a one-message confirmation before executing `set_reminder`. No calendar integration, no new npm packages.

**Finance Pattern Learning** enriches the finance snapshot passed to every chat turn with trend signals (consecutive up-weeks, uncategorised count, new recurring charges) and closes the gap between statement imports and chat corrections: category corrections made in chat are persisted immediately via `learnMerchantCategory`, and post-import Telegram messages now include pattern observations instead of just a count. Both paths share the same `merchant_category_map` table already in the schema.

All changes live within the existing file set (`reasoning.js`, `scheduler.js`, `db.js`, `index.js`, `finance-import.js`). One new helper module — `server/analytics.js` — centralises the engagement-window and finance-enrichment queries so they can be unit-tested independently.

---

## Glossary

- **Engagement window**: The 2-hour clock block (e.g. 09:00–11:00) in which task interactions are most frequent, derived from `last_touched_at` and `created_at` timestamps over the last 30 days.
- **Fallback window**: 09:00–11:00 local time, used when fewer than 7 days of history exist or when the analytics query fails.
- **Pending suggestion**: A transient in-memory object stored on the `chat()` call's return path, keyed by `chatId`, recording a `taskId` and an ISO `remindAt` that the user has not yet confirmed.
- **High-confidence mapping**: A row in `merchant_category_map` with `hit_count ≥ 5` — overwrites require explicit user confirmation.
- **Spend spike**: A category where the imported batch alone exceeds 50 % of that category's 4-week baseline (`budget_baselines.avg_weekly × 4`).
- **Uncategorised transaction**: A `finance_entries` row with `category = 'general'`, `source = 'import'`.
- **`learnMerchantCategory(merchant, category)`**: Existing function in `finance-import.js` that upserts `merchant_category_map` and backfills `finance_entries`.

---

## Architecture & Module Map

```
reasoning.js          ← system prompt enrichment (engagement window + finance trends)
                        pending-suggestion state machine
                        new action type: suggest_reminder (internal only)
                        chat-driven merchant learning detection

analytics.js (new)    ← getEngagementWindow()
                        buildEnrichedFinanceSnapshot()
                        all DB queries for pattern analysis

finance-import.js     ← post-import pattern surfacing (wraps existing parseStatementFile)
                        surfaceImportPatterns() — called from import commit route

scheduler.js          ← no structural change; existing jobs unaffected

db.js                 ← two new columns on `tasks`: none needed (existing timestamps sufficient)
                        one new table: `engagement_events` (see schema below)

index.js              ← import commit route calls surfaceImportPatterns() after commitTransactions()
```

---

## Schema Changes

All DDL is additive and safe for both SQLite and Postgres via `db.js`'s `exec()` path.

### New table: `engagement_events`

Captures every meaningful task interaction for time-of-day analysis.

```sql
CREATE TABLE IF NOT EXISTS engagement_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,   -- SERIAL in PG (db.js handles this)
  task_id     INTEGER NOT NULL,
  event_type  TEXT NOT NULL,                       -- 'completed' | 'touched' | 'reminder_set'
  hour_of_day INTEGER NOT NULL,                    -- 0-23, local-time hour extracted at insert
  created_at  TEXT NOT NULL                        -- ISO 8601
);
CREATE INDEX IF NOT EXISTS idx_engagement_events_hour ON engagement_events(hour_of_day);
```

> **Why a separate table?** `last_touched_at` is a single mutable field — we need a running log of interactions to compute frequency distributions. Keeping it separate avoids modifying the tasks table and keeps analytics queries simple.

### Existing table: `merchant_category_map`

No changes. The `hit_count` field already provides the high-confidence threshold.

### Existing table: `budget_baselines`

No changes. `avg_weekly` is already populated by the Monday scheduler job and is used directly for spike detection.

### Existing table: `settings`

One new key pattern: `recurring_notified_{merchant}` — mirrors the existing `recurring_detected_{merchant}` pattern so the snapshot enrichment can tell which recurring charges have already been surfaced to the user.

---

## Module Design

### `server/analytics.js` (new)

Pure query layer — no side effects, no Telegram calls.

```
FUNCTION getEngagementWindow(db)
  INPUT:  db handle
  OUTPUT: { startHour: number, endHour: number, hasSufficientHistory: boolean }

  daysOfHistory ← COUNT DISTINCT DATE(created_at) FROM engagement_events WHERE created_at >= now-30days
  IF daysOfHistory < 7
    RETURN { startHour: 9, endHour: 11, hasSufficientHistory: false }

  hourCounts ← SELECT hour_of_day, COUNT(*) as n FROM engagement_events
               WHERE created_at >= now-30days GROUP BY hour_of_day ORDER BY n DESC

  peakHour ← hourCounts[0].hour_of_day
  RETURN { startHour: peakHour, endHour: peakHour + 2, hasSufficientHistory: true }
END FUNCTION

FUNCTION buildEnrichedFinanceSnapshot(db)
  INPUT:  db handle
  OUTPUT: string (plain-text paragraph for system prompt)

  // Base totals (existing logic, unchanged)
  ...existing loadFinanceSnapshot() logic...

  // Consecutive up-weeks trend
  weeklyByCategory ← last 6 weeks of spend grouped by (category, week)
  FOR EACH category:
    IF last 2+ consecutive weeks show increasing spend THEN
      append "food spend up N weeks in a row" to trends

  // Uncategorised count
  uncatCount ← COUNT FROM finance_entries
               WHERE category='general' AND source='import'
               AND created_at >= last_import_at
  IF uncatCount > 0 THEN append to snapshot

  // New recurring charges not yet notified
  newRecurring ← SELECT key FROM settings WHERE key LIKE 'recurring_detected_%'
                 AND key NOT LIKE 'recurring_notified_%'
  IF newRecurring.length > 0 THEN append merchants to snapshot

  RETURN concatenated snapshot string
END FUNCTION

FUNCTION recordEngagementEvent(db, taskId, eventType)
  hourOfDay ← new Date().getHours()  // caller's local hour
  INSERT INTO engagement_events (task_id, event_type, hour_of_day, created_at)
END FUNCTION
```

### `server/reasoning.js` — changes

#### 1. System prompt enrichment

`buildSystemPrompt()` calls `buildEnrichedFinanceSnapshot()` instead of `loadFinanceSnapshot()`. Wrapped in try/catch; on failure logs the error and falls back to the existing function (req 7.5).

The engagement window is fetched once per `chat()` call and injected into the system prompt:

```
<scheduling_context>
High-engagement window: {startHour}:00–{endHour}:00 (local)
Open high-priority tasks with reminders in next 2h: {count}
History sufficient: {true|false}
</scheduling_context>
```

#### 2. Pending suggestion state machine

An in-memory `Map<chatId, { taskId, remindAt, suggestedAt }>` tracks unconfirmed suggestions. Entries expire after 5 minutes (checked at the start of each `chat()` call).

```
FUNCTION chat(chatId, userMessage)
  // 1. Expire old pending suggestions
  IF pendingSuggestions.has(chatId)
    IF now - suggestion.suggestedAt > 5min THEN delete pendingSuggestions[chatId]

  // 2. Check for confirmation of pending suggestion
  IF pendingSuggestions.has(chatId) AND isConfirmation(userMessage)
    THEN inject reminder confirmation context into system prompt
         so model emits set_reminder action with the pending taskId + remindAt

  // 3. Normal chat flow (unchanged)
  ...

  // 4. After action execution: record engagement events for any task mutated
  FOR EACH actionResult WHERE ok:
    IF action.type IN ['create_task', 'complete_task', 'update_task', 'set_reminder']
      recordEngagementEvent(db, result.id, eventType)

  // 5. Detect pending suggestion in model reply
  IF model reply contains suggest_reminder action
    THEN store { taskId, remindAt } in pendingSuggestions[chatId]
         and strip the action before returning to caller (never execute it)
END FUNCTION

FUNCTION isConfirmation(text)
  RETURN /^(yes|yeah|yep|do it|set it|sure|ok|👍|confirm)/i.test(text.trim())
END FUNCTION
```

#### 3. New action type: `suggest_reminder`

Added to the system prompt's action list:

```json
{
  "type": "suggest_reminder",
  "task_id": 123,
  "remind_at": "ISO datetime",
  "suggestion_text": "want me to remind you tomorrow at 9 AM?"
}
```

This action is **never** executed by `executeAction()`. It is intercepted in `chat()` (step 5 above), stored in `pendingSuggestions`, and the `suggestion_text` is surfaced in the reply. This keeps the confirmation UX purely conversational with zero new API surface.

#### 4. Chat-driven merchant learning detection

After the LLM reply is parsed, a second pass scans `userMessage` for merchant-category statements:

```
FUNCTION detectMerchantCorrection(userMessage)
  patterns:
    - /{merchant} is {category}/i
    - /that {merchant} charge is {category}/i
    - /{merchant} should be {category}/i
    - /categorise {merchant} as {category}/i
  IF match found THEN
    merchant ← normaliseMerchant(match[1])
    category ← canonicaliseCategory(match[2])
    RETURN { merchant, category }
  RETURN null
END FUNCTION

FUNCTION canonicaliseCategory(raw)
  map: food/groceries/eats → 'food'
       transport/uber/bolt/ride → 'transport'
       bills/subscription/phone → 'bills'
       income/salary/payment → 'income'
       shopping/general → 'general'
  RETURN mapped value OR raw.toLowerCase()
END FUNCTION
```

If a correction is detected:
1. Check `merchant_category_map` for existing entry with `hit_count ≥ 5`.
2. If high-confidence conflict: do NOT call `learnMerchantCategory`; instead inject a follow-up system message asking for confirmation, and store the pending correction in `pendingSuggestions` using a `type: 'merchant_correction'` variant.
3. Otherwise: call `learnMerchantCategory(merchant, category)`, count updated rows (via a pre/post SELECT), and append count to the AI reply before returning.

The updated-row count is obtained by querying `finance_entries` for rows with `merchant = merchant AND source = 'import'` before and after the update (or using `changes` from the SQLite run result).

### `server/finance-import.js` — changes

#### Post-import pattern surfacing

A new exported function `surfaceImportPatterns(transactions, db)` is called from the import commit route in `index.js` after `commitTransactions()` succeeds. It never throws — all errors are caught and logged.

```
ASYNC FUNCTION surfaceImportPatterns(transactions, db)
  lines ← []

  // 5.1 Uncategorised merchants
  TRY
    uncatMerchants ← SET of distinct merchants in transactions WHERE category = 'general'
    IF uncatMerchants.size > 0
      lines.push("🏷️ ${uncatMerchants.size} merchant(s) need a category: ${[...uncatMerchants].join(', ')}")
  CATCH err → log, continue

  // 5.2 Spend spikes vs 4-week baseline
  TRY
    spendByCategory ← group transactions by category, sum amounts
    FOR EACH category IN spendByCategory:
      baseline ← SELECT avg_weekly FROM budget_baselines WHERE category = ?
      IF baseline AND spendByCategory[category] > baseline.avg_weekly * 4 * 0.5
        lines.push("📈 ${category}: R${amount} imported — over 50% of 4-week baseline")
  CATCH err → log, continue

  // 5.3 New recurring charges
  TRY
    merchants ← distinct merchants in transactions
    FOR EACH merchant IN merchants:
      priorMonths ← COUNT DISTINCT strftime('%Y-%m', imported_date) FROM finance_entries
                    WHERE merchant = ? AND source = 'import' AND id NOT IN current batch
      IF priorMonths >= 2 AND no 'recurring_detected_' key for this merchant
        lines.push("🔁 possible new recurring: ${merchant}")
  CATCH err → log, continue

  // 5.4 Build consolidated message
  header ← "✅ imported ${transactions.length} transaction(s)"
  IF lines.length > 0
    sendMessage(header + "\n\n" + lines.join("\n"))
  ELSE
    sendMessage(header)

  // 5.5 Zero-new-transactions case is handled upstream (before calling this function)
END FUNCTION
```

The `6.2` low-hit-rate metric is also added here:

```
  catCount ← transactions.length
  matchedCount ← transactions.filter(t => t.category !== 'general').length
  IF catCount > 0 AND matchedCount / catCount < 0.5
    lines.push("⚠️ auto-categorised ${matchedCount}/${catCount} — ${catCount - matchedCount} still need review")
```

#### `lookupCategory` — requirement 6.1

Already queries `merchant_category_map` (including chat-learned rows) before seed rules, so this requirement is already satisfied by the existing implementation. No change needed.

### `server/index.js` — changes

Import commit route gets two additions:

```javascript
// After commitTransactions(valid):
try {
  await surfaceImportPatterns(valid);
} catch (err) {
  console.error('[import] pattern surfacing failed:', err.message);
  // import already committed — do not re-throw
}
```

The `sendMessage` dependency is injected via the existing `require('./telegram')` already present in the file.

For the zero-dedup case:

```javascript
// In the /api/finance/import/commit route, after dedup check:
if (valid.length === 0) {
  sendMessage('✅ statement received — all transactions were already recorded, nothing new to import.');
  return res.status(400).json({ error: 'no valid transactions after validation' });
}
```

### `server/scheduler.js` — no structural changes

The existing `startScheduler` function, all cron schedules, and all job functions remain unchanged (req 7.1). `updateBudgetBaselines` continues to run every Monday and populate `budget_baselines`, which `surfaceImportPatterns` reads.

### `server/db.js` — schema migration

The `engagement_events` table is added to both the SQLite `exec()` block and the Postgres `initSchema()` block using the same additive `CREATE TABLE IF NOT EXISTS` pattern already used throughout the file. The new index follows the same `CREATE INDEX IF NOT EXISTS` pattern.

---

## Correctness Properties

Property 1: Engagement Window Fallback

_For any_ call to `getEngagementWindow` where fewer than 7 distinct days of engagement history exist (or where the DB query throws), the function SHALL return `{ startHour: 9, endHour: 11, hasSufficientHistory: false }` without throwing.

**Validates: Requirements 1.3, 7.4**

Property 2: Reminder Suggestion — No Auto-Set

_For any_ `chat()` call where the AI emits a `suggest_reminder` action, the `set_reminder` action SHALL NOT be executed in that same call, and the `pendingSuggestions` map SHALL contain an entry for the `chatId` with the proposed `taskId` and `remindAt`.

**Validates: Requirements 2.6**

Property 3: Confirmation Gate

_For any_ `chat()` call where `pendingSuggestions` contains an entry for the `chatId` AND `isConfirmation(userMessage)` returns true, the model SHALL emit a `set_reminder` action with the stored `taskId` and `remindAt`, and the `pendingSuggestions` entry SHALL be deleted after execution.

**Validates: Requirements 2.7**

Property 4: Import Never Aborted

_For any_ call to `surfaceImportPatterns` that throws internally, the enclosing import commit route SHALL have already called `commitTransactions` and returned a success response to the caller. The error SHALL be logged, and the function SHALL NOT propagate the exception.

**Validates: Requirements 5.4, 7.3**

Property 5: Merchant Learning — High-Confidence Confirmation

_For any_ chat-detected merchant correction where the existing `merchant_category_map` row has `hit_count ≥ 5`, `learnMerchantCategory` SHALL NOT be called until the user sends a second explicit confirmation. If no confirmation follows, the mapping SHALL remain unchanged.

**Validates: Requirements 4.4**

Property 6: Merchant Learning — Backfill Count

_For any_ chat-detected merchant correction that is applied (no high-confidence conflict, or conflict confirmed), the reply SHALL include the number of `finance_entries` rows updated for that merchant, and that count SHALL match the actual rows updated in the DB.

**Validates: Requirements 4.2, 4.3**

Property 7: Finance Snapshot Enrichment Fallback

_For any_ call to `buildEnrichedFinanceSnapshot` that throws, `buildSystemPrompt` SHALL fall back to the existing `loadFinanceSnapshot()` output and the chat response SHALL still be returned to the caller.

**Validates: Requirements 7.5**

---

## Testing Strategy

### Approach

The feature is spread across several modules; each module is tested in isolation before integration. Engagement-window and finance-snapshot logic in `analytics.js` can be tested with a seeded in-memory SQLite database. The pending-suggestion state machine in `reasoning.js` can be tested by mocking the Groq API response. Import pattern surfacing can be tested by calling `surfaceImportPatterns` directly with fixture transaction arrays.

### Unit Tests

**`analytics.js`**
- `getEngagementWindow`: returns fallback when table is empty; returns fallback when < 7 distinct days; returns correct peak hour when history is sufficient; does not throw when DB errors.
- `buildEnrichedFinanceSnapshot`: includes trend label when 2+ consecutive up-weeks exist; omits trend label when data is flat; includes uncategorised count when > 0; omits uncategorised count when = 0; does not throw when underlying query fails.
- `recordEngagementEvent`: inserts row with correct `hour_of_day`; handles DB error without throwing.

**`reasoning.js` state machine**
- `isConfirmation`: returns true for "yes", "do it", "set it", "sure", "ok", "👍"; returns false for "no", "cancel", "not yet".
- Pending suggestion entry is stored when model emits `suggest_reminder`; `set_reminder` is NOT executed in that call.
- Pending suggestion entry is consumed and `set_reminder` IS executed on confirmed follow-up.
- Expired entries (> 5 min) are pruned at start of next `chat()` call.

**`reasoning.js` merchant detection**
- `detectMerchantCorrection`: matches "Uber Eats is food", "that SPAR charge is groceries", "categorise bolt as transport"; returns null for unrelated messages.
- `canonicaliseCategory`: maps synonyms correctly; passes through unknown values as lowercase.
- High-confidence conflict: `learnMerchantCategory` not called; pending correction stored.
- Normal correction: `learnMerchantCategory` called; correct updated count appended to reply.

**`finance-import.js` `surfaceImportPatterns`**
- Returns without throwing when all internal queries fail.
- Identifies uncategorised merchants correctly.
- Correctly computes spike threshold against `avg_weekly`.
- Does not double-report already-detected recurring merchants.
- Includes low-hit-rate warning when < 50% matched.

### Property-Based Tests

- Generate random arrays of transactions with random categories; assert `surfaceImportPatterns` never throws regardless of input shape.
- Generate random engagement event histories (varying day counts, hour distributions); assert `getEngagementWindow` always returns a valid `{ startHour, endHour }` pair with `0 ≤ startHour < 24` and `endHour = startHour + 2`.
- Generate random chat messages; assert `isConfirmation` never throws and the "false positive" rate for random strings is < 5%.

### Integration Tests

- Full import flow: seed `budget_baselines`, call `/api/finance/import/commit` with fixture transactions, assert `sendMessage` was called with a message containing the import count.
- Zero-dedup flow: import the same fixture twice; assert the second call triggers the "already recorded" Telegram message.
- Chat merchant correction flow: send a chat message containing a merchant correction; assert `merchant_category_map` is updated and the reply contains an updated-count string.
- Engagement window in system prompt: after seeding 10+ days of `engagement_events`, assert the system prompt injected into the Groq API call contains a `<scheduling_context>` block with the expected hours.

---

## Regression Considerations

- All existing cron jobs in `scheduler.js` call DB functions that are unchanged. The `engagement_events` inserts happen only from `reasoning.js` and are additive — they cannot affect existing queries.
- `lookupCategory` in `finance-import.js` is unchanged; the post-import surfacing is a separate function that runs after `commitTransactions` and is fully isolated.
- The `pendingSuggestions` map is module-level state in `reasoning.js`. It is keyed by `chatId` and self-pruning. A server restart clears it, which is acceptable — the user simply re-describes the task.
- The `suggest_reminder` action type is only emitted by the model in the new prompting context and is explicitly filtered out before `executeAction` sees it, so any model hallucination of that type on existing prompts is harmlessly discarded.
