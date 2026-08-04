// ============================================================
//  Practice mode — one question at a time, adaptively scheduled
//  - Question banks live in tests/<deck>.json (see README)
//  - Per-question performance is kept in localStorage and decides
//    how often a question comes back (Leitner-style boxes)
//  - "Mastered after N in a row" is configurable per deck (2–6)
// ============================================================

const STORE_VERSION = 1;
const DEFAULT_MASTERY = 2;     // two clean answers in a row
const NEW_WEIGHT = 6;          // never-seen questions

let els = null;                // { scrollArea, pageList, sidebar }
let decks = [];                // [{ id, title, file }]
let deck = null;               // the loaded bank
let store = null;              // persisted per deck
let session = null;            // resets on every mount
let current = null;            // the question on screen
let view = null;               // its renderer handle
let graded = null;             // { verdict } once the answer is in
let keyHandler = null;
let mounted = false;
let deckToken = 0;             // guards against a slow deck load landing too late
let onDeckChange = null;

// Text inside the question card follows the deck's language ("lang" in the
// bank, default en); the surrounding app chrome stays English.
const STR = {
  en: {
    check: 'Check', next: 'Next question', skip: 'Skip', reveal: 'Show answer',
    grade: 'Grade yourself',
    hadIt: '1 · I knew it', partly: '2 · Almost', missed: '3 · No',
    selectAll: 'Select all that apply.', typeAnswer: 'Type your answer…',
    bucketHint: 'Put every item into the bucket it belongs to.',
    flashHint: 'Say it out loud or write it down, then reveal.',
    assign: '— choose —', correct: 'Correct', partial: 'Partly correct', wrong: 'Not quite',
    accepted: 'Accepted:',
    correctPairs: 'Correct pairing:',
    correctOrder: 'Correct order:',
    boxTo: (b, t) => `Leitner box → ${b}/${t}`,
    boxReset: 'back to box 0',
    kbdCheck: 'digits pick · enter checks', kbdNext: 'enter · next',
    types: {
      mc: 'single choice', multi: 'multiple choice', text: 'free text',
      cloze: 'fill in the gaps', order: 'ordering', match: 'matching',
      bucket: 'sort into buckets', flash: 'flashcard',
    },
  },
  de: {
    check: 'Prüfen', next: 'Nächste Frage', skip: 'Überspringen', reveal: 'Antwort zeigen',
    grade: 'Selbst bewerten',
    hadIt: '1 · Gewusst', partly: '2 · Fast', missed: '3 · Nicht gewusst',
    selectAll: 'Mehrfachauswahl — alles Zutreffende anklicken.', typeAnswer: 'Antwort eingeben…',
    bucketHint: 'Jeden Eintrag der Gruppe zuordnen, in die er gehört.',
    flashHint: 'Erst laut sagen oder aufschreiben, dann aufdecken.',
    assign: '— zuordnen —', correct: 'Richtig', partial: 'Teilweise richtig', wrong: 'Leider nicht',
    accepted: 'Akzeptiert:',
    correctPairs: 'Richtige Zuordnung:',
    correctOrder: 'Richtige Reihenfolge:',
    boxTo: (b, t) => `Leitner-Box → ${b}/${t}`,
    boxReset: 'zurück auf Box 0',
    kbdCheck: 'Ziffern wählen · Enter prüft', kbdNext: 'Enter · weiter',
    types: {
      mc: 'Einfachauswahl', multi: 'Mehrfachauswahl', text: 'Freitext',
      cloze: 'Lückentext', order: 'Reihenfolge', match: 'Zuordnung',
      bucket: 'Gruppieren', flash: 'Karteikarte',
    },
  },
};
function t(key) {
  const table = STR[(deck && deck.lang) || 'en'] || STR.en;
  return table[key] !== undefined ? table[key] : STR.en[key];
}

// ------------------------------------------------------------
//  Mount / unmount
// ------------------------------------------------------------
export async function mountPractice(ctx) {
  els = ctx;
  decks = ctx.decks || [];
  onDeckChange = ctx.onDeck || null;
  mounted = true;
  document.body.dataset.view = 'practice';

  if (!decks.length) {
    els.sidebar.innerHTML = '';
    els.pageList.innerHTML = `<p class="state-msg">No test decks defined in
      <code>courses.json</code> yet.</p>`;
    return;
  }

  const saved = localStorage.getItem('cb:practice:deck');
  const wanted = [ctx.startDeck, saved].find(id => decks.some(d => d.id === id));
  await openDeck(wanted || decks[0].id);

  keyHandler = onKey;
  document.addEventListener('keydown', keyHandler);
}

