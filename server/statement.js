'use strict';
// ─── PDF bank statements ─────────────────────────────────────────────────────
// Reads the TEXT layer of a bank-generated PDF (what FNB's app / online banking / email gives you).
// Nothing is sent to an AI or any outside service to read the PDF: it is parsed on the server,
// the file is deleted straight afterwards, and only categorisation (existing pipeline) follows.
//
// The one trick that makes this reliable: every statement line carries a running BALANCE, so we
// decide income vs expense from how the balance moved — not from guessing at "Cr"/"Dr" markers.
// Scanned/photographed PDFs have no text layer and are rejected with a clear message.

const fs = require('fs');

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_RE = '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*';
const MONEY_RE = '-?\\d{1,3}(?:,\\d{3})+\\.\\d{2}|-?\\d+\\.\\d{2}';
const MONEY_TOKEN = new RegExp(`(?:${MONEY_RE})(?:\\s?(?:Cr|Dr|CR|DR))?`, 'g');

const pad = n => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

// ── 1. text items → visual lines (pure; takes pdf.js-style items) ────────────
function itemsToLines(items) {
  const rows = [];
  for (const it of items) {
    if (!it || typeof it.str !== 'string' || !it.str.trim()) continue;
    const x = it.transform[4], y = it.transform[5], w = it.width || 0;
    let row = rows.find(r => Math.abs(r.y - y) <= 2.5);
    if (!row) { row = { y, parts: [] }; rows.push(row); }
    row.parts.push({ x, w, s: it.str });
  }
  rows.sort((a, b) => b.y - a.y);                                       // top of page first
  return rows.map(r => {
    r.parts.sort((a, b) => a.x - b.x);
    let out = '', end = null;
    for (const p of r.parts) {
      if (end !== null) { const gap = p.x - end; out += gap > 12 ? '   ' : gap > 1.2 ? ' ' : ''; }
      out += p.s; end = p.x + p.w;
    }
    return out.replace(/\s+$/, '');
  });
}

async function extractPdfLines(filePath) {
  let pdfParse;
  try { pdfParse = require('pdf-parse/lib/pdf-parse.js'); }             // direct path avoids pdf-parse's debug-mode self-test
  catch { throw new Error('PDF support is not installed on the server (run: npm install pdf-parse@1.1.1)'); }
  const buf = fs.readFileSync(filePath);
  const pages = [];
  try {
    await pdfParse(buf, {
      max: 60,
      pagerender: pageData => pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false })
        .then(tc => { const lines = itemsToLines(tc.items); pages.push(lines); return lines.join('\n'); }),
    });
  } catch (err) {
    if (err && (err.name === 'PasswordException' || /password/i.test(err.message || ''))) {
      throw new Error('This PDF is password-protected. Open it, save an unlocked copy (or download a fresh one from FNB online banking), and try again.');
    }
    throw new Error("Couldn't read that PDF. Download the statement again from your bank's app or online banking and retry.");
  }
  const lines = pages.flat();
  if (lines.join('').replace(/\s/g, '').length < 80) {
    throw new Error('This PDF has no readable text (it looks like a scan or photo). Download the statement directly from your bank instead of scanning it.');
  }
  return lines;
}

// ── 2. lines → transactions (pure; unit tested) ──────────────────────────────
function detectBank(lines) {
  const head = lines.slice(0, 80).join('\n');
  if (/first national bank|\bFNB\b/i.test(head)) return 'fnb';
  if (/capitec/i.test(head)) return 'capitec';
  if (/standard bank/i.test(head)) return 'standardbank';
  if (/nedbank/i.test(head)) return 'nedbank';
  if (/\babsa\b/i.test(head)) return 'absa';
  return null;
}

function detectPeriod(lines) {
  const full = new RegExp(`Statement Period\\s*:?\\s*(\\d{1,2})\\s+${MONTH_RE}\\s+(\\d{4})\\s+to\\s+(\\d{1,2})\\s+${MONTH_RE}\\s+(\\d{4})`, 'i');
  for (const l of lines.slice(0, 80)) {
    const m = l.match(full);
    if (m) return { start: iso(+m[3], MONTHS[m[2].toLowerCase()], +m[1]), end: iso(+m[6], MONTHS[m[5].toLowerCase()], +m[4]) };
  }
  const re = new RegExp(`(\\d{1,2})\\s+${MONTH_RE}\\s+(\\d{4})`, 'gi');
  const found = [];
  for (const l of lines.slice(0, 60)) {
    for (const m of l.matchAll(re)) found.push(iso(+m[3], MONTHS[m[2].toLowerCase()], +m[1]));
  }
  if (!found.length) return null;
  found.sort();
  return { start: found[0], end: found[found.length - 1] };
}

