'use strict';

/**
 * analytics.js — Pattern analysis helpers for smart scheduling and finance enrichment.
 *
 * Functions receive a `db` handle (the module exported from ./db) so they can be
 * unit-tested with an in-memory SQLite instance without touching the real database.
 */

const FALLBACK_WINDOW = { startHour: 9, endHour: 11, hasSufficientHistory: false };

/**
 * Returns the 2-hour engagement window derived from the last 30 days of
 * engagement_events.  Falls back to 09:00–11:00 when history is sparse or
 * a DB error occurs.
 *
 * @param {object} db - The db module (from ./db), exposing `prepare(sql)`.
 * @returns {Promise<{ startHour: number, endHour: number, hasSufficientHistory: boolean }>}
 */
async function getEngagementWindow(db) {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Count distinct calendar days with any engagement activity in the last 30 days
    const countRow = await db.prepare(
      `SELECT COUNT(DISTINCT DATE(created_at)) AS distinctDays
       FROM engagement_events
       WHERE created_at >= ?`
    ).get(thirtyDaysAgo);

    const distinctDays = countRow ? (countRow.distinctDays || 0) : 0;

    if (distinctDays < 7) {
      return FALLBACK_WINDOW;
    }

    // Find the hour with the highest event frequency
    const rows = await db.prepare(
      `SELECT hour_of_day, COUNT(*) AS n
       FROM engagement_events
       WHERE created_at >= ?
       GROUP BY hour_of_day
       ORDER BY n DESC`
    ).all(thirtyDaysAgo);

    if (!rows || rows.length === 0) {
      return FALLBACK_WINDOW;
    }

    const peakHour = rows[0].hour_of_day;
    return { startHour: peakHour, endHour: peakHour + 2, hasSufficientHistory: true };

  } catch (err) {
    console.error('[analytics] getEngagementWindow error:', err.message);
    return FALLBACK_WINDOW;
  }
}

/**
 * Returns an enriched finance snapshot string for use in the system prompt.
 * Ports the base logic from loadFinanceSnapshot() in reasoning.js, then appends
 * three enrichment signals: consecutive up-weeks trend, uncategorised count, and
 * new recurring charges not yet notified.
 *
 * Each enrichment section is individually try/catch-ed so a single failure does
 * not suppress the others or the base snapshot.
 *
 * @param {object} db - The db module (from ./db), exposing `prepare(sql)`.
 * @returns {Promise<string>}
 */