export function unmountPractice() {
  mounted = false;
  delete document.body.dataset.view;
  if (keyHandler) document.removeEventListener('keydown', keyHandler);
  keyHandler = null;
  current = null;
  view = null;
  graded = null;
}

export function currentDeckId() {
  return deck ? deck.id : null;
}

// Section search in app.js also offers questions from the open deck.
export function searchDeck(needle) {
  if (!deck || !needle) return [];
  const out = [];
  for (const q of deck.questions) {
    const text = stripTags(q.q);
    if (text.toLowerCase().includes(needle)) {
      out.push({ id: q.id, title: text.slice(0, 70), snippet: stripTags(q.why || '').slice(0, 120) + ' …' });
    }
  }
  return out.slice(0, 6);
}

async function openDeck(deckId) {
  const meta = decks.find(d => d.id === deckId);
  const token = ++deckToken;
  try { localStorage.setItem('cb:practice:deck', deckId); } catch (_) { }

  els.pageList.innerHTML = `<p class="state-msg">Loading questions…</p>`;
  let loaded;
  try {
    const res = await fetch(meta.file, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    loaded = await res.json();
  } catch (err) {
    if (!mounted || token !== deckToken) return;
    els.pageList.innerHTML = `<p class="state-msg">Could not load
      <code>${meta.file}</code> — ${err.message}</p>`;
    return;
  }
  // The user may have left the practice tab (or picked another deck) meanwhile.
  if (!mounted || token !== deckToken) return;
  deck = loaded;

  deck.id = deck.id || deckId;
  loadStore();
  session = { shown: 0, right: 0, streak: 0, best: 0, hist: [] };
  buildFrame();
  nextQuestion();
  if (onDeckChange) onDeckChange(deck.id);
}

// ------------------------------------------------------------
//  Persistence
// ------------------------------------------------------------
function storeKey() { return `cb:practice:v${STORE_VERSION}:${deck.id}`; }

function loadStore() {
  const allTopics = deck.topics.map(t => t.id);
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(storeKey()) || 'null'); } catch (_) { }
  store = {
    stats: (saved && saved.stats) || {},
    tick: (saved && saved.tick) || 0,
    topics: (saved && saved.topics) || allTopics,
    focus: (saved && saved.focus) || false,
    answered: (saved && saved.answered) || 0,
    hidden: (saved && saved.hidden) || [],   // retired questions
    mastery: clampMastery((saved && saved.mastery) || DEFAULT_MASTERY),
  };
  // Drop topics that no longer exist.
  store.topics = store.topics.filter(t => allTopics.includes(t));
  // Drop retired ids that are no longer in the bank.
  const known = new Set(deck.questions.map(q => q.id));
  store.hidden = store.hidden.filter(id => known.has(id));
}

function saveStore() {
  try { localStorage.setItem(storeKey(), JSON.stringify(store)); } catch (_) { }
}

function statOf(id) { return store.stats[id] || null; }
function clampMastery(v) { return Math.max(2, Math.min(6, Number(v) || DEFAULT_MASTERY)); }
function mastery() { return store.mastery; }
function maxBox() { return mastery() + 2; }
function isMastered(s) { return !!s && s.box >= mastery(); }

// ------------------------------------------------------------
//  Scheduling — problem questions come back sooner
// ------------------------------------------------------------
// Boxes 0/1 (missed, or not yet confirmed) stay hot; from there the weight
// collapses geometrically, so a finished question all but disappears — the
// thin trickle that is left is what catches mastery that has decayed.
function boxWeight(box) {
  if (box <= 0) return 12;
  if (box === 1) return 7;
  return 0.05 * Math.pow(0.3, box - 2);
}

function activePool() {
  const on = new Set(store.topics);
  const hidden = new Set(store.hidden);
  let qs = deck.questions.filter(q => on.has(q.topic) && !hidden.has(q.id));
  if (store.focus) {
    // Everything still in the low boxes, plus anything missed more often
    // than hit — that is the "trouble" set.
    const trouble = qs.filter(q => {
      const s = statOf(q.id);
      return !s || s.box <= 1 || s.w > s.r;
    });
    if (trouble.length) return trouble;
  }
  return qs;
}

