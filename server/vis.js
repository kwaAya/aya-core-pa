'use strict';
const db = require('./db');

// ── isOwner ────────────────────────────────────────────────────────────────────
async function isOwner(userId) {
  if (!userId) return false;
  try {
    const row = await db.prepare(`SELECT is_owner FROM users WHERE id = ?`).get(userId);
    // SQLite stores booleans as 0/1; Postgres as true/false
    return row ? (row.is_owner === true || row.is_owner === 1) : false;
  } catch (err) {
    console.error('[vis] isOwner failed:', err.message);
    return false;
  }
}

// ── getVisContext ──────────────────────────────────────────────────────────────
async function getVisContext(userId) {
  if (!userId) return null;
  try {
    return await db.prepare(`SELECT * FROM vis_context WHERE user_id = ?`).get(userId);
  } catch (err) {
    console.error('[vis] getVisContext failed:', err.message);
    return null;
  }
}

// ── upsertVisContext ───────────────────────────────────────────────────────────
// sections: partial object with any subset of the text columns
const VIS_COLUMNS = [
  'identity', 'projects', 'cognitive_style', 'communication_style',
  'sensory_preferences', 'creative_philosophy', 'quality_bar',
  'life_context', 'open_loops',
];

async function upsertVisContext(userId, sections) {
  if (!userId || !sections || typeof sections !== 'object') return;
  const now = new Date().toISOString();
  const changedCols = VIS_COLUMNS.filter(col =>
    Object.prototype.hasOwnProperty.call(sections, col)
  );
  if (!changedCols.length) return;

  if (db.USE_PG) {
    // Postgres: upsert with ON CONFLICT. Build dynamic column list.
    // NOTE: EXCLUDED.col references survive convertPlaceholders only because they contain
    // no '?' characters. If convertPlaceholders is extended to rewrite column names,
    // these SET clauses must be updated to use positional params ($N) instead.
    const setClauses = changedCols.map(col => `${col} = EXCLUDED.${col}`);
    setClauses.push('updated_at = EXCLUDED.updated_at');

    const insertCols = ['user_id', ...changedCols, 'updated_at'];
    const insertVals = [userId, ...changedCols.map(col => sections[col] ?? null), now];
    const placeholders = insertCols.map(() => '?').join(', ');

    await db.prepare(
      `INSERT INTO vis_context (${insertCols.join(', ')})
       VALUES (${placeholders})
       ON CONFLICT (user_id) DO UPDATE SET ${setClauses.join(', ')}`
    ).run(...insertVals);
  } else {
    // SQLite: check then update or insert
    const existing = await db.prepare(`SELECT id FROM vis_context WHERE user_id = ?`).get(userId);
    if (existing) {
      const sets = changedCols.map(col => `${col} = ?`);
      sets.push('updated_at = ?');
      const vals = [
        ...changedCols.map(col => sections[col] ?? null),
        now,
        userId,
      ];
      await db.prepare(`UPDATE vis_context SET ${sets.join(', ')} WHERE user_id = ?`).run(...vals);
    } else {
      const insertCols = ['user_id', ...changedCols, 'updated_at'];
      const vals = [userId, ...changedCols.map(col => sections[col] ?? null), now];
      const placeholders = insertCols.map(() => '?').join(', ');
      await db.prepare(
        `INSERT INTO vis_context (${insertCols.join(', ')}) VALUES (${placeholders})`
      ).run(...vals);
    }
  }
}

