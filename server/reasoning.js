const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const fs   = require('fs');
const path = require('path');
const db   = require('./db');
const { getEngagementWindow, buildEnrichedFinanceSnapshot, recordEngagementEvent } = require('./analytics');
const { learnMerchantCategory } = require('./finance-import');

// ─── Pending suggestion state ─────────────────────────────────────────────────
// Tracks unconfirmed suggest_reminder proposals, keyed by chatId.
// { taskId, remindAt, suggestedAt }  — expires after 5 minutes.
const pendingSuggestions = new Map();
const SUGGESTION_TTL_MS = 5 * 60 * 1000;

const GROQ_MODEL   = 'groq/compound-mini';
const PROFILE_PATH = path.join(__dirname, 'profile.md');

const MAX_TURNS = 20;

async function loadHistory(chatId) {
  const rows = await db.prepare(
    `SELECT role, content FROM chat_history
     WHERE chat_id = ? ORDER BY created_at ASC LIMIT ?`
  ).all(chatId, MAX_TURNS * 2);
  return rows.map(r => ({ role: r.role, content: r.content }));
}

async function saveMessage(chatId, role, content) {
  await db.prepare(
    `INSERT INTO chat_history (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)`
  ).run(chatId, role, content, new Date().toISOString());
  // keep only last MAX_TURNS*2 messages per chatId to avoid unbounded growth
  await db.prepare(
    `DELETE FROM chat_history WHERE chat_id = ? AND id NOT IN (
      SELECT id FROM chat_history WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?
    )`
  ).run(chatId, chatId, MAX_TURNS * 2);
}

// ─── Context loaders ──────────────────────────────────────────────────────────

function loadProfile() {
  try { return fs.readFileSync(PROFILE_PATH, 'utf-8'); }
  catch { return '(no profile set yet)'; }
}

async function loadTaskSnapshot() {
  const open = await db.prepare(
    `SELECT id, title, priority, remind_at, recurring
     FROM tasks WHERE status = 'open'
     ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 ELSE 1 END ASC, created_at ASC`
  ).all();
  if (!open.length) return 'No open tasks.';
  return open.map((t, i) =>
    `${i+1}. [id:${t.id}] [${t.priority}] ${t.title}` +
    (t.remind_at ? ` (reminder: ${t.remind_at})` : '') +
    (t.recurring  ? ` [↻ ${t.recurring}]` : '')
  ).join('\n');
}

async function loadFinanceSnapshot() {
  const month = new Date().toISOString().slice(0, 7);
  const rows  = await db.prepare(`SELECT type, SUM(amount) as total FROM finance_entries WHERE created_at >= ? GROUP BY type`).all(`${month}-01`);
  if (!rows.length) return 'No finance entries this month.';
  const income  = rows.find(r => r.type === 'income')?.total  || 0;
  const expense = rows.find(r => r.type === 'expense')?.total || 0;

  const wkStart  = (() => { const d=new Date(); d.setDate(d.getDate()-d.getDay()); d.setHours(0,0,0,0); return d.toISOString(); })();
  const lwkStart = (() => { const d=new Date(); d.setDate(d.getDate()-d.getDay()-7); d.setHours(0,0,0,0); return d.toISOString(); })();
  const lwkEnd   = (() => { const d=new Date(); d.setDate(d.getDate()-d.getDay()-1); d.setHours(23,59,59,999); return d.toISOString(); })();
  const tw   = await db.prepare(`SELECT category, SUM(amount) as total FROM finance_entries WHERE type='expense' AND created_at>=? GROUP BY category`).all(wkStart);
  const lw   = await db.prepare(`SELECT category, SUM(amount) as total FROM finance_entries WHERE type='expense' AND created_at>=? AND created_at<=? GROUP BY category`).all(lwkStart, lwkEnd);
  const lwMap = Object.fromEntries(lw.map(r=>[r.category,r.total]));
  const spikes = tw.filter(r=>{ const p=lwMap[r.category]||0; return p>0&&r.total>p*1.4; }).map(r=>`${r.category}(R${r.total.toFixed(0)} vs R${(lwMap[r.category]||0).toFixed(0)})`);
  const top = [...tw].sort((a,b)=>b.total-a.total)[0];

  let s=`Income R${income.toFixed(2)}, expenses R${expense.toFixed(2)}, net R${(income-expense).toFixed(2)}.`;
  if (top)           s+=` Top spend: ${top.category} R${top.total.toFixed(0)}.`;
  if (spikes.length) s+=` Spikes: ${spikes.join(', ')}.`;
  return s;
}

