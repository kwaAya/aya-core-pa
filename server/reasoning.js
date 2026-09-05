const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const fs = require('fs');
const path = require('path');
const db = require('./db');

const GROQ_MODEL = 'groq/compound-mini';

const PROFILE_PATH = path.join(__dirname, 'profile.md');

// simple in-memory conversation history per chat, capped so it doesn't grow unbounded
const history = new Map(); // chatId -> [{role, content}, ...]
const MAX_TURNS = 20;

function loadProfile() {
  try {
    return fs.readFileSync(PROFILE_PATH, 'utf-8');
  } catch {
    return '(no profile set yet — edit server/profile.md)';
  }
}

function loadTaskSnapshot() {
  const open = db.prepare(
    `SELECT title, priority, remind_at, stale_days, recurring, last_touched_at
     FROM tasks WHERE status = 'open'
     ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 ELSE 1 END ASC, created_at ASC`
  ).all();
  if (open.length === 0) return 'No open tasks right now.';
  return open.map(t =>
    `- [${t.priority}] ${t.title}` +
    (t.remind_at ? ` (reminder: ${t.remind_at})` : '') +
    (t.recurring  ? ` [repeats ${t.recurring}]` : '')
  ).join('\n');
}

function loadFinanceSnapshot() {
  const month = new Date().toISOString().slice(0, 7);
  const rows = db.prepare(
    `SELECT type, SUM(amount) as total FROM finance_entries
     WHERE created_at >= ? GROUP BY type`
  ).all(`${month}-01`);
  if (rows.length === 0) return 'No finance entries this month.';
  const income  = rows.find(r => r.type === 'income')?.total  || 0;
  const expense = rows.find(r => r.type === 'expense')?.total || 0;
  return `This month: income R${income.toFixed(2)}, expenses R${expense.toFixed(2)}, net R${(income - expense).toFixed(2)}.`;
}

function buildSystemPrompt() {
  const profile  = loadProfile();
  const tasks    = loadTaskSnapshot();
  const finances = loadFinanceSnapshot();

  return `You are a personal reasoning assistant, built specifically for this one person. You are not a generic chatbot — ground every response in the context below.

<user_profile>
${profile}
</user_profile>

<current_open_tasks>
${tasks}
</current_open_tasks>

<finances_this_month>
${finances}
</finances_this_month>

Guidelines:
- Match the communication style described in the profile. Don't default to generic assistant tone if the profile says otherwise.
- Reason carefully and honestly — push back when something doesn't add up, don't just validate for the sake of being pleasant.
- Match their energy on tone: casual, a little playful, comfortable with internet humor and Gen-Z phrasing where it fits naturally — but when it's an actual deadline, task, or real decision, be clear and straight, don't let the fun get in the way of being useful. Read the room per message.
- You can reference their open tasks or finances naturally if relevant, but don't force it in.
- You are a tool for their thinking, not a substitute for the people in their life — if something sounds like it needs a real person, say so plainly.`;
}

async function chat(chatId, userMessage) {
  if (!history.has(chatId)) history.set(chatId, []);
  const convo = history.get(chatId);

  convo.push({ role: 'user', content: userMessage });
  if (convo.length > MAX_TURNS) convo.splice(0, convo.length - MAX_TURNS);

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY is not set in .env');

  const res = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'system', content: buildSystemPrompt() }, ...convo],
    }),
  });

  if (!res.ok) throw new Error(`Groq API error (${res.status}): ${await res.text()}`);

  const data = await res.json();
  const reply = data.choices?.[0]?.message?.content || '(no response)';
  convo.push({ role: 'assistant', content: reply });
  return reply;
}

function resetHistory(chatId) {
  history.delete(chatId);
}

module.exports = { chat, resetHistory };