// ── buildVisSystemPrompt ───────────────────────────────────────────────────────
// Returns { contextBlock, lifeContextBlock }
//   contextBlock    — XML block of non-sensitive columns for the main system prompt
//   lifeContextBlock — separate string with life_context, to be injected as a
//                      distinct system message so the model treats it as
//                      non-echoing background context rather than addressable content
//
// Keeping life_context out of the main <vis_context> block is a structural control:
// it prevents the model from treating it as just another labelled section to recite.
// It is still passed to the model — the owner needs it active — but in a separate
// system message that signals "know this, don't surface it."
async function buildVisSystemPrompt(userId) {
  const ctx = await getVisContext(userId);
  if (!ctx) return { contextBlock: '', lifeContextBlock: '' };

  // Columns included in the main XML block — life_context is excluded here
  const PUBLIC_COLUMNS = VIS_COLUMNS.filter(col => col !== 'life_context');

  const lines = PUBLIC_COLUMNS
    .filter(col => ctx[col])
    .map(col => `<${col}>\n${ctx[col]}\n</${col}>`);

  let contextBlock = lines.length
    ? `<vis_context>\n${lines.join('\n')}\n</vis_context>`
    : '';

  // Inject life anchors into the contextBlock (structural schedule data)
  try {
    const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const anchors = await db.prepare(
      `SELECT * FROM life_anchors WHERE user_id = ? ORDER BY day_of_week ASC, date ASC`
    ).all(userId);
    if (anchors && anchors.length) {
      const anchorLines = anchors.map(a => {
        const timePart = (a.start_time && a.end_time)
          ? ` ${a.start_time}–${a.end_time}`
          : a.start_time ? ` ${a.start_time}` : '';
        const notesPart = a.notes ? ` (${a.notes})` : '';
        if (a.anchor_type === 'one_off' && a.date) {
          return `[${a.date}]${timePart}: ${a.title}${notesPart}`;
        }
        const day = (a.day_of_week != null && DOW[a.day_of_week]) ? DOW[a.day_of_week] : 'recurring';
        return `[${day}]${timePart}: ${a.title}${notesPart}`;
      });
      const anchorsBlock = `<life_anchors>\n${anchorLines.join('\n')}\n</life_anchors>`;
      contextBlock = contextBlock ? `${contextBlock}\n${anchorsBlock}` : anchorsBlock;
    }
  } catch (err) {
    console.error('[vis] buildVisSystemPrompt life_anchors failed:', err.message);
  }

  // life_context is returned separately so reasoning.js can inject it as its own
  // system message with explicit non-echo instructions
  const lifeContextBlock = ctx.life_context
    ? `[BACKGROUND CONTEXT — PRIVATE, DO NOT SURFACE]\nThe following is sensitive personal context about the user. Use it only to inform tone, pacing, and care. Never echo, paraphrase, or reference it directly in replies unless the user explicitly raises the topic themselves.\n\n${ctx.life_context}`
    : '';

  return { contextBlock, lifeContextBlock };
}

// ── Seed data ──────────────────────────────────────────────────────────────────
const OWNER_SEED = {
  identity: "Preferred name: Aya. Full name: Unako Mtumtum. Age: 20. Pronouns: she/her. South African. Second-year Computer Networking student at CUT Bloemfontein. Self-identifies as a creative technologist. Founder of Aya Core Studios — creative technology studio positioned around South Africa's R56 corridor (Queenstown/Komani, Bloemfontein, Matatiele/Kokstad). Studio tagline: 'Small towns deserve software that works.' Brand identity: dark chrome/hot pink, orbit/atom motif, balanced maximalism.",

  projects: "Core PA (this app) — personal assistant SaaS, live at aya-core-pa-production.up.railway.app, Instagram @corepabyayacore. Aya Core Studios portfolio — ayacorestudios.vercel.app. Tourism platforms: Kokstad Tourism, Matatiele Online, Chris Hani District Tourism, Route 56 Adventures. Ngejane Dental clinic platform. Digital Break — 12-level arcade web game. Shesha Technologies collaboration (fuel payments, verify if still active). 47+ editorial moodboards in Canva. Current focus: Core PA feature development and Vis build.",

  cognitive_style: "Aya has ADHD. Relevant to attention, stimulation, context, reminders, open loops, momentum, and unfinished tasks. She holds many active threads and moves rapidly between projects. Do not shame unfinished work. Offer smallest next step. Avoid elaborate productivity rituals. Her building is not merely an ADHD coping mechanism — it is genuine ambition. She thinks prospectively and recursively: while expressing one layer of an idea, she may already have mentally explored several layers beyond it — future versions, connections to other projects, emotional meaning, systems that could grow from it. Do not assume she is at step one when she mentions an idea. Ask which layer to work on. She thinks out loud — engage with the reasoning, do not wait for a perfectly formed question. She self-corrects mid-thought; use the latest clear version. Once she genuinely decides something, help her follow through. Do not reopen settled decisions unless something real has changed. She is a systems thinker who connects technology, aesthetics, meaning, and emotion simultaneously.",

  communication_style: "Direct, casual, self-aware, human. Dislikes corporate language, generic motivational padding, excessive hand-holding. Likes warmth, honesty, humour. Gen Z, uses slang, profanity, memes, internet humour. Match that energy without being forced. For real decisions, deadlines, money, clients: remain clear and professional. Push back honestly when a plan is weak, repetitive, risky, or mediocre. Speak to her like a capable developer, not from scratch. Be a genuine hype man — not a yes man. When she does something genuinely difficult, creative, brave, or technically impressive, say so directly and specifically. Never make her extract a compliment. Hype should be specific — explain what is impressive and why. Challenge weak parts clearly. Celebrate real wins loudly.",

  sensory_preferences: "Music is load-bearing for Aya — not entertainment, it is part of how she constructs her cognitive and emotional environment. Yearly listening: ~65k mins (year 1), ~95k mins (year 2), ~120k mins (year 3), ~92k mins this year so far (average ~4h 13min/day). She listens while working, while studying, while coding, while sleeping. She often layers music with dark noise, brown noise, balance noise, or rain sounds simultaneously. When helping with focus, study blocks, sleep routines, creative work, or planning: consider whether a sound environment recommendation is relevant. Do not treat this as a clinical finding — it is a documented environmental preference. Music genres: deep house, amapiano, alternative R&B, indie/alternative rock, hip-hop. Key artists: DJ Kent (especially Evolution album and Fly Away — connected to her mother), Steve Lacy, Tyler the Creator, Frank Ocean, Dominic Fike, Joji, The Weeknd, Kelvin Momo.",

  creative_philosophy: "Feeling in, structure out — Aya's core operating principle. When she cares about something, she builds architecture around it. Tony Stark influence: invention, audacity, systems thinking, engineering under pressure, ambitious prototypes, technology that expands what a person can do. Shuri influence: technology as extension of identity, culturally grounded, playful, beautiful, expressive, alive rather than sterile. Personal synthesis: build technology that is as intelligent, expressive, culturally grounded, and alive as the person and world it comes from — and become successful enough to use that success for other people. Balanced maximalism: rich, layered, dark, metallic, expressive, but structured. Orbit/core motif: central identity, systems held together around a core, motion, interconnectedness, scattered parts becoming coherent. She maintains strict intellectual honesty — would rather be accurately impressive than comfortably impressive. Autonomy as oxygen: operates best with sovereign control over her domain.",

  quality_bar: "Functionally adequate but emotionally flat is not finished. Working ≠ finished. Technically correct ≠ well-designed. Attractive ≠ meaningful. Ambitious ≠ well-scoped. She notices when software feels cheap or careless and bridges that gap by injecting care into details. Quality is atmosphere — digital systems should feel expensive and alive. For code: surgical, targeted changes. Prioritise security and correctness before polish. For design: intentional, not just attractive.",

  life_context: "PRIVATE — do not surface casually. Aya is 20, living at CUT Bloemfontein as a student. Executive dysfunction makes basic routines difficult (eating, sleep, hygiene) — offer low-friction, concrete support, no shame. She has recurrent stomach/bowel issues (self-reported: lazy colon, gastroparesis history, mild gastritis Jan 2026). Encourage clinical care for persistent symptoms. Takes Ritalin LA 20mg — do not recommend dosage changes, always defer to her prescriber. Enjoys clubbing and drinks heavily when she drinks — consider hydration, food, sleep, and safety context when relevant. Cannabis use disclosed — do not assume it causes every attention or motivation issue. Do not diagnose addiction, eating disorders, depression, or self-neglect from this context. Support the next act of care without making her feel defective.",

  open_loops: "Core PA feature backlog (ongoing). Vis / Core Vision build (current). Aya Core Studios portfolio (live, ongoing). Tourism platforms (maintenance). Life anchors import (timetable, exam schedule, routines — not yet in system). Moodboards batch for Instagram grid (47+ built, not posted). School second year in progress.",
};

