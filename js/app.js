// ============================================================
//  Course Browser — app logic
//  - Loads course/tab definitions from courses.json
//  - Each tab loads a set of modular HTML content files
//  - Search over course content only — never the practice questions
//  - #/read/<course>/<section> and #/practice/<deck> are linkable
//  - One extra tab ("Practice") switches to the adaptive test mode
// ============================================================

import { mountPractice, unmountPractice, currentDeckId } from './practice.js';

const els = {
  root: document.documentElement,
  tabs: document.getElementById('tabs'),
  tabsPinned: document.getElementById('tabsPinned'),
  sidebar: document.getElementById('sidebar'),
  toc: document.getElementById('toc'),
  scrollArea: document.getElementById('scrollArea'),
  pageList: document.getElementById('pageList'),
  lightbox: document.getElementById('lightbox'),
  lightboxImg: document.getElementById('lightboxImg'),
  lightboxCap: document.getElementById('lightboxCap'),
  lightboxHl: document.getElementById('lightboxHl'),
  lightboxClose: document.getElementById('lightboxClose'),
  search: document.getElementById('search'),
  searchPanel: document.getElementById('searchPanel'),
  searchResults: document.getElementById('searchResults'),
  searchCount: document.getElementById('searchCount'),
  searchClose: document.getElementById('searchClose'),
  drawerBtn: document.getElementById('drawerBtn'),
  scrim: document.getElementById('scrim'),
  themeBtn: document.getElementById('themeBtn'),
  modeBtn: document.getElementById('modeBtn'),
};

const PRACTICE_TAB = '__practice__';
const THEMES = ['academic', 'swiss', 'terminal'];

let courses = [];
let tests = [];        // test decks for the practice tab
let activeCourseId = null;
let tocEntries = [];   // [{ el: heading, link: <a> }] for the active course
let searchIndex = [];  // [{ id, title, file, text }] for the active course
let loadToken = 0;     // guards against a slow load overwriting a newer tab
let tabButtons = [];   // course tabs + the pinned practice tab

// ------------------------------------------------------------
//  Boot
// ------------------------------------------------------------
init();

async function init() {
  applyTheme(remembered('cb:theme', THEMES[0]), remembered('cb:mode', 'light'));

  try {
    const res = await fetch('courses.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`courses.json → HTTP ${res.status}`);
    const data = await res.json();
    courses = Array.isArray(data.courses) ? data.courses : [];
    tests = Array.isArray(data.tests) ? data.tests : [];
  } catch (err) {
    renderFatal(
      `Could not load <code>courses.json</code>.<br>${escapeHtml(err.message)}` +
      `<br><br>Are you serving the folder over http?  Try:<br>` +
      `<code>python3 -m http.server</code> in this folder, then open ` +
      `<code>http://localhost:8000</code>.`
    );
    return;
  }

  if (!courses.length) {
    renderFatal('No courses defined in <code>courses.json</code> yet.');
    return;
  }

  buildTabs();
  wireChrome();
  wireLightbox();

  // A hash wins over the remembered tab — links have to land where they say.
  const route = parseHash();
  if (route) {
    await applyRoute(route);
  } else {
    const saved = localStorage.getItem('cb:activeCourse');
    const known = courses.some(c => c.id === saved) || (saved === PRACTICE_TAB && tests.length);
    await selectCourse(known ? saved : courses[0].id);
  }

  window.addEventListener('hashchange', () => {
    const r = parseHash();
    if (r) applyRoute(r);
  });
  els.scrollArea.addEventListener('scroll', () => requestAnimationFrame(updateActiveToc), { passive: true });
}

// ------------------------------------------------------------
//  Theme
// ------------------------------------------------------------
function applyTheme(theme, mode) {
  els.root.dataset.theme = THEMES.includes(theme) ? theme : THEMES[0];
  els.root.dataset.mode = mode === 'dark' ? 'dark' : 'light';
  els.themeBtn.textContent = els.root.dataset.theme;
  els.modeBtn.textContent = els.root.dataset.mode === 'dark' ? '☾' : '☀';
}

function remembered(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch (_) { return fallback; }
}

// ------------------------------------------------------------
//  Chrome — search box, theme buttons, drawer, global keys
// ------------------------------------------------------------
function wireChrome() {
  els.themeBtn.addEventListener('click', () => {
    const next = THEMES[(THEMES.indexOf(els.root.dataset.theme) + 1) % THEMES.length];
    applyTheme(next, els.root.dataset.mode);
    remember('cb:theme', next);
  });
  els.modeBtn.addEventListener('click', () => {
    const next = els.root.dataset.mode === 'dark' ? 'light' : 'dark';
    applyTheme(els.root.dataset.theme, next);
    remember('cb:mode', next);
  });

  els.drawerBtn.addEventListener('click', () => setDrawer(els.sidebar.dataset.open !== '1'));
  els.scrim.addEventListener('click', () => setDrawer(false));

  els.search.addEventListener('input', runSearch);
  els.search.addEventListener('focus', runSearch);
  els.search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeSearch(); els.search.blur(); }
    if (e.key === 'Enter') {
      const first = els.searchResults.querySelector('.search-hit');
      if (first) first.click();
    }
  });
  els.searchClose.addEventListener('click', closeSearch);

  document.addEventListener('keydown', (e) => {
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
    if (e.key === '/' && !typing) {
      e.preventDefault();
      els.search.focus();
      els.search.select();
      return;
    }
    if (e.key === 'Escape') {
      closeSearch();
      closeLightbox();
      setDrawer(false);
    }
  });
}

