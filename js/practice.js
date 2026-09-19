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

// The list view: the whole deck at a glance. Browsing it never records an
// answer, so reading up on a question does not disturb the schedule.
let mode = 'drill';            // 'drill' (one question at a time) or 'list'
let listFilter = '';           // free-text filter over question, answer, source
let listStatus = 'all';        // all | unseen | learning | mastered | retired
let openItems = new Set();     // ids of the rows expanded in the list
const listText = new Map();    // id -> lowercased haystack, built on demand

// Text inside the question card follows the deck's language ("lang" in the
// bank, default en); the surrounding app chrome stays English.
const STR = {
  en: {
    check: 'Check', next: 'Next question', skip: 'Skip', reveal: 'Show answer',
    grade: 'Grade yourself',
    hadIt: '1 · I knew it', partly: '2 · Almost', missed: '3 · No',
    selectAll: 'Select all that apply.', typeAnswer: 'Type your answer…',
    listHint: 'One entry per box — the order does not matter.', missing: 'Still missing:',
    bucketHint: 'Put every item into the bucket it belongs to.',
    flashHint: 'Say it out loud or write it down, then reveal.',
    correct: 'Correct', partial: 'Partly correct', wrong: 'Not quite',
    answers: 'Answers',
    matchHint: 'Drag each answer onto the line it belongs to — or tap one, then tap its line.',
    accepted: 'Accepted:',
    correctPairs: 'Correct pairing:',
    correctOrder: 'Correct order:',
    boxTo: (b, t) => `Leitner box → ${b}/${t}`,
    boxReset: 'back to box 0',
    kbdCheck: 'digits pick · enter checks', kbdNext: 'enter · next',
    srcPages: (n) => n.length > 1 ? `Show source pages ${n.join(', ')}` : `Show source page ${n[0]}`,
    srcPage: (n) => `Page ${n}`,
    srcNote: 'The highlight is placed automatically and is not always exact.',
    modeDrill: 'Practice', modeList: 'All questions',
    filterQ: 'Filter questions…',
    statusAll: 'all', statusUnseen: 'unseen', statusLearning: 'learning',
    statusMastered: 'mastered', statusRetired: 'retired',
    expandAll: 'expand all', collapseAll: 'collapse all',
    answerLabel: 'Answer', whyLabel: 'Why',
    practiceThis: 'Practice this one', retire: 'retire', restore: 'restore',
    noMatches: 'No question matches the filter.',
    showing: (n, total) => `${n} of ${total} questions`,
    tally: (r, n) => `${r}/${n} right`,
    notSeen: 'not answered yet',
    types: {
      mc: 'single choice', multi: 'multiple choice', text: 'free text',
      cloze: 'fill in the gaps', order: 'ordering', match: 'matching',
      bucket: 'sort into buckets', flash: 'flashcard', list: 'name them all',
    },
  },
  de: {
    check: 'Prüfen', next: 'Nächste Frage', skip: 'Überspringen', reveal: 'Antwort zeigen',
    grade: 'Selbst bewerten',
    hadIt: '1 · Gewusst', partly: '2 · Fast', missed: '3 · Nicht gewusst',
    selectAll: 'Mehrfachauswahl — alles Zutreffende anklicken.', typeAnswer: 'Antwort eingeben…',
    listHint: 'Ein Eintrag pro Feld — die Reihenfolge ist egal.', missing: 'Gefehlt haben:',
    bucketHint: 'Jeden Eintrag der Gruppe zuordnen, in die er gehört.',
    flashHint: 'Erst laut sagen oder aufschreiben, dann aufdecken.',
    correct: 'Richtig', partial: 'Teilweise richtig', wrong: 'Leider nicht',
    answers: 'Antworten',
    matchHint: 'Zieh jede Antwort auf die Zeile, in die sie gehört — oder erst antippen, dann die Zeile antippen.',
    accepted: 'Akzeptiert:',
    correctPairs: 'Richtige Zuordnung:',
    correctOrder: 'Richtige Reihenfolge:',
    boxTo: (b, t) => `Leitner-Box → ${b}/${t}`,
    boxReset: 'zurück auf Box 0',
    kbdCheck: 'Ziffern wählen · Enter prüft', kbdNext: 'Enter · weiter',
    srcPages: (n) => n.length > 1 ? `Skript-Seiten ${n.join(', ')} anzeigen` : `Skript-Seite ${n[0]} anzeigen`,
    srcPage: (n) => `Seite ${n}`,
    srcNote: 'Die Markierung wird automatisch gesetzt und trifft nicht immer exakt.',
    modeDrill: 'Üben', modeList: 'Alle Fragen',
    filterQ: 'Fragen filtern…',
    statusAll: 'alle', statusUnseen: 'neu', statusLearning: 'im Lernen',
    statusMastered: 'sitzt', statusRetired: 'aussortiert',
    expandAll: 'alle aufklappen', collapseAll: 'alle zuklappen',
    answerLabel: 'Antwort', whyLabel: 'Erklärung',
    practiceThis: 'Diese Frage üben', retire: 'aussortieren', restore: 'zurückholen',
    noMatches: 'Keine Frage passt zum Filter.',
    showing: (n, total) => `${n} von ${total} Fragen`,
    tally: (r, n) => `${r}/${n} richtig`,
    notSeen: 'noch nicht beantwortet',
    types: {
      mc: 'Einfachauswahl', multi: 'Mehrfachauswahl', text: 'Freitext',
      cloze: 'Lückentext', order: 'Reihenfolge', match: 'Zuordnung',
      bucket: 'Gruppieren', flash: 'Karteikarte', list: 'Aufzählung',
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

  let savedMode = null;
  try { savedMode = localStorage.getItem('cb:practice:mode'); } catch (_) { }
  mode = normalizeMode(ctx.startMode || savedMode);

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

export function currentMode() {
  return mode;
}

function normalizeMode(m) { return m === 'list' ? 'list' : 'drill'; }

function setMode(next) {
  const m = normalizeMode(next);
  if (m === mode) return;
  mode = m;
  try { localStorage.setItem('cb:practice:mode', mode); } catch (_) { }
  if (deck && onDeckChange) onDeckChange(deck.id, mode);
  paintStatus();
  renderStage();
  els.scrollArea.scrollTop = 0;
}

// Either the drill or the list owns the stage — never both.
function renderStage() {
  if (mode !== 'list') return nextQuestion();
  current = null;
  view = null;
  graded = null;
  renderQuestionList();
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
  // A filter from the deck before it would otherwise hide a deck it was never
  // meant for — most visibly as an empty list right after switching.
  listText.clear();
  openItems.clear();
  listFilter = '';
  listStatus = 'all';
  buildFrame();
  renderStage();
  if (onDeckChange) onDeckChange(deck.id, mode);
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

  // Session figures only mean something while drilling — in the list the deck's
  // own standing is what counts, so accuracy, streak and history drop out.
  bar.innerHTML =
    `<span class="pr-modes">` +
      `<button class="pr-mode${mode === 'drill' ? ' on' : ''}" data-mode="drill" type="button">${escapeHtml(t('modeDrill'))}</button>` +
      `<button class="pr-mode${mode === 'list' ? ' on' : ''}" data-mode="list" type="button">${escapeHtml(t('modeList'))}</button>` +
    `</span>` +
    `<span>pool <b>${pool.length}</b></span>` +
    `<span>mastered <b class="ok">${mastered}</b></span>` +
    `<span>seen <b>${seen}</b></span>` +
    (mode === 'drill'
      ? `<span>accuracy <b>${acc}</b></span>` +
        `<span>streak <b>${session.streak}</b></span>` +
        `<span class="pr-hist">${session.hist.slice(-14)
          .map(v => `<i class="pr-dot ${v}"></i>`).join('')}</span>`
      : '');

  bar.querySelectorAll('[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });
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
  renderStage();
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

  const src = renderSourcePages(q);
  if (src) card.appendChild(src);

  const ctx = { q, card, body, verdict, actions };
  // For free text the hint is the input's placeholder instead.
  if (q.hint && q.type !== 'text') body.appendChild(el('p', 'pr-hint', escapeHtml(q.hint)));

  const renderers = {
    mc: renderChoice, multi: renderChoice, text: renderText, order: renderOrder,
    match: renderMatch, cloze: renderCloze, bucket: renderBucket, flash: renderFlash,
    list: renderList,
  };
  view = (renderers[q.type] || renderUnknown)(ctx) || {};
  view.ctx = ctx;

  paintActions(ctx);
  stage.innerHTML = '';
  stage.appendChild(card);
  if (view.focus) view.focus();
}

// A collapsed link to the exact skript page(s) a question comes from. The markup
// matches the `details.source` blocks in the reading view, so the app-wide
// lightbox opens the page image without any extra wiring.
function renderSourcePages(q) {
  const cfg = deck && deck.source;
  if (!cfg || !cfg.base || !Array.isArray(q.pages) || !q.pages.length) return null;

  const pages = q.pages.filter(n => Number.isInteger(n) && n > 0);
  if (!pages.length) return null;

  const box = el('details', 'source pr-source');
  box.appendChild(el('summary', '', t('srcPages')(pages)));

  const bodyEl = el('div', 'source-body');
  if (cfg.label) bodyEl.appendChild(el('p', 'deck', escapeHtml(cfg.label)));

  // `hl` marks the passage the answer comes from, in percent of the page, so the
  // same numbers work on the thumbnail and on the full-size image.
  const hl = q.hl && Number.isFinite(q.hl.x) ? q.hl : null;
  const rect = hl ? [hl.x, hl.y, hl.w, hl.h].join(',') : '';

  const grid = el('div', 'slide-grid');
  pages.forEach(n => {
    const file = String(n).padStart(cfg.pad || 3, '0') + (cfg.ext || '.jpg');
    const href = cfg.base + file;
    const a = el('a', 'slide');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';

    const shot = el('span', 'slide-shot');
    const img = el('img');
    img.loading = 'lazy';
    img.src = href;
    img.alt = t('srcPage')(n);
    shot.appendChild(img);
    if (hl && hl.page === n) {
      a.dataset.hl = rect;
      const mark = el('span', 'slide-hl');
      mark.style.left = hl.x + '%';
      mark.style.top = hl.y + '%';
      mark.style.width = hl.w + '%';
      mark.style.height = hl.h + '%';
      shot.appendChild(mark);
    }
    a.appendChild(shot);
    a.appendChild(el('span', '', t('srcPage')(n)));
    grid.appendChild(a);
  });
  bodyEl.appendChild(grid);
  if (hl) bodyEl.appendChild(el('p', 'src-note', t('srcNote')));
  box.appendChild(bodyEl);
  return box;
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

// ---------- list (name N things, order does not matter) ----------
function renderList(ctx) {
  const { q, body } = ctx;
  const wrap = el('div', 'pr-list');
  q.answers.forEach((_, i) => {
    const row = el('div', 'pr-list-row');
    row.appendChild(el('span', 'pr-n', String(i + 1)));
    const inp = el('input', 'pr-input');
    inp.type = 'text';
    inp.setAttribute('autocomplete', 'off');
    wrap.appendChild(row);
    row.appendChild(inp);
  });
  body.appendChild(wrap);
  body.appendChild(el('p', 'pr-hint', t('listHint')));

  return {
    focus: () => { const first = wrap.querySelector('input'); if (first) first.focus(); },
    check: () => {
      // Every box is matched against the *set* of wanted answers, and each
      // answer can only be claimed once — so naming the same thing twice
      // scores once, and the order the boxes were filled in is irrelevant.
      const open = q.answers.map((_, k) => k);
      let hits = 0;
      wrap.querySelectorAll('input').forEach(inp => {
        const v = norm(inp.value);
        const at = v ? open.findIndex(k => q.answers[k].accept.some(a => norm(a) === v)) : -1;
        if (at === -1) { inp.classList.add('mark-bad'); return; }
        open.splice(at, 1);
        inp.classList.add('mark-ok');
        hits++;
      });
      const missed = open.map(k => q.answers[k].show || q.answers[k].accept[0]);
      const extra = missed.length ? `${t('missing')} ${escapeHtml(missed.join(' · '))}.` : '';
      conclude(ctx, hits === q.answers.length ? 'right' : hits ? 'partial' : 'wrong', extra);
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
// The answers are chips you drag onto the line they belong to. The drag runs on
// pointer events rather than HTML5 drag-and-drop, so one code path serves mouse,
// pen and touch alike; a tap that never moves picks a chip up instead, which is
// also the route the digit keys take.
function renderMatch(ctx) {
  const { q, body } = ctx;
  const n = q.pairs.length;
  let picked = null;   // chip waiting for a slot (tap-to-place)
  let drag = null;
  let over = null;
  let locked = false;

  body.appendChild(el('p', 'pr-hint', escapeHtml(t('matchHint'))));

  // Loose chips live in the bay; it keeps a minimum height so it stays a drop
  // target once every answer has been placed.
  const pool = el('div', 'pr-pool');
  pool.appendChild(el('span', 'pr-pool-label', escapeHtml(t('answers'))));
  const bay = el('div', 'pr-bay');
  pool.appendChild(bay);
  body.appendChild(pool);

  const wrap = el('div', 'pr-rows');
  const slots = q.pairs.map((p, k) => {
    const row = el('div', 'pr-row match');
    row.appendChild(el('span', 'pr-n', String(k + 1)));
    row.appendChild(el('span', 'pr-left', p[0]));
    const slot = el('div', 'pr-slot');
    row.appendChild(slot);
    row.appendChild(el('span', 'pr-mark'));
    wrap.appendChild(row);
    return slot;
  });
  body.appendChild(wrap);

  // A chip remembers the pair it came from, so grading stays exact even when
  // two pairs happen to share the same right-hand text.
  const chips = shuffle(q.pairs.map((_, j) => j)).map((j, pos) => {
    const chip = el('button', 'pr-chip');
    chip.type = 'button';
    chip.dataset.j = j;
    chip.innerHTML =
      `<span class="pr-key">${pos + 1}</span>` +
      `<span class="pr-chip-label">${q.pairs[j][1]}</span>`;
    chip.addEventListener('pointerdown', onDown);
    chip.addEventListener('pointermove', onMove);
    chip.addEventListener('pointerup', onUp);
    chip.addEventListener('pointercancel', abort);
    bay.appendChild(chip);
    return chip;
  });

  function setPicked(chip) {
    picked = chip || null;
    chips.forEach(c => { c.dataset.picked = c === picked ? '1' : '0'; });
    wrap.dataset.picking = picked ? '1' : '0';
  }

  function place(chip, target) {
    if (target !== bay) {
      const sitting = target.querySelector('.pr-chip');
      if (sitting && sitting !== chip) bay.appendChild(sitting);
    }
    target.appendChild(chip);
    setPicked(null);
  }

  // The whole row counts as a drop zone — the slot alone is a small target on
  // a phone. The ghost is pointer-events:none, so it never occludes the hit test.
  function targetAt(x, y) {
    const at = document.elementFromPoint(x, y);
    if (!at) return null;
    const row = at.closest('.pr-row.match');
    if (row && wrap.contains(row)) return row.querySelector('.pr-slot');
    return at.closest('.pr-pool') ? bay : null;
  }

  function markOver(target) {
    if (over === target) return;
    if (over) over.dataset.over = '0';
    over = target;
    if (over) over.dataset.over = '1';
  }

  function onDown(e) {
    if (locked || (e.button !== undefined && e.button > 0)) return;
    const chip = e.currentTarget;
    const box = chip.getBoundingClientRect();
    drag = {
      chip, id: e.pointerId, moved: false,
      dx: e.clientX - box.left, dy: e.clientY - box.top,
      x0: e.clientX, y0: e.clientY, w: box.width, ghost: null,
    };
    chip.setPointerCapture(e.pointerId);
  }

  function onMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 5) return;
      drag.moved = true;
      setPicked(null);
      drag.ghost = drag.chip.cloneNode(true);
      drag.ghost.className = 'pr-chip pr-ghost';
      drag.ghost.style.width = drag.w + 'px';
      document.body.appendChild(drag.ghost);
      drag.chip.dataset.dragging = '1';
    }
    e.preventDefault();
    drag.ghost.style.transform =
      `translate(${e.clientX - drag.dx}px, ${e.clientY - drag.dy}px)`;
    markOver(targetAt(e.clientX, e.clientY));
  }

  function onUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const { chip, moved } = drag;
    abort();
    if (!moved) return setPicked(picked === chip ? null : chip);
    const target = targetAt(e.clientX, e.clientY);
    if (target) place(chip, target);
  }

  function abort() {
    if (!drag) return;
    if (drag.ghost) drag.ghost.remove();
    drag.chip.dataset.dragging = '0';
    drag = null;
    markOver(null);
  }

  // Clicks that land beside a chip: drop what is in hand, or send a chip back.
  slots.forEach(slot => {
    slot.addEventListener('click', e => {
      if (locked || e.target.closest('.pr-chip')) return;
      if (picked) place(picked, slot);
    });
  });
  pool.addEventListener('click', e => {
    if (locked || e.target.closest('.pr-chip')) return;
    if (picked) place(picked, bay);
  });

  return {
    // First digit picks an answer up, the second drops it on that line.
    keys: (i) => {
      if (locked) return;
      if (picked) { if (slots[i - 1]) place(picked, slots[i - 1]); return; }
      if (chips[i - 1]) setPicked(chips[i - 1]);
    },
    cancel: () => { abort(); setPicked(null); },
    check: () => {
      locked = true;
      abort();
      setPicked(null);
      let hits = 0;
      slots.forEach((slot, k) => {
        const chip = slot.querySelector('.pr-chip');
        const j = chip ? +chip.dataset.j : -1;
        const ok = !!chip && (j === k || q.pairs[j][1] === q.pairs[k][1]);
        const row = slot.closest('.pr-row');
        row.classList.add(ok ? 'mark-ok' : 'mark-bad');
        row.querySelector('.pr-mark').textContent = ok ? '✓' : '✕';
        if (ok) { chip.classList.add('mark-ok'); hits++; return; }
        if (chip) chip.classList.add('mark-bad');
        // Show what belonged here right next to what was put there.
        slot.appendChild(el('span', 'pr-chip mark-ok',
          `<span class="pr-chip-label">${q.pairs[k][1]}</span>`));
      });
      bay.querySelectorAll('.pr-chip').forEach(c => c.classList.add('mark-bad'));
      const extra = hits === n ? '' :
        `${t('correctPairs')} ${q.pairs.map(p => `${stripTags(p[0])} → ${stripTags(p[1])}`).join(' · ')}.`;
      conclude(ctx, hits === n ? 'right' : hits > 0 ? 'partial' : 'wrong', extra);
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

  const reveal = el('button', 'pr-reveal', `${t('reveal')}  ·  space`);
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
//  List view — the whole deck as a readable list
//  Rows are collapsed to the question; opening one shows the answer, the
//  explanation and the source pages. Nothing here grades anything, so
//  looking an answer up costs no Leitner box.
// ------------------------------------------------------------
const STATUSES = ['all', 'unseen', 'learning', 'mastered', 'retired'];

function statusOf(q) {
  if (store.hidden.includes(q.id)) return 'retired';
  const s = statOf(q.id);
  if (!s) return 'unseen';
  return isMastered(s) ? 'mastered' : 'learning';
}

function statusLabel(key) {
  return t('status' + key[0].toUpperCase() + key.slice(1));
}

// Retired questions stay in the list — they are part of the deck, just out of
// rotation — but the sidebar's topic filter applies here as it does to the pool.
function listBase() {
  const on = new Set(store.topics);
  return deck.questions.filter(q => on.has(q.topic));
}

function haystack(q) {
  if (listText.has(q.id)) return listText.get(q.id);
  const topic = deck.topics.find(x => x.id === q.topic);
  const text = stripTags([
    q.q, answerHtml(q), q.why || '', q.hint || '', q.src || '',
    topic ? topic.label : q.topic,
  ].join(' ')).replace(/\s+/g, ' ').toLowerCase();
  listText.set(q.id, text);
  return text;
}

function listMatches() {
  const needle = listFilter.trim().toLowerCase();
  return listBase().filter(q => {
    if (listStatus !== 'all' && statusOf(q) !== listStatus) return false;
    return !needle || haystack(q).includes(needle);
  });
}

function renderQuestionList() {
  const stage = document.getElementById('pr-stage');
  if (!stage) return;

  const wrap = el('div', 'pr-lv');

  const head = el('div', 'pr-lv-head');
  const search = el('input', 'pr-lv-search');
  search.type = 'search';
  search.value = listFilter;
  search.placeholder = t('filterQ');
  search.setAttribute('autocomplete', 'off');
  // The head survives a repaint, so typing keeps the caret where it is.
  search.addEventListener('input', () => { listFilter = search.value; paintListBody(); });
  head.appendChild(search);
  head.appendChild(el('div', 'pr-lv-chips'));

  const tools = el('div', 'pr-lv-tools');
  const count = el('span', 'pr-lv-count');
  const expand = el('button', 'pr-link', escapeHtml(t('expandAll')));
  const collapse = el('button', 'pr-link', escapeHtml(t('collapseAll')));
  expand.type = collapse.type = 'button';
  expand.addEventListener('click', () => {
    listMatches().forEach(q => openItems.add(q.id));
    paintListBody();
  });
  collapse.addEventListener('click', () => { openItems.clear(); paintListBody(); });
  tools.appendChild(count);
  tools.appendChild(expand);
  tools.appendChild(collapse);
  head.appendChild(tools);

  wrap.appendChild(head);
  wrap.appendChild(el('div', 'pr-lv-body'));

  stage.innerHTML = '';
  stage.appendChild(wrap);
  paintListBody();
}

function paintChips() {
  const box = document.querySelector('.pr-lv-chips');
  if (!box) return;
  const base = listBase();
  const counts = { all: base.length, unseen: 0, learning: 0, mastered: 0, retired: 0 };
  base.forEach(q => { counts[statusOf(q)]++; });

  box.innerHTML = STATUSES.map(key =>
    `<button class="pr-lv-chip${key === listStatus ? ' on' : ''}" data-status="${key}" type="button">` +
    `${escapeHtml(statusLabel(key))} <b>${counts[key]}</b></button>`).join('');

  box.querySelectorAll('[data-status]').forEach(btn => {
    btn.addEventListener('click', () => {
      listStatus = btn.dataset.status;
      paintListBody();
    });
  });
}

function paintListBody() {
  const body = document.querySelector('.pr-lv-body');
  if (!body) return;
  paintChips();

  const matches = listMatches();
  const count = document.querySelector('.pr-lv-count');
  if (count) count.textContent = t('showing')(matches.length, deck.questions.length);

  body.innerHTML = '';
  if (!matches.length) {
    body.appendChild(el('p', 'pr-note pr-lv-none', escapeHtml(t('noMatches'))));
    return;
  }

  // Grouped by topic in the deck's own order, with anything under an unknown
  // topic collected at the end rather than dropped.
  const byTopic = new Map();
  matches.forEach(q => {
    if (!byTopic.has(q.topic)) byTopic.set(q.topic, []);
    byTopic.get(q.topic).push(q);
  });
  const order = deck.topics.map(x => x.id).filter(id => byTopic.has(id))
    .concat([...byTopic.keys()].filter(id => !deck.topics.some(x => x.id === id)));

  let n = 0;
  for (const topicId of order) {
    const topic = deck.topics.find(x => x.id === topicId);
    const group = el('section', 'pr-lv-group');
    const gh = el('div', 'pr-lv-group-head');
    gh.appendChild(el('span', 'pr-lv-group-name', escapeHtml(topic ? topic.label : topicId)));
    gh.appendChild(el('span', 'pr-lv-group-count', String(byTopic.get(topicId).length)));
    group.appendChild(gh);
    for (const q of byTopic.get(topicId)) group.appendChild(listItem(q, ++n));
    body.appendChild(group);
  }
}

function listItem(q, n) {
  const types = (STR[(deck && deck.lang) || 'en'] || STR.en).types;
  const st = statusOf(q);

  const item = el('article', 'pr-lv-item');
  item.dataset.id = q.id;
  item.dataset.status = st;
  item.dataset.open = openItems.has(q.id) ? '1' : '0';

  // The summary strips the question's markup down to one line; the detail
  // below renders it in full.
  const row = el('button', 'pr-lv-row');
  row.type = 'button';
  row.innerHTML =
    `<span class="pr-lv-n">${n}</span>` +
    `<span class="pr-lv-dot" title="${escapeAttr(statusLabel(st))}"></span>` +
    `<span class="pr-lv-q">${escapeHtml(stripTags(q.q))}</span>` +
    `<span class="pr-lv-meta">` +
      (q.src ? `<span class="pr-src">${escapeHtml(q.src)}</span>` : '') +
      `<span class="pr-type">${escapeHtml(types[q.type] || q.type)}</span>` +
      (st === 'retired' ? `<span class="pr-lv-tag">${escapeHtml(statusLabel('retired'))}</span>` : boxPips(q)) +
    `</span>` +
    `<span class="pr-lv-caret">›</span>`;
  row.addEventListener('click', () => toggleItem(item, q));
  item.appendChild(row);

  if (openItems.has(q.id)) item.appendChild(buildDetail(q));
  return item;
}

function boxPips(q) {
  const s = statOf(q.id);
  const box = s ? Math.min(s.box, mastery()) : 0;
  let out = '<span class="pr-boxes">';
  for (let i = 0; i < mastery(); i++) out += `<span class="pr-pip${i < box ? ' on' : ''}"></span>`;
  return out + '</span>';
}

function toggleItem(item, q) {
  if (openItems.has(q.id)) {
    openItems.delete(q.id);
    const open = item.querySelector('.pr-lv-detail');
    if (open) open.remove();
    item.dataset.open = '0';
    return;
  }
  openItems.add(q.id);
  item.appendChild(buildDetail(q));
  item.dataset.open = '1';
}

function buildDetail(q) {
  const box = el('div', 'pr-lv-detail');
  // The row already carries the question, but with its markup stripped and cut
  // to one line — so it is repeated in full only when that loses something.
  // A plain one-liner instead un-clamps in the row itself (see the CSS).
  if (stripTags(q.q) !== q.q) box.appendChild(el('div', 'pr-lv-full', q.q));

  const answer = el('div', 'pr-lv-answer');
  answer.appendChild(el('div', 'pr-lv-label', escapeHtml(t('answerLabel'))));
  const value = el('div', 'pr-lv-value', answerHtml(q));
  answer.appendChild(value);
  box.appendChild(answer);

  if (q.why) {
    const why = el('div', 'pr-lv-answer');
    why.appendChild(el('div', 'pr-lv-label', escapeHtml(t('whyLabel'))));
    why.appendChild(el('div', 'pr-why', q.why));
    box.appendChild(why);
  }

  const src = renderSourcePages(q);
  if (src) box.appendChild(src);

  const acts = el('div', 'pr-lv-acts');
  const go = el('button', 'pr-btn ghost', escapeHtml(t('practiceThis')));
  go.type = 'button';
  go.addEventListener('click', () => practiceQuestion(q.id));
  acts.appendChild(go);

  const retired = store.hidden.includes(q.id);
  const rt = el('button', 'pr-retire', escapeHtml(retired ? t('restore') : t('retire')));
  rt.type = 'button';
  rt.addEventListener('click', () => {
    if (retired) store.hidden = store.hidden.filter(id => id !== q.id);
    else store.hidden.push(q.id);
    saveStore();
    paintStatus();
    paintSidebar();
    paintListBody();
  });
  acts.appendChild(rt);

  const s = statOf(q.id);
  acts.appendChild(el('span', 'pr-lv-tally',
    escapeHtml(s ? t('tally')(s.r, s.n) : t('notSeen'))));
  box.appendChild(acts);
  return box;
}

// Jump from a list row straight into the drill on that question — the one
// place where the next question is chosen rather than drawn.
function practiceQuestion(id) {
  const q = deck.questions.find(x => x.id === id);
  if (!q) return;
  mode = 'drill';
  try { localStorage.setItem('cb:practice:mode', mode); } catch (_) { }
  if (onDeckChange) onDeckChange(deck.id, mode);
  graded = null;
  current = q;
  paintStatus();
  renderCard(q);
  els.scrollArea.scrollTop = 0;
}

// The solution of a question, laid out per type. Deck HTML is passed through
// the way the card does it; plain match strings are escaped.
function answerHtml(q) {
  try {
    switch (q.type) {
      case 'mc':
      case 'multi': {
        const want = q.type === 'multi' ? q.correct : [q.correct];
        return '<ul class="pr-lv-opts">' + q.options.map((o, i) =>
          `<li class="${want.includes(i) ? 'is-on' : ''}">` +
          `<span class="pr-lv-tick">${want.includes(i) ? '✓' : '·'}</span>` +
          `<span>${o}</span></li>`).join('') + '</ul>';
      }
      case 'text':
        return `<p class="pr-lv-plain">${q.accept.map(a => escapeHtml(a)).join(' · ')}</p>`;
      case 'list':
        return '<ul class="pr-lv-bullets">' + q.answers.map(a =>
          `<li>${a.show || escapeHtml(a.accept[0])}</li>`).join('') + '</ul>';
      case 'cloze': {
        const parts = q.text.split('{{}}');
        let out = '';
        parts.forEach((part, i) => {
          out += part;
          const g = q.gaps[i];
          if (g) out += `<b class="pr-lv-gap">${g.show || escapeHtml(g.accept[0])}</b>`;
        });
        return `<p class="pr-lv-plain">${out}</p>`;
      }
      case 'order':
        return '<ol class="pr-lv-ol">' + q.items.map(i => `<li>${i}</li>`).join('') + '</ol>';
      case 'match':
        return '<ul class="pr-lv-pairs">' + q.pairs.map(pair =>
          `<li><span class="pr-lv-left">${pair[0]}</span>` +
          `<span class="pr-lv-arrow">→</span><span>${pair[1]}</span></li>`).join('') + '</ul>';
      case 'bucket':
        return '<div class="pr-lv-buckets">' + q.buckets.map((label, bi) =>
          `<div class="pr-lv-bucket"><div class="pr-lv-bucket-name">${escapeHtml(label)}</div><ul>` +
          q.items.filter(it => it[1] === bi).map(it => `<li>${it[0]}</li>`).join('') +
          '</ul></div>').join('') + '</div>';
      case 'flash':
        return `<div class="pr-lv-plain">${q.answer}</div>`;
      default:
        return '';
    }
  } catch (_) {
    // A malformed question must not take the whole list down with it.
    return '';
  }
}

// ------------------------------------------------------------
//  Keyboard
// ------------------------------------------------------------
function onKey(e) {
  if (!mounted || mode !== 'drill' || !current) return;
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'select' || tag === 'textarea';

  if (e.key === 'Enter') {
    e.preventDefault();
    runPrimary();
    return;
  }
  if (typing) return;

  if (e.key === 'Escape' && view && view.cancel) {
    view.cancel();
    return;
  }
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