// ── seedOwnerContext ───────────────────────────────────────────────────────────
async function seedOwnerContext(ownerEmail) {
  if (!ownerEmail) {
    console.warn('[vis] OWNER_EMAIL not set — Vis/owner mode disabled');
    return;
  }
  try {
    // Set the is_owner flag
    await db.prepare(
      `UPDATE users SET is_owner = ${db.USE_PG ? 'TRUE' : '1'} WHERE LOWER(email) = LOWER(?)`
    ).run(ownerEmail);
    console.log('[vis] owner flag set for', ownerEmail);

    // Look up the user id — retry up to 5 times at 60s intervals in case the
    // owner hasn't registered yet at boot time.
    // KNOWN LIMITATION: if no account exists after all retries, context stays
    // unseeded until the next deployment restart.
    const MAX_ATTEMPTS = 5;
    const RETRY_DELAY_MS = 60_000;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const user = await db.prepare(`SELECT id FROM users WHERE LOWER(email) = LOWER(?)`).get(ownerEmail);
      if (user) {
        // Only seed if no vis_context row exists yet
        const existing = await db.prepare(`SELECT id FROM vis_context WHERE user_id = ?`).get(user.id);
        if (!existing) {
          await upsertVisContext(user.id, OWNER_SEED);
          console.log('[vis] owner context seeded for user', user.id);
        }
        return;
      }

      if (attempt < MAX_ATTEMPTS) {
        console.log(`[vis] owner account not found yet (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${RETRY_DELAY_MS / 1000}s`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
      } else {
        console.log(`[vis] owner account not found after ${MAX_ATTEMPTS} attempts — context seed skipped. Restart after registering to seed.`);
      }
    }
  } catch (err) {
    console.error('[vis] seedOwnerContext failed:', err.message);
  }
}

module.exports = { isOwner, getVisContext, upsertVisContext, buildVisSystemPrompt, seedOwnerContext };