function pickNext(pool) {
  if (!pool.length) return null;
  if (pool.length === 1) return pool[0];

  // Don't repeat anything from the last few questions. The window follows the
  // count of *unfinished* questions, not the whole pool: near the end only a
  // handful are left, and suppressing all of them would hand the draw back to
  // the mastered pile — exactly what the low box weights are there to prevent.
  const unfinished = pool.reduce((n, q) => n + (isMastered(statOf(q.id)) ? 0 : 1), 0);
  const cooldown = Math.min(8, Math.max(1, Math.floor(Math.max(unfinished, 2) / 2)));

  const weights = pool.map(q => {
    const s = statOf(q.id);
    let w = s ? boxWeight(Math.min(s.box, maxBox())) : NEW_WEIGHT;
    // A question missed repeatedly stays hot even after a lucky hit.
    if (s && s.n >= 2) w *= 1 + (s.w / s.n);
    if (s && store.tick - s.last <= cooldown) w *= 0.04;
    if (current && q.id === current.id) w *= 0.001;
    return w;
  });

  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

// verdict: 'right' | 'partial' | 'wrong'
function record(q, verdict) {
  const s = store.stats[q.id] || (store.stats[q.id] = { n: 0, r: 0, w: 0, box: 0, last: -99 });
  store.tick++;
  store.answered++;
  s.n++;
  s.last = store.tick;
  s.ts = Date.now();

  if (verdict === 'right') { s.r++; s.box = Math.min(maxBox(), s.box + 1); }
  else if (verdict === 'partial') { s.w++; s.box = Math.max(0, s.box - 1); }
  else { s.w++; s.box = 0; }   // a miss drops it straight back to the hottest box

  session.shown++;
  if (verdict === 'right') {
    session.right++;
    session.streak++;
    session.best = Math.max(session.best, session.streak);
  } else {
    if (verdict === 'partial') session.right += 0.5;
    session.streak = 0;
  }
  session.hist.push(verdict);
  if (session.hist.length > 40) session.hist.shift();

  saveStore();
  paintStatus();
  paintSidebar();
  return s;
}

// ------------------------------------------------------------
//  Frame (status bar + stage + sidebar)
// ------------------------------------------------------------
function buildFrame() {
  els.pageList.innerHTML = `
    <div class="pr">
      <div class="pr-bar" id="pr-bar"></div>
      <div id="pr-stage"></div>
    </div>`;
  paintStatus();
  paintSidebar();
}

function paintStatus() {
  const bar = document.getElementById('pr-bar');
  if (!bar) return;
  const pool = activePool();
  const visible = deck.questions.filter(q => !store.hidden.includes(q.id));
  const mastered = visible.filter(q => isMastered(statOf(q.id))).length;
  const seen = visible.filter(q => statOf(q.id)).length;
  const acc = session.shown ? Math.round(100 * session.right / session.shown) + '%' : '—';

  bar.innerHTML =
    `<span>pool <b>${pool.length}</b></span>` +
    `<span>mastered <b class="ok">${mastered}</b></span>` +
    `<span>seen <b>${seen}</b></span>` +
    `<span>accuracy <b>${acc}</b></span>` +
    `<span>streak <b>${session.streak}</b></span>` +
    `<span class="pr-hist">${session.hist.slice(-14)
      .map(v => `<i class="pr-dot ${v}"></i>`).join('')}</span>`;
}

function paintSidebar() {
  const totals = topicTotals();
  const allOn = store.topics.length === deck.topics.length;

  els.sidebar.innerHTML = `
    <div class="pr-side">
      ${decks.length > 1 ? `
        <div>
          <p class="side-label">Deck</p>
          <select class="pr-deck" id="pr-deck">
            ${decks.map(d => `<option value="${escapeAttr(d.id)}"${d.id === deck.id ? ' selected' : ''}>${escapeHtml(d.title)}</option>`).join('')}
          </select>
        </div>` : `
        <div><p class="side-label">Deck</p><div class="pr-note">${escapeHtml(deck.title || deck.id)}</div></div>`}

      <div>
        <div class="pr-side-head">
          <p class="side-label">Topics</p>
          <button class="pr-link" id="pr-alltopics" type="button">${allOn ? 'none' : 'all'}</button>
        </div>
        <div class="pr-topics">
          ${deck.topics.map(topic => {
            const d = totals[topic.id];
            const pct = d.total ? Math.round(100 * d.mastered / d.total) : 0;
            const on = store.topics.includes(topic.id);
            return `
              <button class="pr-topic${on ? ' on' : ''}" data-topic="${escapeAttr(topic.id)}" type="button">
                <span class="pr-topic-main">
                  <span class="pr-tick">${on ? '✓' : ''}</span>
                  <span class="pr-topic-label">${escapeHtml(topic.label)}</span>
                </span>
                <span class="pr-topic-meta">
                  <span class="pr-meter"><i style="width:${pct}%"></i></span>
                  <span class="pr-count">${d.mastered}/${d.total}</span>
                </span>
              </button>`;
          }).join('')}
        </div>
      </div>

      <div>
        <div class="pr-side-head">
          <p class="side-label">Mastered after</p>
          <span class="pr-focus-state">${mastery()} in a row</span>
        </div>
        <div class="pr-steps">
          ${[2, 3, 4, 5, 6].map(v =>
            `<button class="pr-step${v === mastery() ? ' on' : ''}" data-mastery="${v}" type="button">${v}</button>`).join('')}
        </div>
      </div>

      <div style="display:flex;flex-direction:column;gap:10px">
        <button class="pr-focus${store.focus ? ' on' : ''}" id="pr-focus" type="button">
          <span class="pr-focus-main"><span class="pr-focus-dot"></span>Focus on trouble spots</span>
          <span class="pr-focus-state">${store.focus ? 'on' : 'off'}</span>
        </button>
        <p class="pr-note">Narrows the pool to questions in box 0–1 and anything you
          got wrong more often than right. They come back sooner either way.</p>
      </div>

      ${store.hidden.length ? `
        <div>
          <p class="side-label">Retired · ${store.hidden.length}</p>
          <div class="pr-retired">
            ${store.hidden.map(id => {
              const q = deck.questions.find(x => x.id === id);
              return `<div class="pr-retired-row">
                <span>${escapeHtml(stripTags(q ? q.q : id).slice(0, 46))}</span>
                <button class="pr-link" data-restore="${escapeAttr(id)}" type="button">restore</button>
              </div>`;
            }).join('')}
          </div>
        </div>` : ''}

      <button class="pr-reset" id="pr-reset" type="button">Reset progress for this deck</button>
      <p class="pr-note">${store.answered} answers recorded on this device.</p>
    </div>`;

  const deckSel = document.getElementById('pr-deck');
  if (deckSel) deckSel.addEventListener('change', () => openDeck(deckSel.value));

  els.sidebar.querySelectorAll('[data-topic]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.topic;
      const on = new Set(store.topics);
      on.has(id) ? on.delete(id) : on.add(id);
      store.topics = deck.topics.map(t => t.id).filter(t => on.has(t));
      afterFilterChange();
    });
  });

  document.getElementById('pr-alltopics').addEventListener('click', () => {
    store.topics = allOn ? [] : deck.topics.map(t => t.id);
    afterFilterChange();
  });

  els.sidebar.querySelectorAll('[data-mastery]').forEach(btn => {
    btn.addEventListener('click', () => {
      store.mastery = clampMastery(+btn.dataset.mastery);
      saveStore();
      paintStatus();
      paintSidebar();
      if (current && !graded) renderCard(current);   // the box pips changed length
    });
  });

  document.getElementById('pr-focus').addEventListener('click', () => {
    store.focus = !store.focus;
    afterFilterChange();
  });

  els.sidebar.querySelectorAll('[data-restore]').forEach(btn => {
    btn.addEventListener('click', () => {
      store.hidden = store.hidden.filter(id => id !== btn.dataset.restore);
      afterFilterChange();
    });
  });

  document.getElementById('pr-reset').addEventListener('click', () => {
    if (!confirm('Delete all recorded answers for this deck?')) return;
    store.stats = {}; store.tick = 0; store.answered = 0;
    session = { shown: 0, right: 0, streak: 0, best: 0, hist: [] };
    afterFilterChange();
  });
}

