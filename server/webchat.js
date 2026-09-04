const { chat, resetHistory } = require('./reasoning');

// Web app uses a fixed pseudo chat-id so its conversation thread
// is separate from whatever's happening in Telegram DMs.
const WEB_CHAT_ID = 'web-app';

function registerChatRoutes(app) {
  app.post('/api/chat', async (req, res) => {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set' });
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

  app.post('/api/chat/reset', (req, res) => {
    resetHistory(WEB_CHAT_ID);
    res.status(204).end();
  });
}

module.exports = { registerChatRoutes };