function setDrawer(open) {
  els.sidebar.dataset.open = open ? '1' : '0';
  els.scrim.hidden = !open;
}

// ------------------------------------------------------------
//  Routing — #/read/<course>/<section>, #/practice/<deck>
// ------------------------------------------------------------
function parseHash() {
  const parts = (location.hash || '').replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (!parts.length) return null;
  if (parts[0] === 'practice') return { view: 'practice', deck: parts[1] || null };
  if (parts[0] === 'read' && parts[1]) return { view: 'read', course: parts[1], section: parts[2] || null };
  return null;
}

function setHash(path) {
  const next = '#/' + path;
  if (location.hash !== next) history.replaceState(null, '', next);
}

async function applyRoute(route) {
  if (route.view === 'practice') {
    await selectCourse(PRACTICE_TAB, route.deck);
    return;
  }
  if (!courses.some(c => c.id === route.course)) return;
  await selectCourse(route.course);
  if (route.section) {
    // Wait a frame so the freshly injected content has laid out.
    requestAnimationFrame(() => setTimeout(() => jumpTo(route.section, false), 60));
  }
}

// ------------------------------------------------------------
//  Lightbox — open a source slide big, instead of a new tab
// ------------------------------------------------------------
function wireLightbox() {
  els.pageList.addEventListener('click', (e) => {
    const a = e.target.closest('a.slide');
    if (!a) return;
    e.preventDefault();
    const cap = a.querySelector('span');
    els.lightboxImg.src = a.getAttribute('href');
    els.lightboxCap.textContent = cap ? cap.textContent : '';
    setLightboxHighlight(a.dataset.hl);
    els.lightbox.hidden = false;
  });

  // Close on backdrop/close-button click (but not when clicking the image).
  els.lightbox.addEventListener('click', (e) => {
    if (e.target !== els.lightboxImg) closeLightbox();
  });
  els.lightboxClose.addEventListener('click', closeLightbox);

  // Expanding a source block changes the page height, which moves every heading
  // below it — the scroll-spy has to be recomputed. `toggle` does not bubble,
  // so this listens in the capture phase.
  els.pageList.addEventListener('toggle', (e) => {
    if (e.target instanceof HTMLDetailsElement) requestAnimationFrame(updateActiveToc);
  }, true);
}