function afterFilterChange() {
  saveStore();
  paintStatus();
  paintSidebar();
  nextQuestion();
}

function topicTotals() {
  const out = {};
  const hidden = new Set(store.hidden);
  deck.topics.forEach(topic => { out[topic.id] = { total: 0, mastered: 0, seen: 0 }; });
  deck.questions.forEach(q => {
    const d = out[q.topic];
    if (!d || hidden.has(q.id)) return;   // retired questions drop out of the counts
    d.total++;
    const s = statOf(q.id);
    if (s) { d.seen++; if (isMastered(s)) d.mastered++; }
  });
  return out;
}

// ------------------------------------------------------------
//  The question card
// ------------------------------------------------------------
function nextQuestion() {
  const stage = document.getElementById('pr-stage');
  if (!stage) return;
  graded = null;
  const q = pickNext(activePool());
  current = q;

  if (!q) {
    view = null;
    stage.innerHTML = `
      <div class="pr-empty">
        <div class="pr-empty-title">Nothing in the pool</div>
        <div class="pr-empty-body">Every question is filtered out, retired, or the deck is
          empty. Widen the topic filters in the sidebar, turn off focus mode, or restore
          retired questions.</div>
      </div>`;
    return;
  }
  renderCard(q);
}

function renderCard(q) {
  const stage = document.getElementById('pr-stage');
  if (!stage) return;
  const s = statOf(q.id);
  const box = s ? Math.min(s.box, mastery()) : 0;
  const topic = deck.topics.find(x => x.id === q.topic);
  const types = (STR[(deck && deck.lang) || 'en'] || STR.en).types;

  const card = el('div', 'pr-card');

  const head = el('div', 'pr-head');
  head.appendChild(el('span', 'pr-topic-tag', escapeHtml(topic ? topic.label : q.topic)));
  if (q.src) head.appendChild(el('span', 'pr-src', escapeHtml(q.src)));
  if (q.flag) head.appendChild(el('span', 'pr-flag', escapeHtml(q.flag)));
  head.appendChild(el('span', 'pr-type', escapeHtml(types[q.type] || q.type)));

  const pips = el('span', 'pr-boxes');
  pips.title = 'Leitner box';
  for (let i = 0; i < mastery(); i++) {
    pips.appendChild(el('span', 'pr-pip' + (i < box ? ' on' : '')));
  }
  head.appendChild(pips);

  const retire = el('button', 'pr-retire', 'retire');
  retire.type = 'button';
  retire.title = 'Retire this question — it stops appearing until you restore it';
  retire.addEventListener('click', () => {
    if (!store.hidden.includes(q.id)) store.hidden.push(q.id);
    afterFilterChange();
  });
  head.appendChild(retire);
  card.appendChild(head);

  const question = el('h2', 'pr-q', q.q);
  card.appendChild(question);

  const body = el('div', 'pr-body');
  card.appendChild(body);
  // The verdict sits *below* the buttons: revealing the answer then grows the
  // card downwards without moving the widget or the button you just clicked.
  const actions = el('div', 'pr-actions');
  card.appendChild(actions);
  const verdict = el('div', 'pr-verdict');
  verdict.hidden = true;
  card.appendChild(verdict);

  const ctx = { q, card, body, verdict, actions };
  // For free text the hint is the input's placeholder instead.
  if (q.hint && q.type !== 'text') body.appendChild(el('p', 'pr-hint', escapeHtml(q.hint)));

  const renderers = {
    mc: renderChoice, multi: renderChoice, text: renderText, order: renderOrder,
    match: renderMatch, cloze: renderCloze, bucket: renderBucket, flash: renderFlash,
  };
  view = (renderers[q.type] || renderUnknown)(ctx) || {};
  view.ctx = ctx;

  paintActions(ctx);
  stage.innerHTML = '';
  stage.appendChild(card);
  if (view.focus) view.focus();
}

