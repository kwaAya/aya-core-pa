/**
 * ai-providers.js
 * Shared LLM provider fallback (Groq → Gemini → OpenRouter) used by both
 * reasoning.js (chat) and finance-import.js (statement categorisation), so
 * retry/fallback behaviour can't quietly drift apart between the two.
 */

const GROQ_API_URL       = 'https://api.groq.com/openai/v1/chat/completions';
const GEMINI_API_URL     = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

const GROQ_MODEL       = 'llama-3.3-70b-versatile';
const GEMINI_MODEL     = 'gemini-3.6-flash';
const OPENROUTER_MODEL = 'openai/gpt-4o-mini';

function getProviderPlan(env = process.env) {
  const providers = [];

  if (env.GROQ_API_KEY) {
    providers.push({
      name: 'groq',
      apiKey: env.GROQ_API_KEY,
      url: GROQ_API_URL,
      model: env.GROQ_MODEL || GROQ_MODEL,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.GROQ_API_KEY}` },
      retries: 1,
      retryDelayMs: 500,
    });
  }

  if (env.GEMINI_API_KEY) {
    providers.push({
      name: 'gemini',
      apiKey: env.GEMINI_API_KEY,
      url: GEMINI_API_URL,
      model: env.GEMINI_MODEL || GEMINI_MODEL,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.GEMINI_API_KEY}` },
      retries: 2,
      retryDelayMs: 800,
      retryOnStatus: [503],
    });
  }

  if (env.OPENROUTER_API_KEY) {
    providers.push({
      name: 'openrouter',
      apiKey: env.OPENROUTER_API_KEY,
      url: OPENROUTER_API_URL,
      model: env.OPENROUTER_MODEL || OPENROUTER_MODEL,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': env.APP_URL || 'https://corepa.app',
        'X-Title': env.APP_NAME || 'Core PA',
      },
      retries: 1,
      retryDelayMs: 500,
    });
  }

  return providers;
}

async function fetchWithProviderFallback(provider, messages, maxTokens = 2048) {
  let lastError;

  for (let attempt = 0; attempt <= (provider.retries ?? 0); attempt++) {
    try {
      const res = await fetch(provider.url, {
        method: 'POST',
        headers: provider.headers,
        body: JSON.stringify({
          model: provider.model,
          max_tokens: maxTokens,
          messages,
        }),
      });

      if (res.ok) return res;

      const status = res.status;
      const shouldRetry = (provider.retryOnStatus || []).includes(status) && attempt < (provider.retries ?? 0);
      if (!shouldRetry) {
        const text = await res.text();
        throw new Error(`${provider.name.toUpperCase()} API error (${status}): ${text}`);
      }

      await new Promise(r => setTimeout(r, provider.retryDelayMs || 500));
    } catch (err) {
      lastError = err;
      if (attempt >= (provider.retries ?? 0)) throw err;
      await new Promise(r => setTimeout(r, provider.retryDelayMs || 500));
    }
  }

  throw lastError || new Error(`${provider.name} request failed`);
}

function canonicaliseCategory(raw) {
  const map = {
    groceries: 'food', eats: 'food', eating: 'food',
    ride: 'transport', rides: 'transport', bolt: 'transport', uber: 'transport',
    subscription: 'bills', subscriptions: 'bills', phone: 'bills',
    salary: 'income', payment: 'income',
    shopping: 'general',
  };
  const lower = String(raw).trim().toLowerCase();
  return map[lower] || lower;
}

// Logged once at boot so "is AI even configured" is answered without
// digging through env vars or waiting for a failed import to find out.
function logProviderStatus(env = process.env) {
  const providers = getProviderPlan(env);
  if (!providers.length) {
    console.warn('[ai-providers] NO provider API keys set — chat and statement categorisation will not run.');
    return;
  }
  console.log(`[ai-providers] configured: ${providers.map(p => p.name).join(' → ')} (fallback order)`);
}

module.exports = {
  getProviderPlan,
  fetchWithProviderFallback,
  canonicaliseCategory,
  logProviderStatus,
};
