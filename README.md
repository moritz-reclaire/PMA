# Course Browser

A small, dependency-free web app for browsing course notes ("Studienheft").
Each **tab** is a course; each course is a **scroll view** of modular HTML
content files, with a table of contents on the left to jump around.

## Chrome

- **Search** — `/` focuses the box; two characters open a result list over the
  content with a snippet per hit, covering every section of the open course
  plus the questions of the loaded practice deck. `Enter` opens the first hit,
  `Esc` closes.
- **Themes** — three visual directions (`academic`, `swiss`, `terminal`), each
  with a light and a dark mode, cycled from the header and remembered per
  browser. The tokens live at the top of `css/styles.css`.
- **Linkable state** — `#/read/<course>/<section>` and `#/practice/<deck>`.
  Navigating updates the hash, and opening such a link lands where it says.
- **Small screens** — below 900 px the sidebar becomes a drawer behind the
  `≡` button.

## Run it

The app fetches content files, so it must be served over HTTP (opening
`index.html` directly via `file://` will be blocked by the browser).

```bash
cd course-browser
python3 -m http.server 8000
# then open http://localhost:8000
```

Or use the helper, which sends `Cache-Control: no-store` for the app's own
files so edits to the ES modules in `js/` show up on a plain reload instead of
needing a hard refresh, and answers **Range requests** — without those, `<video>`
cannot seek to a spot it has not buffered yet:

```bash
./serve.sh
```

## Adding content

1. Drop an HTML file into `content/<course-id>/`, e.g.
   `content/cs101/03-sorting.html`.
2. Register it in `courses.json` under that course's `files` list (order in the
   list = order on the page).

To add a whole new course/tab, add an entry to `courses.json`:

```json
{
  "id": "phys150",
  "title": "Physics 150 — Mechanics",
  "files": ["01-kinematics.html"]
}
```

and create the matching `content/phys150/` folder.

### Media (video and PDF)

Files too large for git — lecture videos, source PDFs — live in `media/` at the
repo root, which is gitignored and served like any other folder. The
**Fitnesstrainer – Medien** tab (`content/medien/00-medien.html`) is the page
built on top of it: a grid of `<video preload="none">` players, so a card costs
only its poster frame until someone presses play, the exercise catalogue PDF in
an `<iframe>` using the browser's own viewer, and a `⤓` link per file for a
one-click download.

Poster frames are checked in (`content/medien/posters/`, ~30 KB each) and come
straight out of the videos — a frame ~35 % in avoids the black lead-in:

```bash
ffmpeg -ss 47 -i media/07-butterfly.mp4 -frames:v 1 -vf scale=640:-2 -q:v 4 \
       content/medien/posters/07-butterfly.jpg
```

Because `media/` is not tracked, a fresh clone shows the page with working
posters and dead links until the files are copied back in.

## Practice mode (adaptive tests)

The **Practice** tab is a separate section: it shows **one question at a time**,
checks it immediately, and remembers per question how often you got it right.
Questions you miss come back much sooner (Leitner-style boxes — a miss drops a
question to the hottest box, a hit promotes it), so the pool automatically
concentrates on your weak spots. **Mastered after** in the sidebar sets how many
clean answers in a row count as mastered (2–6, default 2) — from there a question
all but disappears (~120× rarer than an unseen one, thousands of times rarer at
the top box). Only a few percent of a session lands on mastered material, just
enough to catch mastery that has decayed. "Focus on trouble spots" narrows the
pool to the low boxes and anything missed more often than hit. Progress lives in
`localStorage`, per deck.

The card header carries the topic, the source reference, the question type and
the Leitner box as pips; **retire** takes a question out of rotation for good
(each retired question can be restored individually from the sidebar). The
status bar above it tracks pool / mastered / seen, session accuracy, streak and
the last fourteen verdicts.

Three decks ship with the repo: `tests/pma.json` (Projectmanagement Advanced,
English), `tests/fitness-b.json` (the whole Fitnesstrainer-B-Lizenz script, German)
and `tests/muskeln.json` — a German deck over every exam-relevant muscle of
Modul 6. Per muscle it asks for the joint it primarily acts on and then three
"select all that apply" cards: every function, every origin, every insertion.
One card per joint asks the other way round — every muscle the script files
under that joint — and a cross-cutting topic covers muscle groups and shared
attachment sites.