function paintActions(ctx) {
  ctx.actions.innerHTML = '';
  const primary = el('button', 'pr-btn', primaryLabel(ctx.q));
  primary.type = 'button';
  if (graded) primary.classList.add('filled');
  primary.addEventListener('click', () => runPrimary());
  ctx.actions.appendChild(primary);

  if (!graded) {
    const skip = el('button', 'pr-btn ghost', t('skip'));
    skip.type = 'button';
    skip.addEventListener('click', nextQuestion);
    ctx.actions.appendChild(skip);
  }
  ctx.actions.appendChild(el('span', 'pr-kbd', graded ? t('kbdNext') : t('kbdCheck')));
}

function primaryLabel(q) {
  if (graded) return t('next');
  if (q.type === 'flash') return view && view.revealed ? t('grade') : t('reveal');
  return t('check');
}

function runPrimary() {
  if (!current) return;
  if (graded) return nextQuestion();
  if (!view) return;
  if (current.type === 'flash' && !view.revealed) return view.reveal();
  if (view.check) view.check();
}

// Called by every renderer once the answer is in.
function conclude(ctx, verdict, extra) {
  if (graded) return;
  graded = { verdict };
  const before = statOf(ctx.q.id);
  const beforeBox = before ? before.box : 0;
  const after = record(ctx.q, verdict);

  const label = verdict === 'right' ? t('correct') : verdict === 'partial' ? t('partial') : t('wrong');
  const note = after.box === 0 && beforeBox !== 0
    ? t('boxReset')
    : t('boxTo')(Math.min(after.box, mastery()), mastery());

  ctx.verdict.className = 'pr-verdict ' + verdict;
  ctx.verdict.hidden = false;
  ctx.verdict.innerHTML =
    `<div class="pr-verdict-head"><span class="label">${escapeHtml(label)}</span>` +
    `<span class="note">${escapeHtml(note)}</span></div>` +
    `<div class="pr-why">${extra ? extra + ' ' : ''}${ctx.q.why || ''}</div>`;

  ctx.body.querySelectorAll('button, input, select').forEach(n => { n.disabled = true; });
  paintActions(ctx);
  const primary = ctx.actions.querySelector('.pr-btn');
  if (primary) primary.focus();
}