async function buildSystemPrompt() {
  const today    = new Date().toISOString().slice(0,10);
  const profile  = loadProfile();
  const tasks    = await loadTaskSnapshot();

  let finances;
  try {
    finances = await buildEnrichedFinanceSnapshot(db);
  } catch (err) {
    console.error('[reasoning] enriched finance snapshot failed, falling back:', err.message);
    finances = await loadFinanceSnapshot();
  }

  let engagementWindow = { startHour: 9, endHour: 11, hasSufficientHistory: false };
  try {
    engagementWindow = await getEngagementWindow(db);
  } catch (err) {
    console.error('[reasoning] getEngagementWindow failed, using fallback:', err.message);
  }

  // Count open high-priority tasks with reminders in the next 2 hours
  const twoHoursFromNow = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  let upcomingHighCount = 0;
  try {
    const upcomingRow = await db.prepare(
      `SELECT COUNT(*) AS n FROM tasks
       WHERE status='open' AND priority='high' AND remind_at IS NOT NULL AND remind_at <= ?`
    ).get(twoHoursFromNow);
    upcomingHighCount = upcomingRow ? (upcomingRow.n || 0) : 0;
  } catch (err) {
    console.error('[reasoning] upcoming high count query failed:', err.message);
  }

  return `You are Aya's personal AI assistant — a thinking partner AND an action layer for her task list and life.

Today's date: ${today}

<user_profile>
${profile}
</user_profile>

<current_open_tasks>
${tasks}
</current_open_tasks>

<finances_this_month>
${finances}
</finances_this_month>

<scheduling_context>
High-engagement window: ${engagementWindow.startHour}:00–${engagementWindow.endHour}:00 (local time)
History sufficient: ${engagementWindow.hasSufficientHistory}
Open high-priority tasks with reminders in next 2h: ${upcomingHighCount}
</scheduling_context>

RESPONSE FORMAT (critical):
You must ALWAYS respond with valid JSON in exactly this shape:
{
  "actions": [...],
  "reply": "your message to the user"
}

The "actions" array contains zero or more task operations you want to perform. Supported actions:

{ "type": "create_task", "title": "...", "notes": "...", "priority": "high|normal|low", "remind_at": "ISO datetime or null", "recurring": "daily|weekly|monthly or null", "stale_days": 3 }
{ "type": "complete_task", "task_id": 123 }
{ "type": "delete_task", "task_id": 123 }
{ "type": "set_reminder", "task_id": 123, "remind_at": "ISO datetime" }
{ "type": "update_task", "task_id": 123, "title": "...", "notes": "...", "priority": "..." }
{ "type": "suggest_reminder", "task_id": 123, "remind_at": "ISO datetime", "suggestion_text": "want me to remind you tomorrow at 9 AM?" }

Scheduling guidance (when creating a task without a remind_at):
- Instead of setting remind_at directly, emit a suggest_reminder action with a proposed time
- suggest_reminder is NEVER executed automatically — it surfaces a suggestion for the user to confirm
- High priority: suggest within the high-engagement window today (same day if window hasn't passed, else tomorrow at that hour)
- Normal priority: suggest 24–48h from now, targeting the engagement window hour
- Low priority: suggest 3–7 days out, targeting the engagement window hour
- If open high-priority tasks with reminders in next 2h > 3: offset suggestion by at least 2 hours to avoid stacking
- Use the <scheduling_context> block above for the engagement window hours and upcoming load count

Rules:
- Use actions proactively. If the user mentions needing to do something → create it. If they say they're done → complete it. Don't ask permission when intent is obvious.
- task_id comes from the [id:X] shown in the task list above.
- For remind_at: if the user says "tomorrow 9am", calculate the actual ISO datetime from today's date.
- If no actions needed, use an empty array: "actions": []
- Keep replies casual, direct, Gen-Z energy. Acknowledge any actions you took naturally in the reply.
- Do NOT wrap the JSON in markdown code blocks. Return raw JSON only.`;
}

// ─── Action executor ──────────────────────────────────────────────────────────

async function resolveTask(task_id, task_title) {
  if (task_id) {
    const t = await db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(task_id);
    if (t) return t;
  }
  if (task_title) {
    return db.prepare(`SELECT * FROM tasks WHERE status='open' AND LOWER(title) LIKE ? ORDER BY created_at DESC LIMIT 1`)
      .get(`%${task_title.toLowerCase()}%`);
  }
  return null;
}

