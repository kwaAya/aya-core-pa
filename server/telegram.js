const { Telegraf } = require('telegraf');
const db = require('./db');
const { chat, resetHistory } = require('./reasoning');

const token = process.env.TELEGRAM_BOT_TOKEN;

let bot = null;

// ─── Identity helpers ─────────────────────────────────────────────────────────
// Every inbound message must resolve to an app user before it can touch any
// data. An unlinked chat gets nothing but the linking instructions.

async function getChatId(userId) {
  if (!userId) return null;
  const u = await db.prepare(`SELECT telegram_chat_id FROM users WHERE id = ?`).get(userId);
  return u?.telegram_chat_id || null;
}

async function userIdForChat(chatId) {
  const u = await db.prepare(`SELECT id FROM users WHERE telegram_chat_id = ?`).get(String(chatId));
  return u?.id || null;
}

// Guard used at the top of every command. Returns the user id, or null after
// having already replied with the linking nudge.
async function requireLinkedUser(ctx) {
  const userId = await userIdForChat(ctx.chat.id);
  if (!userId) {
    await ctx.reply(
      "this chat isn't linked to an account yet.\n\n" +
      'open the web app → Settings → Connect Telegram, and tap the link it gives you.'
    );
    return null;
  }
  return userId;
}

// Conversation history is keyed on the app user, not the Telegram chat, so a
// user's web and Telegram threads stay separate but both stay theirs.
function historyKey(userId) {
  return `tg-${userId}`;
}

// ─── Data helpers (all user-scoped) ───────────────────────────────────────────

async function getOpenTasks(userId) {
  return db.prepare(
    `SELECT * FROM tasks WHERE status = 'open' AND user_id = ?
     ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 ELSE 1 END ASC,
     created_at ASC`
  ).all(userId);
}

function priorityEmoji(p) {
  return p === 'high' ? '🔴' : p === 'low' ? '🟢' : '🟡';
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

async function doneReply(db, title, remainingOpen, userId) {
  const today = new Date().toISOString().slice(0, 10);
  const row = await db.prepare(
    `SELECT COUNT(*) as n FROM tasks WHERE status = 'done' AND last_touched_at LIKE ? AND user_id = ?`
  ).get(`${today}%`, userId);
  const doneToday = row ? row.n : 1;

  if (remainingOpen === 0) {
    return pick([
      `✅ "${title}" done — and that's everything. clear day, go you 👏`,
      `✅ "${title}" — nothing left open. enjoy the clear board.`,
    ]);
  }
  if (doneToday >= 4) {
    return pick([
      `🔥 "${title}" done — that's ${doneToday} today, you're cooking.`,
      `✅ "${title}" — ${doneToday} down today. good pace.`,
    ]);
  }
  return pick([
    `✅ "${title}" marked done`,
    `✅ "${title}" — one more down.`,
  ]);
}

// ─── LLM day summary ──────────────────────────────────────────────────────────

async function askLLM(prompt) {
  const groqKey   = process.env.GROQ_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!groqKey && !geminiKey) return null;

  const SYSTEM = 'You are a no-nonsense personal assistant. You help the user reason through their day based on their task list and finances. Be direct, short, and practical. No fluff.';
  const body   = (model) => JSON.stringify({ model, max_tokens: 500, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }] });

  if (groqKey) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
        body: body('llama-3.3-70b-versatile'),
      });
      const data = await res.json();
      if (data.error) {
        console.warn('[telegram] Groq error, falling back to Gemini:', data.error.message);
      } else {
        return data.choices?.[0]?.message?.content?.trim() || null;
      }
    } catch (err) {
      console.warn('[telegram] Groq call failed, falling back to Gemini:', err.message);
    }
  }

  if (geminiKey) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${geminiKey}` },
          body: body('gemini-3.6-flash'),
        });
        const data = await res.json();
        if (data.error) {
          if (data.error.code === 503 && attempt === 0) { await new Promise(r => setTimeout(r, 800)); continue; }
          console.error('[telegram] Gemini error:', data.error.message || JSON.stringify(data.error));
          return null;
        }
        return data.choices?.[0]?.message?.content?.trim() || null;
      } catch (err) {
        console.error('[telegram] Gemini call failed:', err.message);
        return null;
      }
    }
  }

  return null;
}

// ─── Quota check for Telegram-originated AI calls ─────────────────────────────
// Telegram bypasses Express middleware entirely, so the web-side enforceQuota()
// never sees these. Without this, Telegram is a free unlimited AI endpoint and
// your Groq bill has no ceiling.

async function checkAiQuota(userId) {
  try {
    const { getUserPlan, getUsage, recordUsage } = require('./plan');
    const plan  = await getUserPlan(userId);
    const limit = plan.limits.ai_message;
    if (limit === undefined || limit === Infinity) return { ok: true };

    const used = await getUsage(userId, 'ai_message');
    if (used >= limit) {
      return {
        ok: false,
        message: `you've used all ${limit} AI messages on the ${plan.name} plan this month. upgrade in the web app to keep going.`,
      };
    }
    await recordUsage(userId, 'ai_message');
    return { ok: true };
  } catch (err) {
    console.error('[telegram] quota check failed, allowing:', err.message);
    return { ok: true }; // fail open — never block a paying user on a metering bug
  }
}