// ---------- mc / multi ----------
function renderChoice(ctx) {
  const { q, body } = ctx;
  const multi = q.type === 'multi';
  const wrap = el('div', 'pr-opts');
  const order = shuffle(q.options.map((_, k) => k));

  order.forEach((k, pos) => {
    const b = el('button', 'pr-opt' + (multi ? ' multi' : ''));
    b.type = 'button';
    b.dataset.k = k;
    b.dataset.sel = '0';
    b.innerHTML =
      `<span class="pr-key">${pos + 1}</span>` +
      `<span class="pr-opt-label">${q.options[k]}</span>` +
      `<span class="pr-mark"></span>`;
    b.addEventListener('click', () => {
      if (!multi) wrap.querySelectorAll('.pr-opt').forEach(o => { o.dataset.sel = '0'; });
      b.dataset.sel = b.dataset.sel === '1' ? '0' : '1';
    });
    wrap.appendChild(b);
  });
  body.appendChild(wrap);
  if (multi) body.appendChild(el('p', 'pr-hint', t('selectAll')));

  return {
    keys: (n) => { const b = wrap.children[n - 1]; if (b) b.click(); },
    check: () => {
      const sel = [];
      wrap.querySelectorAll('.pr-opt').forEach(o => { if (o.dataset.sel === '1') sel.push(+o.dataset.k); });
      const want = multi ? q.correct.slice().sort((a, b) => a - b) : [q.correct];
      const gaveUp = !sel.length;
      const ok = !gaveUp && sel.slice().sort((a, b) => a - b).join(',') === want.join(',');
      const partial = !ok && !gaveUp && multi &&
        sel.every(i => want.includes(i)) && sel.length < want.length;

      wrap.querySelectorAll('.pr-opt').forEach(o => {
        const k = +o.dataset.k;
        const picked = o.dataset.sel === '1';
        const mark = o.querySelector('.pr-mark');
        if (want.includes(k)) {
          o.classList.add('mark-ok');
          mark.textContent = picked ? '✓' : (multi ? 'missed' : 'answer');
        } else if (picked) {
          o.classList.add('mark-bad');
          mark.textContent = '✕';
        }
      });
      conclude(ctx, ok ? 'right' : partial ? 'partial' : 'wrong', '');
    },
  };
}

// ---------- text ----------
function renderText(ctx) {
  const { q, body } = ctx;
  const inp = el('input', 'pr-input');
  inp.type = 'text';
  inp.setAttribute('autocomplete', 'off');
  inp.placeholder = q.hint || t('typeAnswer');
  body.appendChild(inp);

  return {
    focus: () => inp.focus(),
    check: () => {
      const v = norm(inp.value);
      const ok = !!v && q.accept.some(a => norm(a) === v);
      inp.classList.add(ok ? 'mark-ok' : 'mark-bad');
      // Goes into the verdict rather than under the input, so the card does
      // not change height where the answer widget is.
      const extra = ok ? '' : `${t('accepted')} ${escapeHtml(q.accept.join(' · '))}.`;
      conclude(ctx, ok ? 'right' : 'wrong', extra);
    },
  };
}