async function executeAction(action) {
  const now = new Date().toISOString();
  const type = action.type;

  if (type === 'create_task') {
    if (!action.title) return { error: 'title required' };
    const staleMins = action.stale_minutes || (action.stale_days ? action.stale_days * 1440 : 4320);
    const r = await db.prepare(
      `INSERT INTO tasks (title,notes,priority,remind_at,stale_minutes,recurring,status,last_touched_at,created_at)
       VALUES(?,?,?,?,?,?,'open',?,?)`
    ).run(action.title.trim(), action.notes||null, action.priority||'normal', action.remind_at||null, staleMins, action.recurring||null, now, now);
    return { ok:true, action:'created', id: r.lastInsertRowid, title: action.title };
  }

  if (type === 'complete_task') {
    const t = await resolveTask(action.task_id, action.task_title);
    if (!t) return { error: `task not found: ${action.task_id||action.task_title}` };
    await db.prepare(`UPDATE tasks SET status='done', last_touched_at=?, next_ping_at=NULL, ping_count=0 WHERE id=?`).run(now, t.id);
    return { ok:true, action:'completed', id:t.id, title:t.title };
  }

  if (type === 'delete_task') {
    const t = await resolveTask(action.task_id, action.task_title);
    if (!t) return { error: `task not found` };
    await db.prepare(`DELETE FROM tasks WHERE id=?`).run(t.id);
    return { ok:true, action:'deleted', title:t.title };
  }

  if (type === 'set_reminder') {
    const t = await resolveTask(action.task_id, action.task_title);
    if (!t) return { error: 'task not found' };
    if (!action.remind_at) return { error: 'remind_at required' };
    await db.prepare(`UPDATE tasks SET remind_at=?, reminded=0, next_ping_at=NULL, ping_count=0, last_touched_at=? WHERE id=?`).run(action.remind_at, now, t.id);
    return { ok:true, action:'reminder_set', id:t.id, title:t.title, remind_at:action.remind_at };
  }

  if (type === 'update_task') {
    const t = await resolveTask(action.task_id, action.task_title);
    if (!t) return { error: 'task not found' };
    await db.prepare(`UPDATE tasks SET title=COALESCE(?,title), notes=COALESCE(?,notes), priority=COALESCE(?,priority), last_touched_at=? WHERE id=?`)
      .run(action.title||null, action.notes||null, action.priority||null, now, t.id);
    return { ok:true, action:'updated', id:t.id };
  }

  return { error: `unknown action type: ${type}` };
}

// ─── Confirmation helper ──────────────────────────────────────────────────────

function isConfirmation(text) {
  return /^(yes|yeah|yep|do it|set it|sure|ok|👍|confirm)/i.test(text.trim());
}

// ─── Merchant correction detection ───────────────────────────────────────────

function detectMerchantCorrection(text) {
  const patterns = [
    /^(.+?)\s+is\s+(.+)$/i,
    /^that\s+(.+?)\s+charge\s+is\s+(.+)$/i,
    /^(.+?)\s+should\s+be\s+(.+)$/i,
    /^categoris[e]?\s+(.+?)\s+as\s+(.+)$/i,
  ];
  for (const re of patterns) {
    const m = text.trim().match(re);
    if (m) return { merchant: m[1].trim(), category: canonicaliseCategory(m[2].trim()) };
  }
  return null;
}

function canonicaliseCategory(raw) {
  const map = {
    groceries: 'food', eats: 'food', eating: 'food',
    ride: 'transport', rides: 'transport', bolt: 'transport', uber: 'transport',
    subscription: 'bills', subscriptions: 'bills', phone: 'bills',
    salary: 'income', payment: 'income',
    shopping: 'general',
  };
  const lower = raw.toLowerCase();
  return map[lower] || lower;
}

// ─── Main chat ────────────────────────────────────────────────────────────────

