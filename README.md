# Core PA — v1

Capture tasks in a web app, get pinged on Telegram, get nudged if something sits untouched too long.

## What this is right now

- **Web app** (`public/`) — quick-capture interface, PWA-installable (add to home screen).
- **Backend** (`server/`) — Express API + SQLite storage.
- **Telegram bot** — sends reminders and stale-task nudges directly to your DMs.
- **Scheduler** — checks every 5 min for due reminders, once a day (9am) for stale tasks.

This does **not** yet do finance tracking or "reason through your day" — that's intentional, this is v1 (capture + remind only), scoped tight on purpose so it actually gets used before growing.

## Account verification for production

New accounts must verify a six-digit code sent to their email before Core PA
creates a session. This prevents people from registering an account under an
email address they do not control. In Railway, set all of the following before
enabling signups:

- `JWT_SECRET` - at least 32 characters; generate one with the command shown
  in `.env.example`.
- `RESEND_API_KEY` and `EMAIL_FROM` - create a Resend API key and use a sender
  on a verified domain.
- `LEGACY_DATA_OWNER_EMAIL` - the one existing owner allowed to attach
  pre-account rows to their account. This is intentionally not automatic.

In local development, the code is printed only in the server console so the
flow can be tested without sending mail. Production refuses new signup when a
real sender is not configured. Existing accounts are not retroactively locked
out; verification is enforced for new accounts created after this update.

## 1. Create your Telegram bot (5 min, free)

1. Open Telegram, search for **@BotFather**.
2. Send `/newbot`, give it a name (e.g. "Aya Core PA") and a username ending in `bot`.
3. BotFather gives you a token like `123456789:ABCdefGhIJKlmNoPQRsTuVwXyZ`.
4. Copy `.env.example` to `.env` and paste the token in:
   ```
   TELEGRAM_BOT_TOKEN=your_token_here
   ```

## 2. Run it locally to test

```bash
npm install
npm start
```

Open `http://localhost:3000` in your phone browser (same wifi network — use your computer's local IP, not `localhost`, if testing from your phone).

Then in Telegram, open your new bot and send `/start`. That's what links the bot to send *you* specifically. Send `/tasks` any time to get your open list on demand.

## 3. Deploy it somewhere it stays running

Your laptop turning off kills the reminders — this needs to live somewhere always-on. Good free/cheap options:

- **Railway** (railway.app) — easiest, free tier covers this comfortably. Connect your GitHub repo, set the `TELEGRAM_BOT_TOKEN` env var, deploy.
- **Render** (render.com) — similar, free web service tier.
- **Fly.io** — a bit more setup, generous free tier.

All three: push this folder to a GitHub repo, connect it, set the env var in their dashboard, deploy. The SQLite file persists on their disk (Railway/Render both support this on their basic tiers).

## 4. Add to your home screen

Once deployed, open the live URL on your phone → browser share/menu → "Add to Home Screen". It'll behave like a native app icon.

## What's next (v2 ideas, not built yet)

- Finance tracking — will need manual entry or a bank-integration API (limited options for South African banks specifically — this needs its own research pass).
- "Talk through my day" reasoning layer — an LLM API call wired into the Telegram bot, using your task history as context.
- Smarter auto-scheduling instead of manual remind times.

Keep this version running for a week or two first and see what it actually needs before adding more — that's the whole point of shipping it small.