// ---------- cloze ----------
function renderCloze(ctx) {
  const { q, body } = ctx;
  const wrap = el('div', 'pr-cloze');
  const parts = q.text.split('{{}}');
  parts.forEach((part, i) => {
    wrap.appendChild(el('span', null, part));
    if (i < q.gaps.length) {
      const inp = el('input', 'pr-input inline');
      inp.type = 'text';
      inp.size = q.gaps[i].size || 10;
      inp.dataset.g = i;
      inp.setAttribute('autocomplete', 'off');
      wrap.appendChild(inp);
    }
  });
  body.appendChild(wrap);

  return {
    focus: () => { const first = wrap.querySelector('input'); if (first) first.focus(); },
    check: () => {
      const inputs = [...wrap.querySelectorAll('input')];
      let hits = 0;
      inputs.forEach(inp => {
        const g = q.gaps[+inp.dataset.g];
        const ok = g.accept.some(a => norm(a) === norm(inp.value)) && !!inp.value.trim();
        inp.classList.add(ok ? 'mark-ok' : 'mark-bad');
        if (!ok) inp.value = g.show || g.accept[0];
        else hits++;
      });
      conclude(ctx, hits === q.gaps.length ? 'right' : hits > 0 ? 'partial' : 'wrong', '');
    },
  };
}

// ---------- order ----------
function renderOrder(ctx) {
  const { q, body } = ctx;
  const wrap = el('div', 'pr-rows');
  let cur = shuffle(q.items.map((_, k) => k));
  if (cur.every((k, i) => k === i)) cur.reverse();
  let locked = false;

  function paint() {
    wrap.innerHTML = '';
    cur.forEach((k, pos) => {
      const row = el('div', 'pr-row');
      row.dataset.k = k;
      row.appendChild(el('span', 'pr-n', String(pos + 1)));
      row.appendChild(el('span', 'pr-label', q.items[k]));
      const mark = el('span', 'pr-mark');
      if (locked) {
        row.classList.add(k === pos ? 'mark-ok' : 'mark-bad');
        mark.textContent = k === pos ? '✓' : '✕';
      }
      row.appendChild(mark);

      const up = el('button', 'pr-move', '↑');
      const down = el('button', 'pr-move', '↓');
      up.type = down.type = 'button';
      up.disabled = locked || pos === 0;
      down.disabled = locked || pos === cur.length - 1;
      up.addEventListener('click', () => swap(pos, pos - 1));
      down.addEventListener('click', () => swap(pos, pos + 1));
      row.appendChild(up);
      row.appendChild(down);
      wrap.appendChild(row);
    });
  }
  function swap(a, b) { const x = cur[a]; cur[a] = cur[b]; cur[b] = x; paint(); }
  paint();
  body.appendChild(wrap);

  return {
    check: () => {
      const hits = cur.filter((k, pos) => k === pos).length;
      const ok = hits === q.items.length;
      locked = true;
      paint();
      // The rows keep the user's order with per-position marks; the correct
      // sequence goes into the feedback so both are visible side by side.
      const extra = ok ? '' :
        `${t('correctOrder')} ${q.items.map((it, k) => `${k + 1}. ${stripTags(it)}`).join(' · ')}.`;
      conclude(ctx, ok ? 'right' : hits > 1 ? 'partial' : 'wrong', extra);
    },
  };
}

// ---------- match ----------
function renderMatch(ctx) {
  const { q, body } = ctx;
  const wrap = el('div', 'pr-rows');
  const rights = shuffle(q.pairs.map(p => p[1]));
  q.pairs.forEach((p, k) => {
    const row = el('div', 'pr-row');
    row.appendChild(el('span', 'pr-left', p[0]));
    const sel = document.createElement('select');
    sel.dataset.k = k;
    sel.appendChild(new Option(t('assign'), ''));
    rights.forEach(r => sel.appendChild(new Option(stripTags(r), r)));
    row.appendChild(sel);
    row.appendChild(el('span', 'pr-mark'));
    wrap.appendChild(row);
  });
  body.appendChild(wrap);

  return {
    check: () => {
      let hits = 0;
      wrap.querySelectorAll('.pr-row').forEach(row => {
        const sel = row.querySelector('select');
        const right = q.pairs[+sel.dataset.k][1];
        const good = sel.value === right;
        row.classList.add(good ? 'mark-ok' : 'mark-bad');
        row.querySelector('.pr-mark').textContent = good ? '✓' : '✕';
        if (good) hits++; else sel.value = right;
      });
      const extra = hits === q.pairs.length ? '' :
        `${t('correctPairs')} ${q.pairs.map(p => `${stripTags(p[0])} → ${stripTags(p[1])}`).join(' · ')}.`;
      conclude(ctx, hits === q.pairs.length ? 'right' : hits > 0 ? 'partial' : 'wrong', extra);
    },
  };
}