async function chat(chatId, userMessage) {
  // Prune expired pending suggestions
  for (const [id, entry] of pendingSuggestions.entries()) {
    if (Date.now() - entry.suggestedAt > SUGGESTION_TTL_MS) {
      pendingSuggestions.delete(id);
    }
  }

  const convo = await loadHistory(chatId);

  convo.push({ role: 'user', content: userMessage });
  await saveMessage(chatId, 'user', userMessage);

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');

  const systemPrompt = await buildSystemPrompt();

  // If user is confirming a pending suggestion, inject context so model executes set_reminder
  const pending = pendingSuggestions.get(String(chatId));
  if (pending && isConfirmation(userMessage)) {
    convo.push({
      role: 'system',
      content: `The user just confirmed the pending reminder suggestion. Execute a set_reminder action for task_id=${pending.taskId} with remind_at="${pending.remindAt}". Do not ask again.`
    });
  }

  const res = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'system', content: systemPrompt }, ...convo],
    }),
  });

  if (!res.ok) throw new Error(`Groq API error (${res.status}): ${await res.text()}`);

  const data = await res.json();
  const raw  = data.choices?.[0]?.message?.content || '{}';

  // parse structured response
  let parsed;
  try {
    const cleaned = raw.replace(/^```[a-z]*\n?/,'').replace(/\n?```$/,'').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    await saveMessage(chatId, 'assistant', raw);
    return { reply: raw, tasksChanged: false };
  }

  const actions      = Array.isArray(parsed.actions) ? [...parsed.actions] : [];
  const suggestionAction = actions.find(a => a.type === 'suggest_reminder');
  if (suggestionAction) {
    // Store pending suggestion — never execute it
    pendingSuggestions.set(String(chatId), {
      taskId: suggestionAction.task_id,
      remindAt: suggestionAction.remind_at,
      suggestedAt: Date.now(),
    });
    // Remove from actions so executeAction never sees it
    actions.splice(actions.indexOf(suggestionAction), 1);
  }
  const reply        = parsed.reply || raw;
  const actionResults = [];
  let   tasksChanged  = false;

  for (const action of actions) {
    const result = await executeAction(action);
    actionResults.push(result);
    if (result.ok) {
      tasksChanged = true;
      // Record engagement event for the affected task
      const eventTypeMap = {
        create_task:   'touched',
        update_task:   'touched',
        complete_task: 'completed',
        set_reminder:  'reminder_set',
      };
      const evType = eventTypeMap[action.type];
      if (evType && result.id) {
        await recordEngagementEvent(db, result.id, evType);
      }
    }
  }

  // If we had a pending suggestion and a set_reminder succeeded, clear the pending entry
  if (pending && pendingSuggestions.has(String(chatId))) {
    const didSetReminder = actionResults.some(r => r.ok && r.action === 'reminder_set');
    if (didSetReminder) pendingSuggestions.delete(String(chatId));
  }

  // ─── Chat-driven merchant correction ─────────────────────────────────────────
  let replyText = reply;
  try {
    const correction = detectMerchantCorrection(userMessage);
    if (correction) {
      const { merchant, category } = correction;

      // Check for high-confidence existing mapping
      const existing = await db.prepare(
        `SELECT hit_count FROM merchant_category_map WHERE pattern = ?`
      ).get(merchant.toLowerCase());

      if (existing && existing.hit_count >= 5) {
        // Store pending correction and ask for confirmation
        pendingSuggestions.set(String(chatId) + '_merchant', {
          type: 'merchant_correction',
          merchant,
          category,
          suggestedAt: Date.now(),
        });
        replyText = `heads up — i already have ${merchant} mapped as a category with ${existing.hit_count} data points. sure you want to change it to ${category}? just say yes to confirm.`;
      } else {
        // Apply correction immediately
        await learnMerchantCategory(merchant, category);
        // Count how many entries were updated (entries with this merchant and source='import')
        const updatedRow = await db.prepare(
          `SELECT COUNT(*) AS n FROM finance_entries WHERE LOWER(merchant) = ? AND source = 'import'`
        ).get(merchant.toLowerCase());
        const updatedCount = updatedRow ? (updatedRow.n || 0) : 0;
        replyText = replyText + `\n\nalso saved: ${merchant} → ${category}` +
          (updatedCount > 0 ? ` (updated ${updatedCount} past transaction${updatedCount === 1 ? '' : 's'})` : '');
      }
    }
  } catch (err) {
    console.error('[reasoning] merchant correction detection error:', err.message);
  }

  await saveMessage(chatId, 'assistant', raw);
  return { reply: replyText, tasksChanged, actionResults };
}

async function resetHistory(chatId) {
  await db.prepare(`DELETE FROM chat_history WHERE chat_id = ?`).run(chatId);
}

module.exports = { chat, resetHistory, isConfirmation, pendingSuggestions, detectMerchantCorrection, canonicaliseCategory };