function resolveYear(day, month, period) {
  const now = new Date();
  if (!period) return now.getUTCFullYear() - (iso(now.getUTCFullYear(), month, day) > now.toISOString().slice(0, 10) ? 1 : 0);
  const ys = +period.start.slice(0, 4), ye = +period.end.slice(0, 4);
  if (ys === ye) return ye;
  // statement spans New Year: months at/after the start month belong to the earlier year
  return month >= +period.start.slice(5, 7) ? ys : ye;
}

const DATE_PATTERNS = [
  { re: new RegExp(`^(\\d{1,2})\\s+${MONTH_RE}\\s+(\\d{4})(?![.,\\d])`, 'i'), f: m => ({ d: +m[1], mo: MONTHS[m[2].toLowerCase()], y: +m[3] }) },
  { re: new RegExp(`^(\\d{1,2})\\s+${MONTH_RE}\\b(?!\\s+\\d{4}(?![.,\\d]))`, 'i'), f: m => ({ d: +m[1], mo: MONTHS[m[2].toLowerCase()], y: null }) },
  { re: /^(\d{4})[\/\-](\d{2})[\/\-](\d{2})\b/, f: m => ({ d: +m[3], mo: +m[2], y: +m[1] }) },
  { re: /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/, f: m => ({ d: +m[1], mo: +m[2], y: +m[3] }) },
];

function readDate(line, period) {
  const s = line.trimStart();
  for (const p of DATE_PATTERNS) {
    const m = s.match(p.re); if (!m) continue;
    const v = p.f(m);
    if (v.mo < 1 || v.mo > 12 || v.d < 1 || v.d > 31) return null;
    return { date: iso(v.y || resolveYear(v.d, v.mo, period), v.mo, v.d), rest: s.slice(m[0].length) };
  }
  return null;
}

const signed = tok => {                                              // "1,234.56Cr" → 1234.56, "…Dr" / "-…" → negative
  const m = String(tok).match(/^(-?)([\d,]+\.\d{2})\s?(Cr|Dr|CR|DR)?$/);
  if (!m) return null;
  const n = parseFloat(m[2].replace(/,/g, ''));
  const neg = m[1] === '-' || /^dr$/i.test(m[3] || '');
  return { n, neg, cr: /^cr$/i.test(m[3] || ''), dr: /^dr$/i.test(m[3] || ''), explicitNeg: m[1] === '-' };
};

const NOISE = /(page\s+\d+\s*(of|\/)\s*\d+|customer care|www\.|vat reg|terms and conditions|branch (name|code|number)|account number|statement (date|period|number)|total (debits|credits|fees|vat)|^date\s+description|transactions in rand|verif|reference number|delivery method|ns\/iq|xstz|turnover|no\. (credit|debit)|please contact|prime lending|financial services)/i;
const BALANCE_ONLY = /(opening balance|brought forward|balance brought|closing balance)/i;
const TRAIL = new RegExp(`^(.*?)((?:\\s+(?:${MONEY_RE})(?:\\s?(?:Cr|Dr|CR|DR))?)+)\\s*$`);

// "POS Purchase 14.99 Google One 479056*3542 20 May 14.99 200.37Cr" → text + [14.99, 200.37Cr]
// Only the right-hand COLUMNS are peeled off, so a number inside the description survives.
function splitTrailing(rest) {
  const s = ' ' + String(rest).trim();
  const m = s.match(TRAIL);
  if (!m) return { text: String(rest).trim(), tokens: [] };
  return { text: m[1].trim(), tokens: m[2].match(MONEY_TOKEN) || [] };
}

const round2 = n => Math.round(n * 100) / 100;

// FNB prints "No. Credit Transactions 22  5,555.50Cr" / "No. Debit Transactions 86  5,670.64Dr" — a free checksum.
function readTurnover(lines) {
  const j = lines.join('\n');
  const c = j.match(/No\.?\s*Credit Transactions\s+(\d+)\s+([\d,]+\.\d{2})\s?Cr/i);
  const dr = j.match(/No\.?\s*Debit Transactions\s+(\d+)\s+([\d,]+\.\d{2})\s?Dr/i);
  if (!c || !dr) return null;
  return { credits: { count: +c[1], total: parseFloat(c[2].replace(/,/g, '')) }, debits: { count: +dr[1], total: parseFloat(dr[2].replace(/,/g, '')) } };
}

function cleanDescription(text) {
  return text
    .replace(/\b\d{6}\*+\d{4}\b(?:\s+\d{1,2}\s+[A-Za-z]{3})?/g, ' ')    // masked card number + the card-swipe date FNB prints beside it
    .replace(/\s{2,}/g, ' ').trim();
}