// ---------- bucket ----------
function renderBucket(ctx) {
  const { q, body } = ctx;
  // Items are listed bucket by bucket in the JSON — showing them in that order
  // would hand the answer over.
  const order = shuffle(q.items.map((_, i) => i));
  const placed = q.items.map(() => -1);

  body.appendChild(el('p', 'pr-hint', t('bucketHint')));
  const wrap = el('div', 'pr-rows');
  order.forEach(i => {
    const row = el('div', 'pr-row');
    row.dataset.i = i;
    row.appendChild(el('span', 'pr-label', q.items[i][0]));

    const btns = el('span', 'pr-bucket-btns');
    q.buckets.forEach((label, bi) => {
      const b = el('button', 'pr-bucket-btn', escapeHtml(label));
      b.type = 'button';
      b.dataset.b = bi;
      b.addEventListener('click', () => {
        placed[i] = bi;
        btns.querySelectorAll('.pr-bucket-btn').forEach(x => { x.dataset.sel = x === b ? '1' : '0'; });
      });
      btns.appendChild(b);
    });
    row.appendChild(btns);
    row.appendChild(el('span', 'pr-mark'));
    wrap.appendChild(row);
  });
  body.appendChild(wrap);

  return {
    check: () => {
      let hits = 0;
      wrap.querySelectorAll('.pr-row').forEach(row => {
        const i = +row.dataset.i;
        const truth = q.items[i][1];
        const ok = placed[i] === truth;
        row.classList.add(ok ? 'mark-ok' : 'mark-bad');
        row.querySelector('.pr-mark').textContent = ok ? '✓' : '✕';
        // Mark where it belonged, so a miss shows the answer in place.
        const right = row.querySelector(`.pr-bucket-btn[data-b="${truth}"]`);
        if (right) right.classList.add('mark-ok');
        if (ok) hits++;
      });
      conclude(ctx, hits === q.items.length ? 'right' : hits >= q.items.length / 2 ? 'partial' : 'wrong', '');
    },
  };
}

// ---------- flash (self-graded recall) ----------
function renderFlash(ctx) {
  const { q, body } = ctx;
  body.appendChild(el('p', 'pr-hint', t('flashHint')));

  // The answer occupies its space immediately, veiled behind the reveal button.
  const slot = el('div', 'pr-flash');
  const answer = el('div', 'pr-answer veiled', q.answer);
  slot.appendChild(answer);

  const reveal = el('button', 'pr-reveal', 'Show answer  ·  space');
  reveal.type = 'button';
  slot.appendChild(reveal);
  body.appendChild(slot);

  const grades = el('div', 'pr-grades veiled');
  [[t('hadIt'), 'right'], [t('partly'), 'partial'], [t('missed'), 'wrong']]
    .forEach(([label, verdict]) => {
      const b = el('button', 'pr-grade', label);
      b.type = 'button';
      b.addEventListener('click', () => conclude(ctx, verdict, ''));
      grades.appendChild(b);
    });
  body.appendChild(grades);

  const handle = {
    revealed: false,
    reveal: () => {
      handle.revealed = true;
      reveal.remove();
      answer.classList.remove('veiled');
      grades.classList.remove('veiled');
      paintActions(ctx);
    },
    keys: (n) => {
      if (!handle.revealed) return;
      const b = grades.children[n - 1];
      if (b) b.click();
    },
  };
  reveal.addEventListener('click', handle.reveal);
  return handle;
}

function renderUnknown(ctx) {
  ctx.body.appendChild(el('p', 'pr-hint', `Unknown question type “${escapeHtml(ctx.q.type)}”.`));
  return { check: () => conclude(ctx, 'wrong', '') };
}

// ------------------------------------------------------------
//  Keyboard
// ------------------------------------------------------------
function onKey(e) {
  if (!mounted || !current) return;
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'select' || tag === 'textarea';

  if (e.key === 'Enter') {
    e.preventDefault();
    runPrimary();
    return;
  }
  if (typing) return;

  if (e.key === ' ' && current.type === 'flash' && view && !view.revealed) {
    e.preventDefault();
    view.reveal();
    return;
  }
  if (/^[1-9]$/.test(e.key) && !graded && view && view.keys) {
    e.preventDefault();
    view.keys(+e.key);
  }
}

// ------------------------------------------------------------
//  Helpers
// ------------------------------------------------------------
function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}
function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function stripTags(s) {
  return String(s).replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
function norm(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!?]+$/, '')
    .replace(/[“”"']/g, '')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
}
