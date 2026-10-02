/* Calendar pod — week agenda, event editor, AI planner, Google/Apple sync link.
   Self-contained: builds its own DOM inside #tab-calendar. All user/AI text is
   rendered with textContent (never innerHTML), so stored data can't inject markup. */
(function () {
  'use strict';
  const root = document.getElementById('tab-calendar');
  if (!root) return;

  const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const DAY = 86400000;

  // ── tiny helpers ──────────────────────────────────────────────────────────
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v === null || v === undefined) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
  const weekStartOf = s => { const d = parseYmd(s); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); return ymd(d); }; // Monday
  const fmt = (opts, d) => new Intl.DateTimeFormat(undefined, opts).format(d);
  const localToIso = (date, time) => new Date(`${date}T${time}`).toISOString();
  const say = (msg, undo) => (typeof window.toast === 'function' ? window.toast(msg, undo) : null);

  async function api(method, url, body, timeout = 20000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(url, {
        method, credentials: 'same-origin', signal: ctrl.signal,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      let data = null;
      try { data = await r.json(); } catch { /* empty body */ }
      if (!r.ok) {
        const e = new Error(r.status === 401 ? 'Your session expired — reload and sign in again.' : (data && (data.message || data.error)) || `Something went wrong (${r.status})`);
        e.status = r.status; e.data = data;
        throw e;
      }
      return data;
    } catch (e) {
      if (e.name === 'AbortError') { const t = new Error('That took too long — please try again.'); t.aborted = true; throw t; }
      if (e instanceof TypeError) throw new Error("Can't reach the server — check your connection.");
      throw e;
    } finally { clearTimeout(timer); }
  }

  // ── state ─────────────────────────────────────────────────────────────────
  const today = () => ymd(new Date());
  const state = { sel: today(), week: weekStartOf(today()), events: [], tasks: [], status: 'idle', error: '', loadedAt: 0, token: 0 };
  const monthStartOf = s => s.slice(0, 8) + '01';
  const imports = { status: 'idle', list: [], names: {}, error: '' };
  const mstate = { open: false, month: monthStartOf(today()), events: [], tasks: [], status: 'idle', token: 0 };
  let syncOpen = false;
  let importOpen = false;

  // ── skeleton (built once) ─────────────────────────────────────────────────
  const elTitle = h('div', { class: 'cal-title', 'aria-live': 'polite' });
  const elStrip = h('div', { class: 'cal-strip', role: 'group', 'aria-label': 'Days of the week' });
  const elAgenda = h('div');
  const elMonth = h('div', { class: 'cal-month', hidden: true });
  const elMonthBtn = h('button', { class: 'cal-pill cal-monthtoggle', type: 'button', 'aria-expanded': 'false', onclick: () => toggleMonth() }, 'month view');
  const elPlanCard = h('div', { class: 'cal-card' });
  const elSyncCard = h('div', { class: 'cal-card' });
  const elImportCard = h('div', { class: 'cal-card' });

  const chev = d => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  const iconBtn = (label, path, onclick) => { const b = h('button', { class: 'cal-iconbtn', type: 'button', 'aria-label': label, onclick }); b.innerHTML = chev(path); return b; };

  root.append(h('div', { class: 'cal-root' },
    h('div', { class: 'cal-head' },
      iconBtn('Previous week', 'M15 18l-6-6 6-6', () => shiftWeek(-7)),
      elTitle,
      h('button', { class: 'cal-pill', type: 'button', onclick: () => { state.sel = today(); state.week = weekStartOf(state.sel); load(); } }, 'today'),
      iconBtn('Next week', 'M9 18l6-6-6-6', () => shiftWeek(7)),
      iconBtn('Add event', 'M12 5v14M5 12h14', () => openEventSheet()),
    ),
    h('div', { class: 'cal-sub' }, elMonthBtn), elMonth, elStrip, elAgenda, elPlanCard, elSyncCard, elImportCard,
  ));

  // ── data ──────────────────────────────────────────────────────────────────
  // Jump to a date. Returns true when it stayed in the loaded week (so a quiet refresh is enough).
  function goTo(s) {
    const w = weekStartOf(s), same = w === state.week;
    state.sel = s; state.week = w;
    if (same) { renderStrip(); renderAgenda(); }
    return same;
  }

  function shiftWeek(n) { state.week = addDays(state.week, n); state.sel = state.week === weekStartOf(today()) ? today() : state.week; load(); }

  async function load({ silent = false } = {}) {
    const token = ++state.token;
    if (!silent) { state.status = 'loading'; render(); } else renderHead();
    try {
      const from = parseYmd(state.week);
      const to = parseYmd(addDays(state.week, 7));
      const data = await api('GET', `/api/calendar/events?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`);
      if (token !== state.token) return; // a newer request superseded this one
      state.events = data.events || []; state.tasks = data.tasks || [];
      state.status = 'ready'; state.loadedAt = Date.now(); if (mstate.open) loadMonth();
    } catch (e) {
      if (token !== state.token) return;
      state.status = 'error'; state.error = e.message;
    }
    render();
  }

  // items that fall on local day `s`
  function itemsFor(s) {
    const a = parseYmd(s).getTime(), b = a + DAY;
    const rows = [];
    for (const e of state.events) {
      const st = Date.parse(e.start_at), en = Date.parse(e.end_at);
      if (st < b && en > a) rows.push({ type: 'event', at: Math.max(st, a), e });
    }
    for (const t of state.tasks) {
      const at = Date.parse(t.at);
      if (at >= a && at < b) rows.push({ type: 'task', at, t });
    }
    return rows.sort((x, y) => x.at - y.at);
  }

  // ── render ────────────────────────────────────────────────────────────────
  function renderHead() {
    const a = parseYmd(state.week), b = parseYmd(addDays(state.week, 6));
    elTitle.textContent = `${fmt({ month: 'short', day: 'numeric' }, a)} – ${fmt({ month: 'short', day: 'numeric' }, b)}`;
  }

  function renderStrip() {
    const t = today();
    elStrip.replaceChildren(...Array.from({ length: 7 }, (_, i) => {
      const s = addDays(state.week, i), d = parseYmd(s);
      const has = state.status === 'ready' && itemsFor(s).length > 0;
      return h('button', {
        type: 'button', class: `cal-day${s === t ? ' today' : ''}${has ? ' has' : ''}`,
        'aria-pressed': String(s === state.sel), 'aria-current': s === t ? 'date' : false,
        'aria-label': fmt({ weekday: 'long', month: 'long', day: 'numeric' }, d) + (has ? ', has items' : ''),
        onclick: () => { state.sel = s; renderStrip(); renderAgenda(); renderMonth(); },
      }, h('span', { class: 'dow', text: fmt({ weekday: 'narrow' }, d) }), h('span', { class: 'num', text: d.getDate() }), h('span', { class: 'dot' }));
    }));
  }

  function renderAgenda() {
    const d = parseYmd(state.sel);
    const label = h('div', { class: 'cal-daylabel', text: state.sel === today() ? `Today · ${fmt({ weekday: 'long', month: 'short', day: 'numeric' }, d)}` : fmt({ weekday: 'long', month: 'long', day: 'numeric' }, d) });

    let body;
    if (state.status === 'loading' || state.status === 'idle') {
      body = h('div', { class: 'cal-list', 'aria-busy': 'true' }, [1, 2, 3].map(() => h('div', { class: 'skeleton cal-skel' })));
    } else if (state.status === 'error') {
      body = h('div', { class: 'cal-err', role: 'alert' }, h('span', { text: state.error }), h('button', { class: 'cal-btn ghost', type: 'button', onclick: () => load() }, 'Retry'));
    } else {
      const rows = itemsFor(state.sel);
      if (!rows.length) {
        body = h('div', { class: 'cal-empty' }, h('strong', { text: 'Nothing planned' }), 'A clear day. Add an event, or let Core plan it for you.');
      } else {
        body = h('div', { class: 'cal-list' }, rows.map(r => r.type === 'event' ? eventRow(r.e) : taskRow(r.t)));
      }
    }
    elAgenda.replaceChildren(label, body);
  }

  function eventRow(e) {
    const st = new Date(e.start_at), en = new Date(e.end_at);
    const imp = String(e.source || '').startsWith('import:');
    const tag = imp ? h('span', { class: 'cal-tag', text: imports.names[e.source] || 'imported' }) : e.source === 'itinerary' ? h('span', { class: 'cal-tag', text: 'AI plan' }) : null;
    return h('button', { type: 'button', class: `cal-item${imp ? ' imported' : ''}`, onclick: () => imp ? say('Imported events are read-only — edit them in the original calendar.') : openEventSheet(e), 'aria-label': `${e.title}, ${hm(st)} to ${hm(en)}.${imp ? ' Imported, read only' : ' Edit'}` },
      h('div', { class: 'when' }, hm(st), h('br'), hm(en)),
      h('div', { class: 'what' }, h('div', { class: 't' }, e.title, tag), (e.location || e.notes) ? h('div', { class: 'sub', text: e.location || e.notes }) : null));
  }

  function taskRow(t) {
    const label = { block: 'Scheduled', due: 'Due', start: 'Starts', remind: 'Reminder' }[t.kind] || 'Task';
    return h('div', { class: 'cal-item task' },
      h('div', { class: 'when' }, hm(new Date(t.at)), h('br'), t.end_at ? hm(new Date(t.end_at)) : label.toLowerCase()),
      h('div', { class: 'what' }, h('div', { class: 't', text: t.title }), h('div', { class: 'sub', text: `Task · ${label}` })));
  }

  function render() { renderHead(); renderStrip(); renderAgenda(); renderMonth(); }

  // ── month grid (sits above the week strip; opens with the "month view" pill) ──
  function toggleMonth() {
    mstate.open = !mstate.open;
    if (mstate.open) { mstate.month = monthStartOf(state.sel); loadMonth(); }
    renderMonth();
  }

  function shiftMonth(n) {
    const d = parseYmd(mstate.month); d.setMonth(d.getMonth() + n, 1);
    mstate.month = ymd(d); loadMonth();
  }

  async function loadMonth() {
    const token = ++mstate.token;
    mstate.status = 'loading'; renderMonth();
    try {
      const gridStart = weekStartOf(mstate.month);
      const from = parseYmd(gridStart), to = parseYmd(addDays(gridStart, 42));
      const data = await api('GET', `/api/calendar/events?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`);
      if (token !== mstate.token) return;
      mstate.events = data.events || []; mstate.tasks = data.tasks || []; mstate.status = 'ready';
    } catch (e) {
      if (token !== mstate.token) return;
      mstate.status = 'error';
    }
    renderMonth();
  }

  function monthHas(s) {
    const a = parseYmd(s).getTime(), b = a + DAY;
    return mstate.events.some(e => Date.parse(e.start_at) < b && Date.parse(e.end_at) > a)
        || mstate.tasks.some(t => { const at = Date.parse(t.at); return at >= a && at < b; });
  }

  function pickMonthDay(s) {
    if (monthStartOf(s) !== mstate.month) { mstate.month = monthStartOf(s); loadMonth(); }
    if (!goTo(s)) load({ silent: true });
    renderMonth();
  }

  function renderMonth() {
    elMonthBtn.setAttribute('aria-expanded', String(mstate.open));
    elMonthBtn.textContent = mstate.open ? 'hide month' : 'month view';
    elMonth.hidden = !mstate.open;
    if (!mstate.open) return;
    const t = today(), mDate = parseYmd(mstate.month), gridStart = weekStartOf(mstate.month);
    const rows = parseYmd(addDays(gridStart, 35)).getMonth() === mDate.getMonth() ? 6 : 5;
    const head = h('div', { class: 'cal-mhead' },
      iconBtn('Previous month', 'M15 18l-6-6 6-6', () => shiftMonth(-1)),
      h('div', { class: 'cal-mtitle', 'aria-live': 'polite', text: fmt({ month: 'long', year: 'numeric' }, mDate) }),
      iconBtn('Next month', 'M9 18l6-6-6-6', () => shiftMonth(1)));
    const dows = Array.from({ length: 7 }, (_, i) => h('div', { class: 'cal-mdow', 'aria-hidden': 'true', text: fmt({ weekday: 'narrow' }, parseYmd(addDays(gridStart, i))) }));
    const cells = Array.from({ length: rows * 7 }, (_, i) => {
      const s = addDays(gridStart, i), d = parseYmd(s);
      const has = mstate.status === 'ready' && monthHas(s);
      return h('button', {
        type: 'button', class: `cal-mday${d.getMonth() === mDate.getMonth() ? '' : ' out'}${s === t ? ' today' : ''}${has ? ' has' : ''}`,
        'aria-pressed': String(s === state.sel), 'aria-current': s === t ? 'date' : false,
        'aria-label': fmt({ weekday: 'long', month: 'long', day: 'numeric' }, d) + (has ? ', has items' : ''),
        onclick: () => pickMonthDay(s),
      }, h('span', { class: 'num', text: d.getDate() }), h('span', { class: 'dot' }));
    });
    elMonth.replaceChildren(head, h('div', { class: 'cal-mgrid' }, dows, cells));
  }

  // ── sheets (reuse the app's overlay/sheet look) ───────────────────────────
  let openSheet = null;
  function showSheet(build, { onClose, locked } = {}) {
    closeSheet(true);
    const opener = document.activeElement;
    const overlay = h('div', { class: 'sheet-overlay' });
    const sheet = h('div', { class: 'bottom-sheet cal-sheet', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'sheet-handle' }));
    document.body.append(overlay, sheet);
    const ctl = {
      sheet, overlay, locked: !!locked, onClose,
      set(...nodes) { sheet.replaceChildren(h('div', { class: 'sheet-handle' }), ...nodes); const f = sheet.querySelector('input,textarea,button'); if (f && !sheet.contains(document.activeElement)) f.focus({ preventScroll: true }); },
      close: () => closeSheet(),
    };
    overlay.addEventListener('click', () => { if (!ctl.locked) closeSheet(); });
    sheet.addEventListener('keydown', ev => {
      if (ev.key === 'Escape' && !ctl.locked) { ev.stopPropagation(); closeSheet(); }
      if (ev.key === 'Tab') { // keep focus inside the dialog
        const f = [...sheet.querySelectorAll('button,input,textarea,select,[href]')].filter(x => !x.disabled && x.offsetParent !== null);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
        else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
      }
    });
    ctl.opener = opener;
    openSheet = ctl;
    build(ctl);
    requestAnimationFrame(() => { overlay.classList.add('open'); sheet.classList.add('open'); });
    return ctl;
  }

  function closeSheet(immediate) {
    const c = openSheet; if (!c) return;
    openSheet = null;
    c.onClose && c.onClose();
    c.sheet.setAttribute('inert', ''); c.sheet.setAttribute('aria-hidden', 'true'); // a closing sheet can't take clicks or focus
    c.overlay.classList.remove('open'); c.sheet.classList.remove('open');
    const done = () => { c.overlay.remove(); c.sheet.remove(); };
    immediate ? done() : setTimeout(done, 380);
    if (!immediate && c.opener && c.opener.focus && document.contains(c.opener)) c.opener.focus({ preventScroll: true });
  }

  const field = (id, label, control) => h('div', { class: 'cal-field' }, h('label', { for: id, text: label }), control);

  // ── event editor ──────────────────────────────────────────────────────────
  function openEventSheet(ev) {
    const editing = !!ev;
    const now = new Date();
    const defStart = state.sel === today() ? new Date(Math.ceil((now.getTime() + 60000) / 3600000) * 3600000) : new Date(`${state.sel}T09:00`);
    const s = ev ? new Date(ev.start_at) : defStart;
    const e = ev ? new Date(ev.end_at) : new Date(s.getTime() + 3600000);

    const title = h('input', { id: 'calT', class: 'sheet-input', maxlength: 200, autocomplete: 'off', placeholder: 'What is it?', value: ev ? ev.title : '' });
    const date = h('input', { id: 'calD', class: 'sheet-input', type: 'date', value: ymd(s) });
    const st = h('input', { id: 'calS', class: 'sheet-input', type: 'time', value: hm(s) });
    const en = h('input', { id: 'calE', class: 'sheet-input', type: 'time', value: hm(e) });
    const loc = h('input', { id: 'calL', class: 'sheet-input', maxlength: 200, autocomplete: 'off', placeholder: 'Optional', value: ev?.location || '' });
    const notes = h('textarea', { id: 'calN', class: 'sheet-input', maxlength: 2000, placeholder: 'Optional' });
    notes.value = ev?.notes || '';
    const msg = h('p', { class: 'cal-msg', role: 'alert' });
    const save = h('button', { class: 'sheet-confirm', type: 'button' }, editing ? 'Save changes' : 'Add to calendar');
    const multiDay = editing && ymd(s) !== ymd(new Date(Date.parse(ev.end_at) - 1));
    if (multiDay) en.disabled = true; // a multi-day event keeps its length; only the start can move

    save.addEventListener('click', async () => {
      msg.textContent = '';
      if (!title.value.trim()) { msg.textContent = 'Give it a title.'; title.focus(); return; }
      if (!date.value || !st.value || !en.value) { msg.textContent = 'Pick a date and both times.'; return; }
      let startIso = localToIso(date.value, st.value), endIso = localToIso(date.value, en.value);
      if (multiDay) endIso = new Date(Date.parse(startIso) + (Date.parse(ev.end_at) - Date.parse(ev.start_at))).toISOString();
      if (Date.parse(endIso) <= Date.parse(startIso)) { msg.textContent = 'The end has to be after the start.'; en.focus(); return; }
      save.disabled = true; save.textContent = 'Saving…';
      try {
        const body = { title: title.value, start_at: startIso, end_at: endIso, location: loc.value, notes: notes.value };
        await (editing ? api('PATCH', `/api/calendar/events/${ev.id}`, body) : api('POST', '/api/calendar/events', body));
        closeSheet();
        say(editing ? 'Event updated' : 'Event added');
        load({ silent: goTo(date.value) });
      } catch (err) { msg.textContent = err.message; save.disabled = false; save.textContent = editing ? 'Save changes' : 'Add to calendar'; }
    });

    const extras = [];
    if (editing) {
      let armed = false, timer;
      const del = h('button', { class: 'cal-btn danger block', type: 'button', style: 'margin-top:10px' }, 'Delete event');
      del.addEventListener('click', async () => {
        if (!armed) { armed = true; del.textContent = 'Tap again to delete'; timer = setTimeout(() => { armed = false; del.textContent = 'Delete event'; }, 4000); return; }
        clearTimeout(timer); del.disabled = true;
        try { await api('DELETE', `/api/calendar/events/${ev.id}`); closeSheet(); say('Event deleted'); load({ silent: true }); }
        catch (err) { msg.textContent = err.message; del.disabled = false; armed = false; del.textContent = 'Delete event'; }
      });
      extras.push(del);
      if (ev.source === 'itinerary' && ev.itinerary_id) {
        const rm = h('button', { class: 'cal-btn ghost block', type: 'button', style: 'margin-top:8px' }, 'Remove the whole AI plan');
        rm.addEventListener('click', async () => {
          if (rm.dataset.armed !== '1') { rm.dataset.armed = '1'; rm.textContent = 'Tap again — removes every event from this plan'; return; }
          rm.disabled = true;
          try { const r = await api('DELETE', `/api/itinerary/${ev.itinerary_id}`); closeSheet(); say(`Removed ${r.removed_events} events`); load({ silent: true }); }
          catch (err) { msg.textContent = err.message; rm.disabled = false; }
        });
        extras.push(rm);
      }
    }

    showSheet(c => c.set(
      h('div', { class: 'sheet-title', text: editing ? 'Edit event' : 'New event' }),
      field('calT', 'Title', title), field('calD', 'Date', date),
      h('div', { class: 'cal-row' }, field('calS', 'Starts', st), field('calE', 'Ends', en)),
      field('calL', 'Location', loc), field('calN', 'Notes', notes), msg, save, ...extras,
    ));
  }

  // ── AI planner ────────────────────────────────────────────────────────────
  const WEEK_PROMPT = 'Plan my week around my usual routines and what is still open';
  const PROMPTS = [WEEK_PROMPT, 'Plan my day around my tasks', 'Balance deep work and rest', 'Focus on my high-priority tasks', 'Make time for a workout'];

  function rangeFor(kind) {
    const t = today();
    if (kind === 'today') return [t, t];
    if (kind === 'tomorrow') return [addDays(t, 1), addDays(t, 1)];
    if (kind === 'week') { const dow = (parseYmd(t).getDay() + 6) % 7; return [t, addDays(t, 6 - dow)]; }
    if (kind === 'next30') { const t = today(); return [t, addDays(t, 29)]; }
    return [t, addDays(t, 6)];
  }

  function openPlanSheet() {
    let aborter = null;
    const form = { prompt: '', range: 'today', dayStart: '08:00', dayEnd: '21:00' };
    showSheet(c => renderForm(c), { onClose: () => aborter && aborter.abort() });

    function renderForm(c, err) {
      const ta = h('textarea', { id: 'calP', class: 'sheet-input', maxlength: 1000, placeholder: 'e.g. Plan my week — gym 3×, finish the proposal by Thursday, keep evenings free' });
      ta.value = form.prompt;
      ta.addEventListener('input', () => { form.prompt = ta.value; });
      const chips = h('div', { class: 'sheet-chips', style: 'margin-bottom:14px' }, PROMPTS.map(p => h('button', { type: 'button', class: 'sheet-chip', onclick: () => { form.prompt = p; ta.value = p; if (p === WEEK_PROMPT) { form.range = 'next7'; renderForm(c); return; } ta.focus(); } }, p)));
      const range = h('div', { class: 'sheet-chips', role: 'radiogroup', 'aria-label': 'Range' }, [['today', 'Today'], ['tomorrow', 'Tomorrow'], ['week', 'Rest of this week'], ['next7', 'Next 7 days'], ['next30', 'Next 30 days']].map(([k, l]) =>
        h('button', { type: 'button', role: 'radio', 'aria-checked': String(form.range === k), class: `sheet-chip${form.range === k ? ' active' : ''}`, onclick: () => { form.range = k; renderForm(c); } }, l)));
      const ds = h('input', { id: 'calDS', class: 'sheet-input', type: 'time', value: form.dayStart });
      const de = h('input', { id: 'calDE', class: 'sheet-input', type: 'time', value: form.dayEnd });
      ds.addEventListener('change', () => { form.dayStart = ds.value; }); de.addEventListener('change', () => { form.dayEnd = de.value; });
      const msg = h('p', { class: 'cal-msg', role: 'alert', text: err || '' });
      const go = h('button', { class: 'sheet-confirm', type: 'button' }, 'Build my plan');
      go.addEventListener('click', () => {
        if (form.prompt.trim().length < 3) { msg.textContent = 'Tell Core what you want to plan.'; ta.focus(); return; }
        if (!ds.value || !de.value || de.value <= ds.value) { msg.textContent = 'Your day has to end after it starts.'; return; }
        generate(c);
      });
      c.set(h('div', { class: 'sheet-title', text: 'Plan with Core' }),
        field('calP', 'What should I plan?', ta), chips,
        h('div', { class: 'cal-field' }, h('label', { text: 'When' }), range),
        h('div', { class: 'cal-row' }, field('calDS', 'Day starts', ds), field('calDE', 'Day ends', de)),
        h('p', { class: 'cal-small', style: 'margin:-4px 0 14px', text: "Core looks at your open tasks, your calendar (including linked ones), your past routines and today's weather. You'll review everything before it's added." }),
        msg, go);
    }

    async function generate(c) {
      const [start_date, end_date] = rangeFor(form.range);
      aborter = new AbortController();
      c.locked = true;
      const cancel = h('button', { class: 'cal-btn ghost block', type: 'button', onclick: () => { aborter.abort(); } }, 'Cancel');
      c.set(h('div', { class: 'sheet-title', text: 'Plan with Core' }),
        h('div', { class: 'cal-load', role: 'status' }, h('div', { class: 'cal-spin' }), 'Core is building your plan…', h('div', { class: 'cal-small', text: 'This usually takes 10–30 seconds.' })), cancel);
      try {
        const res = await fetch('/api/itinerary/generate', {
          method: 'POST', credentials: 'same-origin', signal: aborter.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: form.prompt, start_date, end_date, timezone: TZ, day_start: form.dayStart, day_end: form.dayEnd }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const m = res.status === 402 ? "You've used all your AI plans for this month. Upgrade to keep planning." : res.status === 429 ? 'Easy — too many requests. Try again in a minute.' : res.status === 401 ? 'Your session expired — reload and sign in again.' : (data.message || data.error || 'Something went wrong.');
          c.locked = false; return renderForm(c, m);
        }
        c.locked = false; renderDraft(c, data);
      } catch (e) {
        c.locked = false;
        if (e.name === 'AbortError') return renderForm(c, 'Cancelled.');
        renderForm(c, "Can't reach the server — check your connection and try again.");
      } finally { aborter = null; }
    }

    function renderDraft(c, draft) {
      const plan = draft.plan;
      const off = new Set();
      const countBtn = h('button', { class: 'cal-btn', type: 'button' });
      const discard = h('button', { class: 'cal-btn ghost', type: 'button' }, 'Discard');
      const msg = h('p', { class: 'cal-msg', role: 'alert' });
      const updateCount = () => { const n = plan.items.length - off.size; countBtn.textContent = n ? `Add ${n} to calendar` : 'Nothing selected'; countBtn.disabled = !n; };

      const extra = h('textarea', { class: 'sheet-input', maxlength: 300, rows: 2, placeholder: 'e.g. gym on Thursday, keep Friday afternoon free, call mum', 'aria-label': 'Add to this plan' });
      const refine = h('button', { class: 'cal-btn ghost block', type: 'button' }, 'Update plan with this');
      refine.addEventListener('click', () => {
        const more = extra.value.trim();
        if (more.length < 3) { msg.textContent = 'Type what you want added or changed first.'; extra.focus(); return; }
        form.prompt = `${form.prompt.slice(0, 700)}\n\nAlso: ${more}`.slice(0, 1000);
        api('DELETE', `/api/itinerary/${draft.id}`).catch(() => {});
        generate(c);
      });
      const refineBox = h('div', { class: 'cal-field', style: 'margin-top:16px' }, h('label', { text: 'Anything to add?' }), extra, h('div', { style: 'height:8px' }), refine);

      const byDate = new Map();
      for (const it of plan.items) { if (!byDate.has(it.date)) byDate.set(it.date, []); byDate.get(it.date).push(it); }
      const groups = [];
      for (const [d, items] of byDate) {
        groups.push(h('div', { class: 'cal-dayhead', text: fmt({ weekday: 'long', month: 'short', day: 'numeric' }, parseYmd(d)) }));
        for (const it of items) {
          const cb = h('input', { type: 'checkbox', checked: true, 'aria-label': `Include ${it.title}` });
          const row = h('label', { class: 'cal-pick' }, cb,
            h('div', { class: 'when' }, it.start, h('br'), it.end),
            h('div', { style: 'min-width:0;flex:1' }, h('div', { class: 't', text: it.title }), it.notes ? h('div', { class: 'sub', text: it.notes }) : null,
              it.conflict ? h('span', { class: 'cal-clash', text: `⚠ overlaps "${it.conflict}"` }) : null));
          cb.addEventListener('change', () => { cb.checked ? off.delete(it.key) : off.add(it.key); row.classList.toggle('off', !cb.checked); updateCount(); });
          groups.push(row);
        }
      }

      countBtn.addEventListener('click', async () => {
        countBtn.disabled = true; discard.disabled = true; countBtn.textContent = 'Adding…'; msg.textContent = '';
        try {
          const r = await api('POST', `/api/itinerary/${draft.id}/confirm`, { exclude: [...off] });
          closeSheet();
          const first = plan.items.find(i => !off.has(i.key));
          await load({ silent: goTo(first ? first.date : draft.range_start) });
          say(`Added ${r.created} event${r.created === 1 ? '' : 's'} to your calendar`, async () => {
            try { await api('DELETE', `/api/itinerary/${draft.id}`); say('Plan removed'); load({ silent: true }); } catch (e) { say(e.message); }
          });
        } catch (err) { msg.textContent = err.message; countBtn.disabled = false; discard.disabled = false; updateCount(); }
      });
      discard.addEventListener('click', async () => { closeSheet(); api('DELETE', `/api/itinerary/${draft.id}`).catch(() => {}); });

      c.set(h('div', { class: 'sheet-title', text: plan.title }),
        plan.summary ? h('p', { class: 'cal-sum', text: plan.summary }) : null,
        plan.basis && plan.basis.length ? h('div', { class: 'cal-basis' }, h('div', { class: 'cal-basis-h', text: 'Built from your history' }), ...plan.basis.map(b => h('div', { text: b }))) : null,
        plan.warnings && plan.warnings.length ? h('div', { class: 'cal-warn' }, plan.warnings.map(w => h('div', { text: w }))) : null,
        ...groups, refineBox, msg, h('div', { class: 'cal-stick' }, discard, countBtn));
      updateCount();
    }
  }

  // ── plan card ─────────────────────────────────────────────────────────────
  function renderPlanCard() {
    elPlanCard.replaceChildren(
      h('h3', { text: 'Plan with Core' }),
      h('p', { text: 'Describe your day or week. Core builds a schedule around your tasks, existing events and the weather — you approve it before anything is added.' }),
      h('div', { class: 'cal-actions' }, h('button', { class: 'cal-btn', type: 'button', onclick: openPlanSheet }, 'Build a plan')));
  }

  // ── sync card (Google / Apple / Outlook) ──────────────────────────────────
  const feed = { status: 'idle', url: null, webcal: null, error: '' };

  async function loadFeed() {
    feed.status = 'loading'; renderSyncCard();
    try { const d = await api('GET', '/api/calendar/feed'); feed.url = d.url; feed.webcal = d.webcal; feed.status = 'ready'; }
    catch (e) { feed.status = 'error'; feed.error = e.message; }
    renderSyncCard();
  }

  async function feedAction(method, okMsg) {
    try {
      const d = await api(method, '/api/calendar/feed');
      feed.url = d.url || null; feed.webcal = d.webcal || null; feed.status = 'ready'; renderSyncCard();
      if (okMsg) say(okMsg);
    } catch (e) { say(e.message); }
  }

  async function copy(text, input) {
    try { await navigator.clipboard.writeText(text); say('Link copied'); }
    catch { input.focus(); input.select(); say('Press copy on your keyboard to copy the link'); }
  }

  function renderSyncCard() {
    const toggle = h('button', { class: 'cal-collapse-btn', type: 'button', 'aria-expanded': String(syncOpen),
      onclick: () => { syncOpen = !syncOpen; renderSyncCard(); }
    }, syncOpen ? '▲' : '▼');
    const header = h('div', { class: 'cal-card-header' }, h('h3', { text: 'Sync to Google, Apple or Outlook' }), toggle);
    const kids = [header];
    if (syncOpen) {
      if (feed.status === 'loading' || feed.status === 'idle') {
        kids.push(h('div', { class: 'skeleton', style: 'height:44px;border-radius:12px' }));
      } else if (feed.status === 'error') {
        kids.push(h('p', { text: feed.error }), h('button', { class: 'cal-btn ghost', type: 'button', onclick: loadFeed }, 'Retry'));
      } else if (!feed.url) {
        kids.push(h('p', { text: 'Get a private link that shows your Core PA events in your normal calendar app. It updates on its own and is one-way: Core PA → your calendar.' }),
          h('button', { class: 'cal-btn', type: 'button', onclick: () => feedAction('POST', 'Sync link created') }, 'Create sync link'));
      } else {
        const input = h('input', { class: 'sheet-input', readonly: true, value: feed.url, 'aria-label': 'Private calendar link', onfocus: e => e.target.select() });
        let armed = false;
        const reset = h('button', { class: 'cal-btn ghost', type: 'button' }, 'Reset link');
        reset.addEventListener('click', () => { if (!armed) { armed = true; reset.textContent = 'Tap again — old link stops working'; setTimeout(() => { armed = false; reset.textContent = 'Reset link'; }, 4000); return; } feedAction('POST', 'New link created — re-add it in your calendar app'); });
        const off = h('button', { class: 'cal-btn danger', type: 'button' }, 'Turn off');
        off.addEventListener('click', () => { if (off.dataset.armed !== '1') { off.dataset.armed = '1'; off.textContent = 'Tap again to turn off'; setTimeout(() => { off.dataset.armed = ''; off.textContent = 'Turn off'; }, 4000); return; } feedAction('DELETE', 'Sync turned off'); });
        kids.push(
          h('p', { text: 'Anyone with this link can see your event titles, so keep it private.' }),
          h('div', { class: 'cal-link' }, input, h('button', { class: 'cal-btn', type: 'button', onclick: () => copy(feed.url, input) }, 'Copy')),
          h('div', { class: 'cal-actions' }, h('a', { class: 'cal-btn ghost', href: feed.webcal, style: 'display:inline-flex;align-items:center;text-decoration:none' }, 'Open in Apple / Outlook'), reset, off),
          h('p', { class: 'cal-small', text: 'Google Calendar: Settings → Add calendar → From URL, then paste the link. Google can take several hours to refresh subscribed calendars; Apple and Outlook refresh faster.' }));
      }
    }
    elSyncCard.replaceChildren(...kids);
  }

  // ── linked calendars (read-only import) ──────────────────────────────────
  function ago(iso) {
    const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (!Number.isFinite(m)) return 'never';
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    if (m < 1440) return `${Math.round(m / 60)} h ago`;
    return `${Math.round(m / 1440)} d ago`;
  }

  async function loadImports() {
    try {
      const d = await api('GET', '/api/calendar/imports');
      imports.list = d.imports || []; imports.status = 'ready';
      imports.names = {};
      for (const i of imports.list) imports.names[`import:${i.id}`] = i.name;
    } catch (e) { imports.status = 'error'; imports.error = e.message; }
    renderImportCard(); renderAgenda();
  }

  function afterImportChange() { loadImports(); load({ silent: true }); if (mstate.open) loadMonth(); }

  function renderImportCard() {
    const toggle = h('button', { class: 'cal-collapse-btn', type: 'button', 'aria-expanded': String(importOpen),
      onclick: () => { importOpen = !importOpen; renderImportCard(); }
    }, importOpen ? '▲' : '▼');
    const header = h('div', { class: 'cal-card-header' }, h('h3', { text: 'Bring in your other calendars' }), toggle);
    const kids = [header];
    if (importOpen) {
      kids.push(h('p', { text: 'Paste a read-only calendar link and those events show up here. Core plans around them too. They are never sent back out through your sync link.' }));
      if (imports.status === 'error') kids.push(h('p', { text: imports.error || "Couldn't load linked calendars." }), h('button', { class: 'cal-btn ghost', type: 'button', onclick: loadImports }, 'Retry'));
      for (const i of imports.list) {
        const refresh = h('button', { class: 'cal-btn ghost', type: 'button' }, 'Refresh');
        refresh.addEventListener('click', async () => {
          refresh.disabled = true; refresh.textContent = 'Refreshing…';
          try { const r = await api('POST', `/api/calendar/imports/${i.id}/sync`, {}, 40000); say(`Updated — ${r.imported} events`); } catch (e) { say(e.message); }
          afterImportChange();
        });
        const rm = h('button', { class: 'cal-btn danger', type: 'button' }, 'Remove');
        let armed = false;
        rm.addEventListener('click', async () => {
          if (!armed) { armed = true; rm.textContent = 'Tap again to remove'; setTimeout(() => { armed = false; rm.textContent = 'Remove'; }, 4000); return; }
          try { await api('DELETE', `/api/calendar/imports/${i.id}`); say('Calendar removed'); } catch (e) { say(e.message); }
          afterImportChange();
        });
        kids.push(h('div', { class: 'cal-imp' },
          h('div', { class: 'cal-imp-t' }, h('strong', { text: i.name }), h('span', { class: 'cal-imp-s', text: i.last_error ? `⚠ ${i.last_error}` : `${i.event_count} events · updated ${ago(i.last_synced_at)}` })),
          h('div', { class: 'cal-actions' }, refresh, rm)));
      }
      if (imports.list.length < 3) {
        const url = h('input', { class: 'sheet-input', type: 'url', inputmode: 'url', autocomplete: 'off', placeholder: 'https:// or webcal:// calendar link', 'aria-label': 'Calendar link' });
        const name = h('input', { class: 'sheet-input', maxlength: 60, placeholder: 'Name (optional), e.g. Personal', 'aria-label': 'Calendar name' });
        const msg = h('p', { class: 'cal-msg', role: 'alert' });
        const add = h('button', { class: 'cal-btn', type: 'button' }, 'Add calendar');
        add.addEventListener('click', async () => {
          if (!url.value.trim()) { msg.textContent = 'Paste a calendar link first.'; return; }
          add.disabled = true; add.textContent = 'Reading calendar…'; msg.textContent = '';
          try {
            const r = await api('POST', '/api/calendar/imports', { url: url.value.trim(), name: name.value.trim(), timezone: TZ }, 40000);
            say(`Added — ${r.imported} events`); afterImportChange();
          } catch (e) { msg.textContent = e.message; add.disabled = false; add.textContent = 'Add calendar'; }
        });
        kids.push(h('div', { class: 'cal-link', style: 'flex-direction:column' }, url, name), msg, h('div', { class: 'cal-actions' }, add),
          h('p', { class: 'cal-small', text: "iCloud: Calendar app → ⓘ next to the calendar → turn on Public Calendar → copy the link. Google: Settings → your calendar → Secret address in iCal format. Events saved only on your phone can't be read by a web app — share the iCloud or Google calendar they live in instead." }));
      }
    }
    elImportCard.replaceChildren(...kids);
  }

  // ── public entry point (called when the tab opens) ────────────────────────
  renderPlanCard();
  renderImportCard();
  let feedLoaded = false;
  window.CorePACalendar = {
    open() {
      if (!feedLoaded) { feedLoaded = true; loadFeed(); loadImports(); }
      if (state.status === 'idle' || Date.now() - state.loadedAt > 60000) load({ silent: state.status === 'ready' });
      else render();
    },
    refresh() { load({ silent: true }); },
  };
  render();
})();