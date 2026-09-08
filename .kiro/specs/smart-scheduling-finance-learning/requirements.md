# Requirements: Smart Auto-Scheduling & Finance Pattern Learning

## Introduction

Aya Core PA currently handles tasks and finances reactively — reminders are set manually, and finance categorisation only improves when the user explicitly corrects a transaction via the web UI. This feature makes the assistant proactive in both areas.

**Smart Auto-Scheduling** teaches the AI to observe when Aya actually engages with and completes tasks, then use those patterns to suggest (and, with confirmation, set) optimal reminder times. No calendar integration is involved — patterns are derived purely from `last_touched_at`, completion timestamps, and the existing task metadata in the database.

**Finance Pattern Learning** extends the existing merchant→category map and finance snapshot so that: (a) the AI learns from chat corrections mid-conversation, (b) new statement imports are automatically surfaced with pattern observations, and (c) the finance snapshot passed to the AI in every chat already contains trend insights rather than just raw totals.

Both features operate exclusively through the existing Telegram interface and the existing reasoning / scheduler / finance-import pipeline.

---

## Requirements

### 1. Engagement Pattern Tracking

1.1 WHEN a task is completed THEN the system SHALL record the completion timestamp so that time-of-day engagement data accumulates over time.

1.2 WHEN a task's `last_touched_at` is updated (via any interaction — chat reply, reminder acknowledgement, manual edit) THEN the system SHALL preserve that timestamp so it is available for pattern analysis.

1.3 WHEN there are fewer than 7 days of engagement history in the database THEN the system SHALL NOT attempt to derive scheduling patterns and SHALL fall back to a default suggestion window (9 AM–11 AM local time).

1.4 WHEN engagement history exists THEN the system SHALL be able to identify the hours of day with the highest task interaction frequency (the "high-engagement window") for use in scheduling suggestions.

### 2. AI-Suggested Reminder Times

2.1 WHEN the AI creates a task and no `remind_at` is specified by the user THEN the system SHALL have the AI suggest a reminder time in the reply based on: task priority, the current open task load, and (when available) Aya's high-engagement window.

2.2 WHEN task priority is `high` THEN the system SHALL suggest a reminder time within the next high-engagement window (same day if one exists today, otherwise first window tomorrow).

2.3 WHEN task priority is `normal` THEN the system SHALL suggest a reminder time within the next 24–48 hours, targeting a high-engagement window.

2.4 WHEN task priority is `low` THEN the system SHALL suggest a reminder time 3–7 days out, targeting a high-engagement window.

2.5 WHEN more than 3 open high-priority tasks already have reminders scheduled within the same 2-hour window THEN the system SHALL offset the suggested time by at least 2 hours to avoid stacking.

2.6 WHEN the AI suggests a reminder time THEN the reply SHALL include the proposed time in plain language (e.g. "want me to remind you tomorrow at 9 AM?") and SHALL NOT set the reminder without explicit confirmation.

2.7 WHEN the user confirms a suggested reminder (e.g. "yes", "do it", "set it") in the following message THEN the system SHALL execute a `set_reminder` action for the previously suggested task and time.

2.8 WHEN the task is recurring THEN the system SHALL factor in the user's historical pattern for tasks with similar titles or categories when suggesting the reminder time.

### 3. Finance Snapshot Enrichment

3.1 WHEN the AI finance snapshot is built for the system prompt THEN the system SHALL include, in addition to current totals, any spend categories that have increased week-over-week for 2 or more consecutive weeks (expressed as a plain-language trend, e.g. "food spend up 3 weeks in a row").

3.2 WHEN the AI finance snapshot is built THEN the system SHALL include the count of transactions imported in the most recent import batch that remain uncategorised (category = `'general'` and source = `'import'`), if that count is greater than 0.

3.3 WHEN the AI finance snapshot is built THEN the system SHALL include any new recurring charges detected since the last weekly digest (i.e. merchants flagged by `detectRecurringTransactions` that have not yet been mentioned in a Telegram message).