A deck is a JSON file in `tests/`, registered in `courses.json` (a picker
appears in the sidebar as soon as there is more than one):

```json
"tests": [
  { "id": "cthci", "title": "…", "file": "tests/cthci.json" }
]
```

Each deck has `topics` (used for the sidebar filters and the mastery meters) and
`questions`, plus an optional `lang` (`"en"` — default — or `"de"`) that
switches the wording inside the question card. Every question needs `id`,
`topic`, `type`, `q` and `why` (the explanation shown after answering), and may
carry `src`, a short source reference shown as a badge on the card (e.g.
`"Übungsfrage 116"`). The supported types:

| type | extra fields | interaction |
|------|--------------|-------------|
| `mc` | `options`, `correct` (index) | single choice |
| `multi` | `options`, `correct` (array) | select all that apply |
| `text` | `accept` (array), `hint` | type the answer (normalized: case, umlauts and punctuation are ignored) |
| `cloze` | `text` with `{{}}` markers, `gaps[{accept, show, size}]` | fill the gaps in a sentence |
| `order` | `items` (in correct order) | arrange the sequence |
| `match` | `pairs[[left, right]]` | assign each left to its right |
| `bucket` | `buckets`, `items[[label, bucketIndex]]` | sort items into categories |
| `flash` | `answer` (HTML) | free recall, self-graded (had it / partly / missed) |
| `list` | `answers[{accept, show}]`, `hint` | name N things — one box per wanted answer, order-independent, partial credit |

### Source pages

A deck can point every question at the page of a source PDF the answer comes
from. Give the deck a `source` block and each question a `pages` array:

```json
"source": {
  "label": "Fitnesstrainer(in)-B-Lizenz · Lehrskript",
  "base": "content/fitness-b/pages/",
  "ext": ".jpg",
  "pad": 3
},
"questions": [
  { "id": "m4-25", "…": "…", "pages": [62],
    "hl": { "page": 62, "x": 27.97, "y": 71.67, "w": 63.14, "h": 7.81 } }
]
```

An optional `hl` marks the passage the answer comes from. Its `x`/`y`/`w`/`h` are
percentages of the page, so the same numbers position the overlay on the
thumbnail and on the full-size image in the lightbox; `page` says which of the
question's pages carries it. The card notes that the marking is automatic and not
always exact.

The card then carries a collapsed **Skript-Seite 62 anzeigen** block at the
bottom with a thumbnail per page, resolved as `base` + zero-padded number +
`ext` (so `62` → `content/fitness-b/pages/062.jpg`). Clicking a thumbnail opens
it in the same lightbox the reading view uses. Decks without a `source` block are
unaffected.

Render the page images straight out of the PDF with poppler:

```bash
pdftoppm -f 62 -l 62 -jpeg -jpegopt quality=72 -r 110 -singlefile skript.pdf 062
```

`q`, options and answers may contain HTML. Keyboard: `1`–`9` pick an option (or
grade a revealed flashcard), `space` reveals a flashcard, `Enter` checks and then
moves on. **Check** with nothing filled in acts as "I don't know": it grades the
question wrong and reveals the solution. **Skip** draws another question without
recording anything.

## What a content file can contain

Each file is a plain **HTML fragment** (no `<html>`/`<body>` wrapper needed).
It can include:

- text, headings, lists, tables, code blocks
- images (`<img src="...">` — relative to the site root)
- inline **SVG** graphics
- `<canvas>` + `<script>` for interactive demos (content scripts are executed)
- its own `<style>` block for local styling

These classes are styled by the app itself:

| class | effect |
|-------|--------|
| `.key-point` | a boxed key fact |
| `.exam-ref` | a small inline reference badge, e.g. for official question numbers |
| `details.source` | a collapsed source-slide reference; thumbnails open in the lightbox |

The file name is shown above each fragment, so a section on screen is easy to
trace back to its source file.

See the files in `content/` for working examples.