// `hl` is "x,y,w,h" in percent of the page — see the deck's `hl` field.
function setLightboxHighlight(hl) {
  const box = els.lightboxHl;
  if (!box) return;
  const n = (hl || '').split(',').map(Number);
  if (n.length !== 4 || n.some(v => !isFinite(v))) {
    box.hidden = true;
    return;
  }
  box.style.left = n[0] + '%';
  box.style.top = n[1] + '%';
  box.style.width = n[2] + '%';
  box.style.height = n[3] + '%';
  box.hidden = false;
}

function closeLightbox() {
  if (els.lightbox.hidden) return;
  els.lightbox.hidden = true;
  els.lightboxImg.removeAttribute('src');
  setLightboxHighlight(null);
}

// ------------------------------------------------------------
//  Tabs
// ------------------------------------------------------------
function buildTabs() {
  els.tabs.innerHTML = '';
  els.tabsPinned.innerHTML = '';
  tabButtons = [];
  for (const course of courses) {
    els.tabs.appendChild(makeTab(course.id, course.title || course.id));
  }
  if (tests.length) {
    const t = makeTab(PRACTICE_TAB, 'Practice');
    t.classList.add('tab-practice');
    els.tabsPinned.appendChild(t);
  }
}

function makeTab(id, label) {
  const btn = document.createElement('button');
  btn.className = 'tab';
  btn.type = 'button';
  btn.role = 'tab';
  btn.textContent = label;
  btn.dataset.courseId = id;
  btn.setAttribute('aria-selected', 'false');
  btn.addEventListener('click', () => selectCourse(id));
  tabButtons.push(btn);
  return btn;
}

async function selectCourse(courseId, deckId) {
  const leavingPractice = activeCourseId === PRACTICE_TAB;
  if (courseId === activeCourseId && !(courseId === PRACTICE_TAB && deckId)) return;
  activeCourseId = courseId;
  const token = ++loadToken;
  remember('cb:activeCourse', courseId);
  closeSearch();
  setDrawer(false);

  for (const btn of tabButtons) {
    btn.setAttribute('aria-selected', String(btn.dataset.courseId === courseId));
  }

  if (leavingPractice) unmountPractice();

  if (courseId === PRACTICE_TAB) {
    els.pageList.innerHTML = '';
    els.scrollArea.scrollTop = 0;
    els.scrollArea.classList.add('practice-area');
    tocEntries = [];
    // The search index is deliberately kept: searching from practice mode
    // still finds course sections and switches back to them.
    await mountPractice({
      scrollArea: els.scrollArea,
      pageList: els.pageList,
      sidebar: els.sidebar,
      decks: tests,
      startDeck: deckId,
      onDeck: (id) => setHash('practice/' + id),
    });
    setHash('practice/' + (currentDeckId() || deckId || ''));
    return;
  }

  els.scrollArea.classList.remove('practice-area');
  if (leavingPractice) restoreSidebar();
  setHash('read/' + courseId);
  const course = courses.find(c => c.id === courseId);
  await loadCourse(course, token);
}

// The practice mode takes the sidebar over for its topic filters — put the
// table of contents back when returning to a course.
function restoreSidebar() {
  els.sidebar.innerHTML =
    '<div class="sidebar-inner"><p class="side-label">Contents</p>' +
    '<nav class="toc" id="toc" aria-label="Sections"></nav></div>';
  els.toc = document.getElementById('toc');
}

// ------------------------------------------------------------
//  Content loading
// ------------------------------------------------------------
async function loadCourse(course, token) {
  els.pageList.innerHTML = '';
  els.scrollArea.scrollTop = 0;

  const files = course.files || [];
  if (!files.length) {
    els.pageList.innerHTML = `<p class="state-msg">No content files listed for
      <strong>${escapeHtml(course.title || course.id)}</strong> yet.<br>
      Add HTML files to <code>content/${escapeHtml(course.id)}/</code> and list them in
      <code>courses.json</code>.</p>`;
    buildToc();
    return;
  }

  els.pageList.innerHTML = `<p class="state-msg">Loading…</p>`;

  // Fetch all files in parallel, but keep listed order when injecting.
  const results = await Promise.all(files.map(f => fetchContent(course.id, f)));
  if (token !== loadToken) return;   // the user switched tabs while we loaded

  els.pageList.innerHTML = '';
  results.forEach((r, i) => {
    els.pageList.appendChild(makeCard(r, i, course.id, files[i]));
  });

  buildToc();
  buildSearchIndex(course.id);
}