function parseStatementText(lines) {
  const bank = detectBank(lines);
  const period = detectPeriod(lines);
  const turnover = readTurnover(lines);
  const warnings = [];
  const txs = [];
  let prev = null, opening = null, closing = null;
  let pending = null, last = null, guessed = 0;

  const finish = (date, text, tokens) => {
    const toks = tokens.map(signed).filter(Boolean);
    if (!toks.length) return;
    let amount = null, balance = null;
    if (toks.length >= 2) {
      let pick = null;
      for (let i = 0; i < toks.length - 1 && !pick; i++) {
        if (prev == null) { pick = [toks[i], toks[i + 1]]; break; }
        const b = toks[i + 1].neg ? -toks[i + 1].n : toks[i + 1].n;
        if (Math.abs(Math.abs(b - prev) - toks[i].n) < 0.015) pick = [toks[i], toks[i + 1]];
      }
      if (!pick) pick = [toks[0], toks[1]];
      amount = pick[0]; balance = pick[1];
    } else amount = toks[0];

    let type = 'expense';
    const bal = balance ? (balance.neg ? -balance.n : balance.n) : null;
    if (bal != null && prev != null && Math.abs(Math.abs(bal - prev) - amount.n) < 0.015) type = bal > prev ? 'income' : 'expense';
    else if (amount.cr) type = 'income';
    else if (amount.dr || amount.explicitNeg) type = 'expense';
    else if (bal != null && prev != null) type = bal > prev ? 'income' : 'expense';
    else { guessed++; type = 'expense'; }
    if (bal != null) prev = bal;
    if (amount.n === 0) return;

    let description = cleanDescription(text).replace(/[#*]+\s*$/, '').trim();
    // FNB's fee rows ("#Service Fees", "#Monthly Account Fee", …) often have NO description in the PDF's text layer.
    const fee = !description || /^#/.test(description);
    description = fee ? (description.replace(/#/g, ' ').replace(/\s{2,}/g, ' ').trim() || 'Bank fee') : description;
    last = { date, description, amount: amount.n, type, balance: bal, fee, wraps: 0 };
    txs.push(last);
  };

  for (const raw of lines) {
    const line = raw.replace(/\u00a0/g, ' ');
    if (!line.trim()) continue;

    if (BALANCE_ONLY.test(line)) {
      const after = line.slice(line.search(BALANCE_ONLY));
      const t = (after.match(MONEY_TOKEN) || []).map(signed).filter(Boolean)[0];     // first figure after the label (other boxes share this row)
      if (t) {
        const v = t.neg ? -t.n : t.n;
        if (/closing/i.test(after.slice(0, 20))) closing = v;
        else if (prev == null) { prev = v; opening = v; }
      }
      pending = null; last = null; continue;
    }
    const dated = readDate(line, period);
    if (dated) {
      const sp = splitTrailing(dated.rest);
      pending = null;
      if (sp.tokens.length) finish(dated.date, sp.text, sp.tokens);
      else if (dated.rest.trim() && !NOISE.test(dated.rest)) pending = { date: dated.date, text: dated.rest.trim() };
      else last = null;
      continue;
    }
    if (NOISE.test(line)) { pending = null; last = null; continue; }
    const sp = splitTrailing(line);
    if (pending && sp.tokens.length) { finish(pending.date, `${pending.text} ${sp.text}`, sp.tokens); pending = null; continue; }
    if (pending) { pending.text += ' ' + line.trim(); continue; }
    if (last && !sp.tokens.length && last.wraps < 1 && line.trim().length <= 40 && !/\s{3,}/.test(line)) {
      last.description = (last.description + ' ' + line.trim()).replace(/\s{2,}/g, ' ');
      last.wraps++;
    }
  }

  // ── self-check against the statement's own totals ──
  let reconciled = null;
  const inc = txs.filter(t => t.type === 'income'), exp = txs.filter(t => t.type === 'expense');
  const sum = a => round2(a.reduce((s, t) => s + t.amount, 0));
  if (turnover) {
    reconciled = inc.length === turnover.credits.count && exp.length === turnover.debits.count &&
      Math.abs(sum(inc) - turnover.credits.total) < 0.02 && Math.abs(sum(exp) - turnover.debits.total) < 0.02;
    if (!reconciled) warnings.push(`The statement lists ${turnover.credits.count} credits (R${turnover.credits.total.toFixed(2)}) and ${turnover.debits.count} debits (R${turnover.debits.total.toFixed(2)}), but I read ${inc.length} and ${exp.length}. Some rows may be missing — check before importing.`);
  } else if (opening != null && closing != null && txs.length) {
    reconciled = Math.abs(round2(opening + sum(inc) - sum(exp)) - closing) < 0.02;
    if (!reconciled) warnings.push("The transactions don't add up to the statement's closing balance — some rows may be missing.");
  }
  if (guessed) warnings.push(`${guessed} transaction${guessed === 1 ? '' : 's'} had no balance to check against — double-check income vs expense.`);
  return { bank, period, transactions: txs, warnings, reconciled, opening, closing };
}

async function parsePdfStatement(filePath) {
  const lines = await extractPdfLines(filePath);
  const out = parseStatementText(lines);
  if (!out.transactions.length) throw new Error("Couldn't find any transactions in that PDF. Is it a bank statement (not a payment confirmation or tax certificate)?");
  return out;
}

module.exports = { parsePdfStatement, parseStatementText, itemsToLines, detectBank, detectPeriod, splitTrailing };