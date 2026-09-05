const { chat, resetHistory } = require('./reasoning');
const db = require('./db');

// Web app uses a fixed pseudo chat-id so its conversation thread
// is separate from whatever's happening in Telegram DMs.
const WEB_CHAT_ID = 'web-app';

function registerChatRoutes(app) {
  app.post('/api/chat', async (req, res) => {
    if (!process.env.GROQ_API_KEY) {
      return res.status(503).json({ error: 'GROQ_API_KEY not set' });
    }

    const { message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }

    try {
      const reply = await chat(WEB_CHAT_ID, message.trim());
      res.json({ reply });
    } catch (err) {
      console.error('[web chat] failed:', err.message);
      res.status(500).json({ error: 'failed to get a response' });
    }
  });

  // /day — pre-built day reasoning prompt, same logic as Telegram /day command
  app.post('/api/chat/day', async (req, res) => {
    if (!process.env.GROQ_API_KEY) {
      return res.status(503).json({ error: 'GROQ_API_KEY not set' });
    }

    const open  = db.prepare(
      `SELECT * FROM tasks WHERE status = 'open'
       ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 ELSE 1 END ASC, created_at ASC`
    ).all();
    const high  = open.filter(t => t.priority === 'high');
    const month = new Date().toISOString().slice(0, 7);
    const finRows = db.prepare(
      `SELECT type, SUM(amount) as total FROM finance_entries WHERE created_at >= ? GROUP BY type`
    ).all(`${month}-01`);
    const income  = finRows.find(r => r.type === 'income')?.total  || 0;
    const expense = finRows.find(r => r.type === 'expense')?.total || 0;

    const taskList = open.length
      ? open.map((t, i) => `${i + 1}. [${t.priority}] ${t.title}${t.notes ? ` — ${t.notes}` : ''}`).join('\n')
      : 'none';

    const prompt = `Today is ${new Date().toDateString()}.

My open tasks (sorted by priority):
${taskList}

This month's finances: income R${income.toFixed(2)}, expenses R${expense.toFixed(2)}, net R${(income - expense).toFixed(2)}.

${high.length > 0 ? `High priority right now: ${high.map(t => t.title).join(', ')}.` : ''}

Help me think through my day. What should I focus on first and why? Any patterns or risks you see? Keep it tight — max 4 short paragraphs.`;

    try {
      const reply = await chat(WEB_CHAT_ID, prompt);
      res.json({ reply });
    } catch (err) {
      console.error('[web chat /day] failed:', err.message);
      res.status(500).json({ error: 'failed to get a response' });
    }
  });

  app.post('/api/chat/reset', (req, res) => {
    resetHistory(WEB_CHAT_ID);
    res.status(204).end();
  });
}

module.exports = { registerChatRoutes };
