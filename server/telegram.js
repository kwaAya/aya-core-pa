const { Telegraf } = require('telegraf');
const db = require('./db');
const { chat, resetHistory } = require('./reasoning');

const token = process.env.TELEGRAM_BOT_TOKEN;
const groqKey = process.env.GROQ_API_KEY;

let bot = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getChatId() {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'chat_id'`).get();
  return row ? row.value : null;
}

function getOpenTasks() {
  return db.prepare(
    `SELECT * FROM tasks WHERE status = 'open'
     ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 ELSE 1 END ASC,
     created_at ASC`
  ).all();
}

function priorityEmoji(p) {
  return p === 'high' ? '🔴' : p === 'low' ? '🟢' : '🟡';
}

// ─── LLM day summary ──────────────────────────────────────────────────────────

async function askLLM(prompt) {
  if (!groqKey) return null;
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqKey}`,
      },
      body: JSON.stringify({
        model: 'groq/compound-mini',
        messages: [
          {
            role: 'system',
            content:
              "You are a no-nonsense personal assistant. You help the user reason through their day based on their task list and finances. Be direct, short, and practical. No fluff.",
          },
          { role: 'user', content: prompt },
        ],
        max_tokens: 500,
      }),
    });
    const data = await res.json();
    if (data.error) {
      console.error('[telegram] OpenAI error:', data.error.message);
      return null;
    }
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.error('[telegram] LLM call failed:', err.message);
    return null;
  }
}

// ─── Bot init ─────────────────────────────────────────────────────────────────

