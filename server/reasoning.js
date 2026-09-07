const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const fs   = require('fs');
const path = require('path');
const db   = require('./db');

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
  const finances = await loadFinanceSnapshot();

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
    await db.prepare(`UPDATE tasks SET status='done', last_touched_at=? WHERE id=?`).run(now, t.id);
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
    await db.prepare(`UPDATE tasks SET remind_at=?, reminded=0, last_touched_at=? WHERE id=?`).run(action.remind_at, now, t.id);
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

// ─── Main chat ────────────────────────────────────────────────────────────────

async function chat(chatId, userMessage) {
  const convo = await loadHistory(chatId);

  convo.push({ role: 'user', content: userMessage });
  await saveMessage(chatId, 'user', userMessage);

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');

  const systemPrompt = await buildSystemPrompt();

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

  const actions      = Array.isArray(parsed.actions) ? parsed.actions : [];
  const reply        = parsed.reply || raw;
  const actionResults = [];
  let   tasksChanged  = false;

  for (const action of actions) {
    const result = await executeAction(action);
    actionResults.push(result);
    if (result.ok) tasksChanged = true;
  }

  await saveMessage(chatId, 'assistant', raw);
  return { reply, tasksChanged, actionResults };
}

async function resetHistory(chatId) {
  await db.prepare(`DELETE FROM chat_history WHERE chat_id = ?`).run(chatId);
}

module.exports = { chat, resetHistory };