// ─── Bot init ─────────────────────────────────────────────────────────────────

let cachedUsername = null;

function normalizeBotUsername(value) {
  return String(value || '').trim().replace(/^@+/, '').replace(/\s+/g, '');
}

// The link-code route needs the bot's own @username to build a t.me deep link.
// Deriving it from the token via getMe() means one less env var to configure —
// and one less way for the link to silently point at a fake "your_bot" handle.
function getBotUsername() {
  const candidates = [
    cachedUsername,
    process.env.TELEGRAM_BOT_USERNAME,
    process.env.TELEGRAM_BOT_NAME,
  ].map(normalizeBotUsername).filter(Boolean);
  return candidates[0] || null;
}

async function ensureBotUsername() {
  const username = getBotUsername();
  if (username) return username;
  if (!bot) return null;

  try {
    const me = await bot.telegram.getMe();
    cachedUsername = normalizeBotUsername(me.username);
    return cachedUsername || null;
  } catch (err) {
    console.warn('[telegram] getMe failed while building deep link:', err.message);
    return getBotUsername();
  }
}

function initBot() {
  if (!token) {
    console.warn('[telegram] TELEGRAM_BOT_TOKEN not set — bot disabled. Reminders will not send.');
    return null;
  }

  bot = new Telegraf(token);

  bot.telegram.getMe().then(me => {
    cachedUsername = normalizeBotUsername(me.username);
    console.log(`[telegram] bot identified as @${cachedUsername}`);
  }).catch(err => {
    console.error('[telegram] getMe failed — falling back to TELEGRAM_BOT_USERNAME env var if set:', err.message);
  });

  // /start <code> — links this chat to the account that generated the code.
  bot.command('start', async (ctx) => {
    const code = ctx.message.text.replace('/start', '').trim();
    const chatId = String(ctx.chat.id);

    const existing = await userIdForChat(chatId);
    if (existing && !code) {
      return ctx.reply("you're already linked 🫡 send /tasks to see what's open.");
    }

    if (!code) {
      return ctx.reply(
        'open the web app → Settings → Connect Telegram. it gives you a one-tap link that pairs this chat with your account.'
      );
    }

    const linked = await db.prepare(
      `SELECT id, name FROM users WHERE telegram_link_code = ?`
    ).get(code);

    if (!linked) {
      return ctx.reply("that link code isn't valid or has already been used. generate a fresh one in the web app.");
    }

    // one chat per account, one account per chat
    await db.prepare(`UPDATE users SET telegram_chat_id = NULL WHERE telegram_chat_id = ?`).run(chatId);
    await db.prepare(
      `UPDATE users SET telegram_chat_id = ?, telegram_link_code = NULL WHERE id = ?`
    ).run(chatId, linked.id);

    ctx.reply(
      `linked${linked.name ? `, ${linked.name.split(' ')[0]}` : ''} 🫡 i'll ping you when reminders hit and when something's been sitting untouched.\n\n` +
      'you can also just talk to me here — reasoning through a decision, random thoughts, whatever. /reset clears the convo.'
    );
  });

  // /tasks — list open tasks
  bot.command('tasks', async (ctx) => {
    const userId = await requireLinkedUser(ctx);
    if (!userId) return;

    const open = await getOpenTasks(userId);
    if (open.length === 0) {
      return ctx.reply('nothing open. actually clean slate, go you 👏');
    }
    const list = open.map((t, i) => `${i + 1}. ${priorityEmoji(t.priority)} ${t.title}`).join('\n');
    ctx.reply(`open tasks:\n${list}`);
  });

  // /add <task title> — quick add from Telegram
  bot.command('add', async (ctx) => {
    const userId = await requireLinkedUser(ctx);
    if (!userId) return;

    const title = ctx.message.text.replace('/add', '').trim();
    if (!title) return ctx.reply('usage: /add buy groceries');

    // respect the plan's open-task ceiling
    try {
      const { getUserPlan } = require('./plan');
      const plan = await getUserPlan(userId);
      const limit = plan.limits.task;
      if (limit !== Infinity) {
        const row = await db.prepare(
          `SELECT COUNT(*) AS n FROM tasks WHERE user_id = ? AND status = 'open'`
        ).get(userId);
        if (Number(row?.n || 0) >= limit) {
          return ctx.reply(`you're at the ${plan.name} plan's ${limit} open-task cap. finish a few, or upgrade in the web app.`);
        }
      }
    } catch (err) {
      console.error('[telegram] task quota check failed:', err.message);
    }

    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO tasks (title, status, priority, stale_minutes, last_touched_at, created_at, user_id)
       VALUES (?, 'open', 'normal', 4320, ?, ?, ?)`
    ).run(title, now, now, userId);
    ctx.reply(`added ✅ "${title}"`);
  });

  // /done <number> — mark task done by list position
  bot.command('done', async (ctx) => {
    const userId = await requireLinkedUser(ctx);
    if (!userId) return;

    const num = parseInt(ctx.message.text.replace('/done', '').trim(), 10);
    if (isNaN(num) || num < 1) {
      return ctx.reply('usage: /done 2  (use the number from /tasks)');
    }
    const open = await getOpenTasks(userId);
    const task = open[num - 1];
    if (!task) {
      return ctx.reply(`no task #${num}. send /tasks to see the current list.`);
    }

    await db.prepare(
      `UPDATE tasks SET status = 'done', last_touched_at = ?, next_ping_at = NULL, ping_count = 0
       WHERE id = ? AND user_id = ?`
    ).run(new Date().toISOString(), task.id, userId);

    const remainingOpen = open.length - 1;

    if (task.recurring) {
      const next = nextRecurringDate(task.recurring);
      const now = new Date().toISOString();
      const staleMins = task.stale_minutes || (task.stale_days || 3) * 1440;
      await db.prepare(
        `INSERT INTO tasks (title, notes, priority, stale_minutes, recurring, remind_at, reminded, last_touched_at, created_at, user_id)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
      ).run(task.title, task.notes, task.priority, staleMins, task.recurring, next, now, now, userId);
      ctx.reply(`✅ "${task.title}" done — recurring task queued for ${next ? next.slice(0, 10) : 'next cycle'}`);
    } else {
      ctx.reply(await doneReply(db, task.title, remainingOpen, userId));
    }
  });

  // /finance — this month's summary
  bot.command('finance', async (ctx) => {
    const userId = await requireLinkedUser(ctx);
    if (!userId) return;

    const month = new Date().toISOString().slice(0, 7);
    const rows = await db.prepare(
      `SELECT type, SUM(amount) as total FROM finance_entries
       WHERE created_at >= ? AND user_id = ? GROUP BY type`
    ).all(`${month}-01`, userId);

    if (rows.length === 0) {
      return ctx.reply('no finance entries this month. log some from the app.');
    }

    const income  = rows.find(r => r.type === 'income')?.total  || 0;
    const expense = rows.find(r => r.type === 'expense')?.total || 0;
    const net = income - expense;

    const cats = await db.prepare(
      `SELECT category, SUM(amount) as total FROM finance_entries
       WHERE type = 'expense' AND created_at >= ? AND user_id = ?
       GROUP BY category ORDER BY total DESC LIMIT 5`
    ).all(`${month}-01`, userId);

    const catLines = cats.map(c => `  ${c.category}: R${c.total.toFixed(2)}`).join('\n');
    const sign = net >= 0 ? '+' : '';

    ctx.reply(
      `💰 ${month} summary\n\nincome:  R${income.toFixed(2)}\nspend:   R${expense.toFixed(2)}\nnet:     ${sign}R${net.toFixed(2)}\n\ntop spend:\n${catLines || '  (none)'}`
    );
  });

  // /day — LLM-powered day reasoning
  bot.command('day', async (ctx) => {
    const userId = await requireLinkedUser(ctx);
    if (!userId) return;

    if (!process.env.GROQ_API_KEY && !process.env.GEMINI_API_KEY) {
      return ctx.reply('no AI key configured on the server right now.');
    }

    const quota = await checkAiQuota(userId);
    if (!quota.ok) return ctx.reply(quota.message);

    await ctx.reply('thinking through your day…');

    const open  = await getOpenTasks(userId);
    const high  = open.filter(t => t.priority === 'high');
    const month = new Date().toISOString().slice(0, 7);

    const finRows = await db.prepare(
      `SELECT type, SUM(amount) as total FROM finance_entries
       WHERE created_at >= ? AND user_id = ? GROUP BY type`
    ).all(`${month}-01`, userId);

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
    ctx.reply(reply || "couldn't reach the model right now. try again in a sec.");
  });

  // /unlink — disconnect this chat
  bot.command('unlink', async (ctx) => {
    const userId = await requireLinkedUser(ctx);
    if (!userId) return;
    await db.prepare(`UPDATE users SET telegram_chat_id = NULL WHERE id = ?`).run(userId);
    ctx.reply('unlinked. no more pings here. re-link any time from the web app.');
  });

  // /reset — clear conversation history
  bot.command('reset', async (ctx) => {
    const userId = await requireLinkedUser(ctx);
    if (!userId) return;
    await resetHistory(historyKey(userId));
    ctx.reply('cleared. fresh start.');
  });

  // free-form messages → reasoning assistant
  bot.on('text', async (ctx) => {
    const text = ctx.message.text || '';
    if (text.startsWith('/')) return;

    const userId = await requireLinkedUser(ctx);
    if (!userId) return;

    const quota = await checkAiQuota(userId);
    if (!quota.ok) return ctx.reply(quota.message);

    ctx.sendChatAction('typing').catch(() => {});
    try {
      const reply = await chat(historyKey(userId), text, userId);
      ctx.reply(reply.reply || reply);
    } catch (err) {
      console.error('[reasoning] failed:', err.message);
      ctx.reply('hit an error thinking that through — try again in a sec.');
    }
  });

  const webhookUrl = process.env.WEBHOOK_URL;
  if (webhookUrl) {
    console.log('[telegram] webhook mode — waiting for setupWebhook(app) call');
  } else {
    process.once('SIGINT',  () => { if (bot) bot.stop('SIGINT'); });
    process.once('SIGTERM', () => { if (bot) bot.stop('SIGTERM'); });
    bot.launch().catch((err) => {
      console.error('[telegram] bot failed to start:', err.message);
      console.warn('[telegram] running without bot — check your token');
      bot = null;
    });
    console.log('[telegram] bot initialising (long-poll)…');
  }

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
// userId is now REQUIRED. A call without one is a bug, and we log it loudly
// rather than quietly broadcasting someone's private task to whoever is linked.

async function sendMessage(text, userId) {
  if (!userId) {
    console.error('[telegram] sendMessage called without userId — refusing to send:', String(text).slice(0, 60));
    return;
  }
  const chatId = await getChatId(userId);
  if (!bot || !chatId) return; // user simply hasn't linked Telegram — not an error

  bot.telegram.sendMessage(chatId, text).catch((err) => {
    console.error('[telegram] send failed for user', userId, '—', err.message);
  });
}

// ─── Webhook setup (called from index.js after server starts) ─────────────────

async function setupWebhook(app) {
  if (!bot || !token) return;
  const webhookUrl = process.env.WEBHOOK_URL;
  if (!webhookUrl) return;

  const hookPath = '/webhook/' + token;
  app.post(hookPath, bot.webhookCallback(hookPath));

  try {
    await bot.telegram.setWebhook(webhookUrl + hookPath);
    console.log('[telegram] webhook set:', webhookUrl + hookPath);
  } catch (err) {
    console.error('[telegram] setWebhook failed:', err.message);
  }
}

module.exports = {
  initBot, setupWebhook, sendMessage, getChatId, userIdForChat, nextRecurringDate, getBotUsername,
};