async function buildEnrichedFinanceSnapshot(db) {
  // ── Base snapshot (ported from loadFinanceSnapshot in reasoning.js) ──────────
  const month = new Date().toISOString().slice(0, 7);
  const rows  = await db.prepare(
    `SELECT type, SUM(amount) as total FROM finance_entries WHERE created_at >= ? GROUP BY type`
  ).all(`${month}-01`);

  const income  = rows.find(r => r.type === 'income')?.total  || 0;
  const expense = rows.find(r => r.type === 'expense')?.total || 0;

  const wkStart  = (() => { const d = new Date(); d.setDate(d.getDate() - d.getDay()); d.setHours(0,0,0,0); return d.toISOString(); })();
  const lwkStart = (() => { const d = new Date(); d.setDate(d.getDate() - d.getDay() - 7); d.setHours(0,0,0,0); return d.toISOString(); })();
  const lwkEnd   = (() => { const d = new Date(); d.setDate(d.getDate() - d.getDay() - 1); d.setHours(23,59,59,999); return d.toISOString(); })();

  const tw    = await db.prepare(`SELECT category, SUM(amount) as total FROM finance_entries WHERE type='expense' AND created_at>=? GROUP BY category`).all(wkStart);
  const lw    = await db.prepare(`SELECT category, SUM(amount) as total FROM finance_entries WHERE type='expense' AND created_at>=? AND created_at<=? GROUP BY category`).all(lwkStart, lwkEnd);
  const lwMap = Object.fromEntries(lw.map(r => [r.category, r.total]));
  const spikes = tw.filter(r => { const p = lwMap[r.category] || 0; return p > 0 && r.total > p * 1.4; })
                   .map(r => `${r.category}(R${r.total.toFixed(0)} vs R${(lwMap[r.category] || 0).toFixed(0)})`);
  const top = [...tw].sort((a, b) => b.total - a.total)[0];

  let base = `Income R${income.toFixed(2)}, expenses R${expense.toFixed(2)}, net R${(income - expense).toFixed(2)}.`;
  if (top)           base += ` Top spend: ${top.category} R${top.total.toFixed(0)}.`;
  if (spikes.length) base += ` Spikes: ${spikes.join(', ')}.`;

  // ── Enrichments ──────────────────────────────────────────────────────────────
  const enrichments = [];

  // Enrichment 1 — Consecutive up-weeks trend (req 3.1)
  try {
    const sixWeeksAgo = new Date(Date.now() - 42 * 24 * 60 * 60 * 1000).toISOString();
    const weekRows = await db.prepare(
      `SELECT strftime('%Y-%W', COALESCE(imported_date, created_at)) AS week,
              category,
              SUM(amount) AS total
       FROM finance_entries
       WHERE type='expense' AND created_at >= ?
       GROUP BY week, category`
    ).all(sixWeeksAgo);

    // Group by category → sorted list of weekly totals
    const byCat = {};
    for (const r of weekRows) {
      if (!byCat[r.category]) byCat[r.category] = [];
      byCat[r.category].push({ week: r.week, total: r.total });
    }

    for (const [category, weeks] of Object.entries(byCat)) {
      weeks.sort((a, b) => (a.week < b.week ? -1 : a.week > b.week ? 1 : 0));
      if (weeks.length < 2) continue;

      // Count consecutive increasing weeks at the tail of the series
      let streak = 1;
      for (let i = weeks.length - 1; i >= 1; i--) {
        if (weeks[i].total > weeks[i - 1].total) {
          streak++;
        } else {
          break;
        }
      }

      if (streak >= 2) {
        enrichments.push(`${category} spend up ${streak} weeks in a row`);
      }
    }
  } catch (err) {
    console.error('[analytics] buildEnrichedFinanceSnapshot up-weeks trend error:', err.message);
  }

  // Enrichment 2 — Uncategorised count (req 3.2)
  try {
    const uncatRow = await db.prepare(
      `SELECT COUNT(*) AS n FROM finance_entries WHERE category='general' AND source='import'`
    ).get();
    const n = uncatRow ? (uncatRow.n || 0) : 0;
    if (n > 0) {
      enrichments.push(`${n} imported transaction(s) still uncategorised`);
    }
  } catch (err) {
    console.error('[analytics] buildEnrichedFinanceSnapshot uncategorised count error:', err.message);
  }

  // Enrichment 3 — New recurring charges not yet notified (req 3.3)
  try {
    const detectedRows = await db.prepare(
      `SELECT key, value FROM settings WHERE key LIKE 'recurring_detected_%'`
    ).all();

    const notifiedRows = await db.prepare(
      `SELECT key FROM settings WHERE key LIKE 'recurring_notified_%'`
    ).all();

    const notifiedSet = new Set(notifiedRows.map(r => r.key));

    const newMerchants = detectedRows
      .filter(r => {
        const merchant = r.key.replace('recurring_detected_', '');
        return !notifiedSet.has(`recurring_notified_${merchant}`);
      })
      .map(r => r.value || r.key.replace('recurring_detected_', ''));

    if (newMerchants.length > 0) {
      enrichments.push(`New recurring charges spotted: ${newMerchants.join(', ')}`);
    }
  } catch (err) {
    console.error('[analytics] buildEnrichedFinanceSnapshot recurring charges error:', err.message);
  }

  // ── Assemble final snapshot ───────────────────────────────────────────────────
  if (enrichments.length > 0) {
    return `${base} ${enrichments.join('. ')}.`;
  }
  return base;
}

/**
 * Records a single engagement event for a given task.
 * Failure is non-fatal — errors are logged but never thrown.
 *
 * @param {object} db        - The db module (from ./db), exposing `prepare(sql)`.
 * @param {string|number} taskId    - The task associated with the event.
 * @param {string} eventType - E.g. 'sent', 'replied', 'snoozed'.
 */
async function recordEngagementEvent(db, taskId, eventType) {
  try {
    const hourOfDay = new Date().getHours(); // local hour 0–23
    await db.prepare(
      `INSERT INTO engagement_events (task_id, event_type, hour_of_day, created_at) VALUES (?, ?, ?, ?)`
    ).run(taskId, eventType, hourOfDay, new Date().toISOString());
  } catch (err) {
    console.error('[analytics] recordEngagementEvent error:', err.message);
    // never throws — failure is non-fatal
  }
}

module.exports = { getEngagementWindow, buildEnrichedFinanceSnapshot, recordEngagementEvent };