3.4 WHEN the system prompt finance snapshot includes trend insights or unreviewed transactions THEN the AI SHALL proactively surface these in its reply if the user has not already asked about finances in that conversation turn.

### 4. Chat-Driven Merchant Learning

4.1 WHEN the user states in chat that a merchant belongs to a specific category (e.g. "that SPAR charge is groceries", "Uber Eats is food") THEN the system SHALL persist that mapping to `merchant_category_map` exactly as `learnMerchantCategory` does today.

4.2 WHEN a merchant→category mapping is learned from chat THEN the system SHALL retroactively update all existing `finance_entries` rows for that merchant (source = `'import'`) to the corrected category, consistent with the existing `learnMerchantCategory` behaviour.

4.3 WHEN a merchant→category mapping is learned from chat THEN the system SHALL confirm to the user in the reply that the mapping has been saved and how many past transactions were updated.

4.4 WHEN the user provides a category correction in chat that conflicts with an existing high-confidence mapping (hit_count ≥ 5) THEN the system SHALL note the conflict in its reply and ask for explicit confirmation before overwriting.

### 5. Import-Time Pattern Surfacing

5.1 WHEN a bank statement is imported THEN the system SHALL identify merchants present in the import that have no entry in `merchant_category_map` and no matching seed rule, and SHALL queue a Telegram message listing them so the user can categorise them.

5.2 WHEN a bank statement is imported THEN the system SHALL compare the imported transactions against the prior 4-week spend baseline per category and SHALL include in the post-import Telegram message any category where the imported batch alone exceeds 50% of the 4-week average for that category.

5.3 WHEN a bank statement is imported THEN the system SHALL detect subscription/recurring charges present in the import that were not in `merchant_category_map` as recurring (i.e. same merchant appearing in ≥ 2 prior imports) and SHALL surface them as new recurring charges in the post-import summary.

5.4 WHEN a bank statement is imported and all transactions are successfully deduplicated and committed THEN the system SHALL send a single consolidated Telegram summary covering: import count, auto-categorised count, uncategorised merchants (req 5.1), spend spikes (req 5.2), and new recurring charges (req 5.3).

5.5 WHEN a bank statement import results in zero new transactions after deduplication THEN the system SHALL send a brief Telegram message confirming the import was received and all transactions were already recorded.

### 6. Auto-Categorisation Improvement

6.1 WHEN a new bank statement is imported THEN the system SHALL apply the full `merchant_category_map` (including all chat-learned mappings, not only seed rules) before falling back to `'general'`, so that previously learned merchants are automatically categorised.

6.2 WHEN the auto-categorisation hit rate for an import (proportion of transactions matched by `merchant_category_map`) is below 50% THEN the system SHALL include that metric in the post-import Telegram summary so the user is aware many transactions need review.

6.3 WHEN the user reviews and corrects categories for uncategorised import transactions via Telegram chat THEN those corrections SHALL be persisted via the existing `learnMerchantCategory` path (requirement 4.1 applies).

### 7. Regression Prevention

7.1 WHEN none of the new smart-scheduling logic is triggered (no task created without a reminder, no suggestion pending confirmation) THEN the existing reminder, escalating-ping, stale-nudge, and recurring-task flows SHALL continue to operate exactly as they do today.

7.2 WHEN no chat-based merchant correction is detected in a conversation THEN the existing manual `learnMerchantCategory` flow from the web UI SHALL continue to work unchanged.

7.3 WHEN a bank statement is imported and the new pattern-surfacing logic throws an unhandled error THEN the import itself SHALL still succeed — the error SHALL be logged and the Telegram summary SHALL be sent without the failed section, rather than aborting the import.

7.4 WHEN the engagement history database query fails (e.g. table doesn't exist yet) THEN the scheduling suggestion SHALL fall back to the default window (requirement 1.3) and the failure SHALL be logged without crashing the chat handler.

7.5 WHEN the AI finance snapshot enrichment query fails THEN the system prompt SHALL fall back to the existing raw-totals snapshot and the error SHALL be logged without interrupting the chat response.
