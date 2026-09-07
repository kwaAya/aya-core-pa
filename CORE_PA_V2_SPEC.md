# Core PA — Project Overview & v2 Feature Request

## What this is

A personal task-capture and reminder system built for Aya (Unako Mtumtum), designed specifically around executive dysfunction / ADHD needs — the core problem it solves is: *"I tell myself I'll remember to do something, I don't write it down, and it just never happens."*

It is NOT a generic to-do app. The two things it's explicitly built to do that generic apps don't:
1. **Actively pings via Telegram** — doesn't rely on Aya opening an app to check it.
2. **Nudges on stale/untouched tasks** — surfaces things that have been silently ignored, not just things with a deadline.

## Current v1 stack (already built and working)

- **Backend:** Node.js + Express
- **Database:** SQLite (via better-sqlite3)
- **Notifications:** Telegram Bot API (node-telegram-bot-api)
- **Scheduler:** node-cron — checks every 5 min for due reminders, daily at 9am for stale tasks
- **Frontend:** Vanilla HTML/CSS/JS PWA (installable to phone home screen), styled in Aya Core's dark chrome/hotpink brand aesthetic

## Current v1 data model (tasks table)

- `title`, `notes`
- `status` — open | done
- `remind_at` — one-time reminder datetime (nullable)
- `reminded` — whether that one-time reminder already fired
- `stale_days` — how many untouched days before a nudge fires
- `last_touched_at`, `created_at`

## v2 feature request: priority-based escalating reminders

**The problem:** right now, a reminder fires once at `remind_at` and that's it. There's no differentiation for how urgently something needs to be re-surfaced if it's ignored.

**The ask:** add a `priority` field per task (e.g. `low | medium | high`, or a numeric scale) that changes the **re-ping interval** if a task is reminded but not marked done:

- **High priority:** if not done shortly after the reminder fires, re-ping again in ~5 minutes, then again shortly after, escalating urgency (e.g. exact intervals TBD — something like 5 min → 15 min → 1 hour).
- **Medium priority:** re-ping every ~1 hour if still open.
- **Low priority:** re-ping every ~3 days if still open (essentially the existing stale-check behavior, just tied to priority instead of a flat default).

**Implementation notes for whoever builds this:**
- This is essentially generalizing the existing `reminded` flag + `stale_days` stale-check into a **repeating escalation schedule per priority tier**, rather than a single one-time flag.
- Suggested approach: replace the single `reminded` boolean with a `next_ping_at` timestamp that gets recalculated after every ping based on the task's priority tier, until the task is marked done.
- The scheduler (`scheduler.js`) already runs every 5 minutes — that cadence already supports a "5 min" high-priority tier without needing a faster cron.
- Keep it configurable — priority tiers and their intervals should probably live in one config object, not hardcoded scattered through the scheduler, so intervals can be tuned later without touching logic.

## Explicitly out of scope for this pass

- Finance/bank tracking (separate, larger feature — needs research into SA banking API options)
- "Talk through my day" LLM reasoning layer
- Auto-scheduling / AI-suggested timing

Keep the scope to: priority field + escalating re-ping logic + reflecting priority in the web app UI (e.g. a color or icon per task showing its tier).
