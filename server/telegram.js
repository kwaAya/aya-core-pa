const TelegramBotLib = require('node-telegram-bot-api');
const TelegramBot = TelegramBotLib.default || TelegramBotLib;
const db = require('./db');

const token = process.env.TELEGRAM_BOT_TOKEN;

let bot = null;

function initBot() {
  if (!token) {
    console.warn('[telegram] TELEGRAM_BOT_TOKEN not set — bot disabled. Reminders will not send.');
    return null;
  }

  bot = new TelegramBot(token, { polling: true });

  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    db.prepare(
      `INSERT INTO settings (key, value) VALUES ('chat_id', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(String(chatId));

    bot.sendMessage(
      chatId,
      "hey, i'm your PA. i'm wired up to your task list now — i'll ping you here for reminders and if something's been sitting untouched too long. add tasks from the web app."
    );
  });

  bot.onText(/\/tasks/, (msg) => {
    const chatId = msg.chat.id;
    const openTasks = db.prepare(`SELECT title FROM tasks WHERE status = 'open' ORDER BY created_at ASC`).all();
    if (openTasks.length === 0) {
      bot.sendMessage(chatId, "nothing open right now. clean slate.");
      return;
    }
    const list = openTasks.map((t, i) => `${i + 1}. ${t.title}`).join('\n');
    bot.sendMessage(chatId, `open tasks:\n${list}`);
  });

  console.log('[telegram] bot polling started');
  return bot;
}

function getChatId() {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'chat_id'`).get();
  return row ? row.value : null;
}

function sendMessage(text) {
  const chatId = getChatId();
  if (!bot || !chatId) {
    console.warn('[telegram] cannot send — bot not initialised or chat_id not set yet (send /start to the bot first)');
    return;
  }
  bot.sendMessage(chatId, text).catch((err) => {
    console.error('[telegram] send failed:', err.message);
  });
}

module.exports = { initBot, sendMessage, getChatId };
