# One Review Page and the Grove: Implementation Plan

**Goal:** The review page becomes one place with tabs (Questions, Add, Forest, Boundaries) that the person can leave at any time and resume next time, and the forest is drawn as a grove.

**Spec:** `docs/specs/2026-10-21-review-page.md` (decisions 76–78).

## Global constraints

- Nothing from a source is stored before the person confirms it; unconfirmed sources are dropped when the session ends.
- Every answer is stored when given; nothing on the page is ever disabled after the questions run out.
- The grove is drawn deterministically from the tree (same tree, same drawing).
- Reduced motion: no animation at all.
- Commits: Mingxi is the author; every commit ends with the Co-Authored-By trailer.

## Review focus

- A card shown in one session and never answered is shown first in the next one, and answering it settles its guess against the prediction recorded when it was first shown.
- A card carried over whose node was answered elsewhere since is not shown again.
- An empty instance (only the six roots) draws six saplings and no errors.
- A tree with dozens of leaves still fits on screen with "Fit", and labels don't pile up when zoomed out.
- Dragging a leaf onto a tree's trunk moves it under that root.

---

### Task 1: Resume the unanswered card

**Files:** `packages/store/src/{probes,store}.ts`, `packages/knowledge/src/cards/session.ts`, tests in `packages/knowledge/test/cards-session.test.ts`, `packages/store/test/`.

- `store.carryResponse(responseId, sessionId): ProbeResponse` moves an unrated response into another session (refuses a rated one).
- `CardSession.start` carries over the latest unrated card response of the most recent earlier session, unless its node has a rated card since; `current()` then shows it.
- Tests: carried card shown first with its original prediction; answering it settles its guess; a carried card already answered elsewhere is not shown; rated responses can't be carried.

### Task 2: One page with tabs, no Finish

**Files:** `packages/review/src/page.html`, `apps/cli/src/commands/review.ts`, `apps/cli/test/review.test.ts`.

- Tabs Questions · Add · Forest · Boundaries; the Queue tab removed (`/api/queue` stays for the CLI and tests).
- Add hosts the introduction: "Introduce yourself" with "Skip for now" while `needsIntro`, else "Add to what your standin knows". Confirming switches to Questions.
- The `{ type: "intro" }` card opens the Add tab.
- No Finish button or `f` key. `{ type: "done" }` shows "No more questions for now", with "See your forest" and "Add something"; when it follows an answer on this page, switch to the Forest with that banner.
- CLI: "Your answers are saved as you go. Press Ctrl-C to stop; the next review picks up where you left off." The end line becomes "Stopped: answered N cards, settled M guesses."

### Task 3: The grove

**Files:** `packages/review/src/page.html`.

- `growGrove(forest, showFrontier)` lays out the trees as spec §4 and §6 describe: fan 200°–340°, 74 px rings, wedges by leaf count, per-node bend from an id hash, trees side by side on the ground line with gaps.
- Draw: ground, trunks and tapered branches, leaves by state (existing glyph meanings), saplings for empty roots, root names on the ground, labels by zoom/focus/hover, vines for the selected leaf's links only.
- Interactions kept: pan, zoom, pinch, select → panel, drag a leaf onto a leaf or tree to move. New: click a tree's name or trunk to zoom to it.
- First open: leaves fade in from the trunk outward unless reduced motion is set.

### Task 4: Docs and browser check

README review-page section; browser check: empty instance (saplings), demo instance after an introduction and some answers, resume after restart, phone width, dark mode, no console errors.