function makeCard(result, i, courseId, file) {
  const card = document.createElement('article');
  card.className = 'content-card';
  card.id = `card-${i}`;
  card.dataset.section = '';
  card.dataset.file = `content/${courseId}/${file}`;

  if (!result.ok) {
    card.classList.add('card-error');
    card.innerHTML =
      `<div class="err-head">✕ Fragment failed to load</div>` +
      `GET <code>${escapeHtml(result.path)}</code> → ${escapeHtml(result.error)}<br>` +
      `The rest of the course rendered normally. This placeholder keeps the order of the fragments intact.` +
      `<div><button class="err-retry" type="button">retry</button></div>`;
    card.querySelector('.err-retry').addEventListener('click', async () => {
      const again = await fetchContent(courseId, file);
      card.replaceWith(makeCard(again, i, courseId, file));
      buildToc();
      buildSearchIndex(courseId);
    });
    return card;
  }

  const label = document.createElement('div');
  label.className = 'fname';
  label.textContent = card.dataset.file;
  card.appendChild(label);

  const body = document.createElement('div');
  body.innerHTML = result.html;
  while (body.firstChild) card.appendChild(body.firstChild);
  activateScripts(card);

  return card;
}

async function fetchContent(courseId, file) {
  const path = `content/${courseId}/${file}`;
  try {
    const res = await fetch(path, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { ok: true, html: await res.text(), path };
  } catch (err) {
    return { ok: false, error: err.message, path };
  }
}

// innerHTML does not execute <script> tags — re-create them so modular
// content files can include their own JS (charts, interactive demos…).
function activateScripts(container) {
  const scripts = container.querySelectorAll('script');
  for (const old of scripts) {
    const s = document.createElement('script');
    for (const attr of old.attributes) s.setAttribute(attr.name, attr.value);
    s.textContent = old.textContent;
    old.replaceWith(s);
  }
}

// ------------------------------------------------------------
//  Table of contents (built from the headings in the content)
// ------------------------------------------------------------
function buildToc() {
  els.toc.innerHTML = '';
  tocEntries = [];

  const headings = els.pageList.querySelectorAll('h1, h2');
  if (!headings.length) {
    els.toc.innerHTML = '<p class="toc-empty">No sections.</p>';
    return;
  }

  headings.forEach((h, i) => {
    const id = h.id || `sec-${i}`;
    h.id = id;

    const link = document.createElement('a');
    link.className = 'toc-link toc-' + h.tagName.toLowerCase();
    link.href = '#' + id;
    link.title = h.textContent.trim();

    const label = document.createElement('span');
    label.className = 'toc-label';
    label.textContent = h.textContent.trim();
    link.appendChild(label);

    link.addEventListener('click', (e) => {
      e.preventDefault();
      jumpTo(id);
    });
    els.toc.appendChild(link);
    tocEntries.push({ el: h, link });
  });

  updateActiveToc();
}

function jumpTo(id, push = true) {
  const target = document.getElementById(id);
  if (!target) return;
  const areaTop = els.scrollArea.getBoundingClientRect().top;
  const elTop = target.getBoundingClientRect().top;
  els.scrollArea.scrollTo({
    top: els.scrollArea.scrollTop + (elTop - areaTop) - 16,
    behavior: 'smooth',
  });
  setDrawer(false);
  closeSearch();

  const section = target.closest('[data-section]');
  if (section) {
    section.classList.remove('flashsec');
    void section.offsetWidth;   // restart the animation
    section.classList.add('flashsec');
  }
  if (push && activeCourseId && activeCourseId !== PRACTICE_TAB) {
    setHash('read/' + activeCourseId + '/' + id);
  }
}

// Highlight the last heading scrolled past the top of the view (scroll-spy).
function updateActiveToc() {
  if (!tocEntries.length) return;
  const areaTop = els.scrollArea.getBoundingClientRect().top;

  let activeIdx = 0;
  for (let i = 0; i < tocEntries.length; i++) {
    const top = tocEntries[i].el.getBoundingClientRect().top - areaTop;
    if (top <= 24) activeIdx = i;
    else break;
  }

  tocEntries.forEach((entry, i) => {
    entry.link.classList.toggle('active', i === activeIdx);
  });
}

// ------------------------------------------------------------
//  Search — course content only, never the practice questions
// ------------------------------------------------------------
function buildSearchIndex(courseId) {
  searchIndex = [...els.pageList.querySelectorAll('[data-section]')].map(section => {
    const h = section.querySelector('h1, h2');
    return {
      id: h ? h.id : section.id,
      title: h ? h.textContent.trim() : 'Fragment',
      file: section.dataset.file || '',
      course: courseId,
      text: sectionText(section),
    };
  });
}

// Source-slide citations are metadata, not prose: indexing them would make
// every section match "slide" and fill snippets with deck labels.
function sectionText(section) {
  const copy = section.cloneNode(true);
  copy.querySelectorAll('details.source').forEach(d => d.remove());
  return copy.textContent.replace(/\s+/g, ' ').trim();
}

function runSearch() {
  const query = els.search.value.trim();
  if (query.length < 2) return closeSearch();

  const needle = query.toLowerCase();
  const hits = [];

  for (const entry of searchIndex) {
    const at = entry.text.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    hits.push({
      title: entry.title,
      where: entry.file,
      snippet: snippetAround(entry.text, at, query.length),
      go: () => goToSection(entry),
    });
  }

  renderResults(hits.slice(0, 14), query);
}

// A hit can be clicked while practice mode is open, where the course DOM is
// gone — load its course back first, then scroll to the section.
async function goToSection(entry) {
  if (entry.course && entry.course !== activeCourseId) {
    closeSearch();
    await selectCourse(entry.course);
  }
  jumpTo(entry.id);
}

function snippetAround(text, at, len) {
  const start = Math.max(0, at - 55);
  const raw = text.slice(start, at + len + 90);
  const rel = at - start;
  return (start > 0 ? '… ' : '') +
    escapeHtml(raw.slice(0, rel)) +
    '<mark>' + escapeHtml(raw.slice(rel, rel + len)) + '</mark>' +
    escapeHtml(raw.slice(rel + len)) + ' …';
}

function renderResults(hits, query) {
  els.searchResults.innerHTML = '';
  if (!hits.length) return closeSearch();

  els.searchCount.textContent = `${hits.length} matches for “${query}”`;
  for (const hit of hits) {
    const btn = document.createElement('button');
    btn.className = 'search-hit';
    btn.type = 'button';
    btn.innerHTML =
      `<div class="hit-top"><span class="hit-title">${escapeHtml(hit.title)}</span>` +
      `<span class="hit-where">${escapeHtml(hit.where)}</span></div>` +
      `<div class="hit-snippet">${hit.snippet}</div>`;
    btn.addEventListener('click', hit.go);
    els.searchResults.appendChild(btn);
  }
  els.searchPanel.hidden = false;
}

function closeSearch() {
  els.searchPanel.hidden = true;
}

// ------------------------------------------------------------
//  Helpers
// ------------------------------------------------------------
function renderFatal(html) {
  els.pageList.innerHTML = `<div class="state-msg">${html}</div>`;
}

// Safari in private browsing throws on setItem — losing a stored preference
// must never take the whole tab switch down with it.
function remember(key, value) {
  try { localStorage.setItem(key, value); } catch (_) { }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