function initBot() {
  if (!token) {
    console.warn('[telegram] TELEGRAM_BOT_TOKEN not set — bot disabled. Reminders will not send.');
    return null;
  }

  bot = new Telegraf(token);

  // /start — link chat ID
  bot.command('start', (ctx) => {
    const chatId = String(ctx.chat.id);
    db.prepare(
      `INSERT INTO settings (key, value) VALUES ('chat_id', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(chatId);
    ctx.reply(
      "yo, i'm your PA, officially linked now 🫡 i'll ping you when reminders hit and if something's just been sitting there untouched. add tasks from the web app whenever.\n\nyou can also just talk to me directly right here about anything — reasoning through a decision, random thoughts, whatever. send /reset if you want a clean slate on the convo."
    );
  });

  // /tasks — list open tasks
  bot.command('tasks', (ctx) => {
    const open = getOpenTasks();
    if (open.length === 0) {
      ctx.reply('nothing open. actually clean slate, go you 👏');
      return;
    }
    const list = open.map((t, i) => `${i + 1}. ${priorityEmoji(t.priority)} ${t.title}`).join('\n');
    ctx.reply(`open tasks:\n${list}`);
  });

  // /add <task title> — quick add from Telegram
  bot.command('add', (ctx) => {
    const title = ctx.message.text.replace('/add', '').trim();
    if (!title) {
      ctx.reply('usage: /add buy groceries');
      return;
    }
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO tasks (title, status, priority, stale_days, last_touched_at, created_at)
       VALUES (?, 'open', 'normal', 3, ?, ?)`
    ).run(title, now, now);
    ctx.reply(`added ✅ "${title}"`);
  });

  // /done <number> — mark task done by list position
  bot.command('done', async (ctx) => {
    const num = parseInt(ctx.message.text.replace('/done', '').trim(), 10);
    if (isNaN(num) || num < 1) {
      ctx.reply('usage: /done 2  (use the number from /tasks)');
      return;
    }
    const open = getOpenTasks();
    const task = open[num - 1];
    if (!task) {
      ctx.reply(`no task #${num}. send /tasks to see the current list.`);
      return;
    }

    db.prepare(`UPDATE tasks SET status = 'done', last_touched_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), task.id);

    // if recurring, immediately reopen with reset reminder
    if (task.recurring) {
      const next = nextRecurringDate(task.recurring);
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO tasks (title, notes, priority, stale_days, recurring, remind_at, reminded, last_touched_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
      ).run(task.title, task.notes, task.priority, task.stale_days, task.recurring, next, now, now);
      ctx.reply(`✅ "${task.title}" done — recurring task queued for ${next ? next.slice(0, 10) : 'next cycle'}`);
    } else {
      ctx.reply(`✅ "${task.title}" marked done`);
    }
  });

  // /finance — this month's summary
  bot.command('finance', (ctx) => {
    const month = new Date().toISOString().slice(0, 7); // YYYY-MM
    const rows = db.prepare(
      `SELECT type, SUM(amount) as total FROM finance_entries
       WHERE created_at >= ? GROUP BY type`
    ).all(`${month}-01`);

    if (rows.length === 0) {
      ctx.reply("no finance entries this month. log some from the app.");
      return;
    }

    const income  = rows.find(r => r.type === 'income')?.total  || 0;
    const expense = rows.find(r => r.type === 'expense')?.total || 0;
    const net = income - expense;

    const cats = db.prepare(
      `SELECT category, SUM(amount) as total FROM finance_entries
       WHERE type = 'expense' AND created_at >= ?
       GROUP BY category ORDER BY total DESC LIMIT 5`
    ).all(`${month}-01`);

    const catLines = cats.map(c => `  ${c.category}: R${c.total.toFixed(2)}`).join('\n');
    const sign = net >= 0 ? '+' : '';

    ctx.reply(
      `💰 ${month} summary\n\nincome:  R${income.toFixed(2)}\nspend:   R${expense.toFixed(2)}\nnet:     ${sign}R${net.toFixed(2)}\n\ntop spend:\n${catLines || '  (none)'}`
    );
  });

  // /day — LLM-powered day reasoning
  bot.command('day', async (ctx) => {
    if (!groqKey) {
      ctx.reply("i need a Groq API key to do this. add GROQ_API_KEY to your .env");
      return;
    }

    await ctx.reply('thinking through your day…');

    const open  = getOpenTasks();
    const high  = open.filter(t => t.priority === 'high');
    const month = new Date().toISOString().slice(0, 7);

    const finRows = db.prepare(
      `SELECT type, SUM(amount) as total FROM finance_entries
       WHERE created_at >= ? GROUP BY type`
    ).all(`${month}-01`);

    const income  = finRows.find(r => r.type === 'income')?.total  || 0;
    const expense = finRows.find(r => r.type === 'expense')?.total || 0;

    const taskList = open.length
      ? open.map((t, i) => `${i + 1}. [${t.priority}] ${t.title}${t.notes ? ` (${t.notes})` : ''}`).join('\n')
      : 'none';

    const prompt = `Today is ${new Date().toDateString()}.

My open tasks (sorted by priority):
${taskList}

This month's finances: income R${income.toFixed(2)}, expenses R${expense.toFixed(2)}, net R${(income - expense).toFixed(2)}.

${high.length > 0 ? `High priority tasks: ${high.map(t => t.title).join(', ')}.` : ''}

Help me think through my day. What should I focus on first and why? Any patterns or risks you see? Keep it tight — max 4 short paragraphs.`;

    const reply = await askLLM(prompt);
    ctx.reply(reply || "couldn't reach Groq right now. try again in a sec.");
  });

  // /reset — clear conversation history
  bot.command('reset', (ctx) => {
    resetHistory(ctx.chat.id);
    ctx.reply('cleared. fresh start.');
  });

  // free-form messages → Claude reasoning
  bot.on('text', async (ctx) => {
    const text = ctx.message.text || '';
    if (text.startsWith('/')) return; // already handled by commands above

    ctx.sendChatAction('typing').catch(() => {});
    try {
      const reply = await chat(ctx.chat.id, text);
      ctx.reply(reply);
    } catch (err) {
      console.error('[reasoning] failed:', err.message);
      ctx.reply("hit an error thinking that through — try again in a sec.");
    }
  });

  // graceful shutdown
  process.once('SIGINT',  () => { if (bot) bot.stop('SIGINT'); });
process.once('SIGTERM', () => { if (bot) bot.stop('SIGTERM'); });

  bot.launch().catch((err) => {
    console.error('[telegram] bot failed to start:', err.message);
    console.warn('[telegram] running without bot — check your token');
    bot = null;
  });

  console.log('[telegram] bot initialising…');
  return bot;
}

// ─── Recurring date helper ────────────────────────────────────────────────────

function nextRecurringDate(recurring) {
  const d = new Date();
  if (recurring === 'daily')   d.setDate(d.getDate() + 1);
  if (recurring === 'weekly')  d.setDate(d.getDate() + 7);
  if (recurring === 'monthly') d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}

// ─── Send helper (used by scheduler) ─────────────────────────────────────────

function sendMessage(text) {
  const chatId = getChatId();
  if (!bot || !chatId) {
    console.warn('[telegram] cannot send — bot not ready or /start not sent yet');
    return;
  }
  bot.telegram.sendMessage(chatId, text).catch((err) => {
    console.error('[telegram] send failed:', err.message);
  });
}

module.exports = { initBot, sendMessage, getChatId, nextRecurringDate };
