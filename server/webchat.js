const { chat, resetHistory } = require('./reasoning');
const { requireUser } = require('./auth');
const { enforceQuota, rateLimit } = require('./plan');
const db = require('./db');

function registerChatRoutes(app) {
  const hasLLM = () => !!(process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY || process.env.OPENROUTER_API_KEY);

  app.post('/api/chat', requireUser, rateLimit({ max: 20, windowMs: 60_000 }), enforceQuota('ai_message'), async (req, res) => {
    if (!hasLLM()) {
      return res.status(503).json({ error: 'No AI provider configured' });
    }

    const { message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }

    const chatId = `web-${req.userId}`;
    try {
      const result = await chat(chatId, message.trim(), req.userId);
      const reply        = result.reply;
      const tasksChanged = result.tasksChanged || false;
      res.json({ reply, tasksChanged });
    } catch (err) {
      console.error('[web chat] failed:', err.message);
      res.status(500).json({ error: 'failed to get a response' });
    }
  });

  // /day — pre-built day reasoning prompt, same logic as Telegram /day command
  app.post('/api/chat/day', requireUser, rateLimit({ max: 10, windowMs: 60_000 }), enforceQuota('ai_message'), async (req, res) => {
    if (!hasLLM()) {
      return res.status(503).json({ error: 'No AI provider configured' });
    }

    try {
      const open = await db.prepare(
        `SELECT * FROM tasks WHERE status = 'open' AND user_id = ?
         ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 ELSE 1 END ASC, created_at ASC`
      ).all(req.userId);
      const high  = open.filter(t => t.priority === 'high');
      const month = new Date().toISOString().slice(0, 7);
      const finRows = await db.prepare(
        `SELECT type, SUM(amount) as total FROM finance_entries WHERE created_at >= ? AND user_id = ? GROUP BY type`
      ).all(`${month}-01`, req.userId);
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

      const { reply } = await chat(`web-${req.userId}`, prompt, req.userId, { persist: false });
      res.json({ reply });
    } catch (err) {
      console.error('[web chat /day] failed:', err.message);
      res.status(500).json({ error: 'failed to get a response' });
    }
  });

  app.post('/api/chat/reset', requireUser, async (req, res) => {
    try {
      await resetHistory(`web-${req.userId}`);
      res.status(204).end();
    } catch (err) {
      console.error('[web chat reset] failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerChatRoutes };
