# The Review Page, on the World Tree. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution: Claude implements inline (the user's standing choice: no Codex, no subagents).

**Supersedes** `docs/plans/2026-10-20-sp2a2b-review-page.md`. Its Global Constraints (security headers, token rules, card order, keys, stopping) carry over unchanged and are binding here. Its Task 1 (tree edits) and the tree-view half of its Task 2 shipped in WT-1.

**Goal:** `standin review` starts a probing session and serves a local page with two things:
- **the session:** one card at a time;
- **a node-link forest you can check and edit:**
  - each of the six roots drawn as a left-to-right tree;
  - lit glows by depth, probable is dashed with fill by probability, dark is gray, and frontier sits behind a toggle;
  - clicking a node opens a side panel with its facts, evidence and history, plus controls to rename, move, add a child, delete, unlink and refile a fact;
  - dragging a node onto another moves it.

**Architecture:**
- **Store, knowledge and compaction:**
  - `queuePlace` moves into `@standin/compaction`;
  - `ProbeSession` gains `current()`, `pendingSpotCheck()` and `boundaries()`;
  - `nodeDetail()` in knowledge gathers a node's facts, guess, history and links.
- **`packages/review`:**
  - `server.ts`: `node:http`, the token gate, one request lane, finish;
  - `cards.ts`: the fixed card order;
  - `routes.ts`: JSON routes;
  - `page.html`: inline CSS and JS, with the forest layout written by hand in plain JS and SVG.
- **`apps/cli`:** `standin review`, with `--lan` printing a QR code via `uqr` 0.1.3, and Ctrl-C running finish.

**Spec:** knowledge-map §7, decisions 38–40; world-tree §3, §6.3, decision 55.

## Global Constraints (additions to the superseded plan's)

- **Forest data** comes from `GET /api/forest`:
  - `{ roots: {key,name,id}[], nodes: TreeNode[] (all, frontier included and flagged), links: TopicEdge[] (requires + related) }`;
  - `TreeNode` comes from `@standin/knowledge`, with `state`, `p`, `facts`, `frontier`, `root` and `parentId`.
- **Drawing:**
  - **lit Knowledge node:** filled amber, opacity `0.35 + 0.15·depth`;
  - **lit non-Knowledge node:** filled teal;
  - **probable:** dashed amber outline, with fill opacity = `p`;
  - **dark:** filled gray;
  - **unlit:** hollow gray;
  - **frontier** (when shown): small, dotted;
  - **boundary:** a small lock marker after the label.
  - A legend is always visible. Labels are never rotated.
- **Layout:** for each root, a tidy tree: x by depth, y by leaf order, and each parent centered on its children.
  - **Collapsing:** a branch collapses by clicking its chevron.
  - **Zoom and pan:** pan by dragging the background, zoom with the wheel or pinch.
  - **Fit:** a "Fit" button.
  - **Frontier toggle:** "Show frontier", off by default.
  - **Phones:** at phone width the side panel becomes a bottom sheet.
- **Drag to move:** dragging a node onto another node moves it there. Dropping it on a root's label moves it to that root. The UI shows the target while dragging, and a 409 shows its message and reverts.
- **Edits** (all use `X-Standin-Token` and the request lane):

  | Route | Body |
  |---|---|
  | `POST /api/tree/rename` | `{nodeId,name}` |
  | `POST /api/tree/move` | `{nodeId,parentId}` |
  | `POST /api/tree/add` | `{parentId,name,label}`, which creates the node under the parent with source `person` |
  | `POST /api/tree/delete-node` | `{nodeId}` |
  | `POST /api/tree/delete-edge` | `{edgeId}` |
  | `POST /api/fact/move` | `{memoryId,nodeId}` |

- **Errors.** `NameTakenError`, `CycleError` and `RootEditError` give 409, with their messages.
- **Commits:** the author is the repo's git user. Every message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A reload mid-probe shows the same probe** (`current()`). Task 1, Task 3.
2. **A double-submitted rating gets 409 with one write,** because of the request lane. Task 3.
3. **Finish twice, from the button and Ctrl-C, runs once.** Task 2.
4. **A malformed or oversized body gets 400 or 413,** and the server lives on. Task 2.
5. **A drag that would create a cycle, a taken name, or a move of a root** gets 409, and the forest is unchanged. Task 4.

---

### Task 1: Session reads, node detail, queue place

**Files:** `packages/knowledge/src/probing/session.ts`, new `packages/knowledge/src/node-detail.ts`, `packages/knowledge/src/index.ts`, `packages/compaction/src/{queue,index}.ts`, `apps/cli/src/commands/{queue,decide}.ts`; tests `packages/knowledge/test/session.test.ts`, `packages/knowledge/test/node-detail.test.ts`.

**Interfaces:**
- `session.current(): ShownProbe | null`, `session.pendingSpotCheck(): PendingSpotCheck | null` and `session.boundaries(): {nodeId, topic}[]`, as in the superseded plan's Task 3.
- `queuePlace(store, config, id)`, moved into `@standin/compaction`.
- `nodeDetail(store, t, nodeId): NodeDetail`:

  ```ts
  { node: TreeNode; definition: string|null; aliases: string[];
    facts: {id; kind; statement; tier}[];
    hypothesis: { depth; p; kind; reason; path: string[] /* names */ } | null;
    history: { question; kind; difficulty; rating; grade; shownAt }[];
    links: { id; kind: "requires"|"related"; other: {id; name} ; direction: "out"|"in" }[] }
  ```

  - `facts` are the approved home memories.
  - `history` is the probes on the node, oldest first.
- [ ] **Failing tests:**
  - `current()` returns the shown, unrated probe until it is rated;
  - `pendingSpotCheck()` returns a requested check until it is answered;
  - `boundaries()` lists boundaries, and undo clears them;
  - `nodeDetail()` on a node with a home fact, an open hypothesis (with path names), a probe history and a related link.
- [ ] Implement, then `pnpm vitest run packages/knowledge packages/compaction apps/cli`. PASS.
- [ ] Commit: `Session reads, node detail, and queue place for the review page`

### Task 2: Review server: token, request lane, finish

As in the superseded plan's Task 4, with the same tests.

**Files:** `packages/review/{package.json,src/index.ts,src/server.ts,src/page.html}`, `packages/review/test/{helpers.ts,server.test.ts}`.
- `@standin/review` deps: `@standin/compaction`, `@standin/knowledge`, `@standin/schema`, `@standin/store`, `zod`.
- `ReviewServerOptions` also takes `speakAt?: number` (passed on to `answerMode`).
- [ ] Failing tests (the superseded Task 4 list), then implement, then `pnpm install && pnpm vitest run packages/review`. PASS.
- [ ] Commit: `Review server: token, one request lane, finish`

### Task 3: Cards and decisions

As in the superseded plan's Task 5, with the same card types, routes and tests. Additions:
- a probe card's `kind` may be `hypothesis`;
- `QueueCard` is unchanged. Lighting proposals no longer exist, but claims and facts still flow through the queue.
- [ ] Failing tests:
  - reload shows the same probe;
  - a second rating gets 409;
  - the fixed order (spot-check → miss → claim → probe → proposal → done);
  - decide reject and expire, with decisions logged.

  Then implement, then `pnpm vitest run packages/review`. PASS.
- [ ] Commit: `Review page API: cards in a fixed order, and decisions`

### Task 4: Forest, node detail and edits

**Files:** `packages/review/src/routes.ts`; test `packages/review/test/forest.test.ts`.

**Interfaces:**

| Route | Returns |
|---|---|
| `GET /api/forest` | Global Constraints |
| `GET /api/node/:id` | `NodeDetail` |
| `GET /api/boundaries`, `POST /api/boundaries/undo`, `GET /api/queue` | as in the superseded plan's Task 6 |

The edit routes are the ones in Global Constraints. Bodies are zod-validated, and names are 1–120 characters, trimmed.
- [ ] **Failing tests:**
  - the forest lists the six roots, a probable node with `p`, and frontier nodes flagged;
  - node detail shows a home fact and the hypothesis path names;
  - rename, move, add-child, delete-node, delete-edge and fact-move are each reflected in the forest or the detail;
  - a cycle, a taken name and a root edit each give 409 with nothing changed;
  - a boundary is listed and undone;
  - the queue is listed in order.
- [ ] Implement, then `pnpm vitest run packages/review`. PASS.
- [ ] Commit: `Review page API: the forest, node detail and tree edits`

### Task 5: The page

**Files:** `packages/review/src/page.html`; test: one assertion in `server.test.ts`. The rest is verified in the browser.

**What the page shows:**
- **Header:** "standin review", progress, the tabs **Session · Forest · Boundaries · Queue**, and Finish.
- **Session tab:** the cards and keys of the superseded plan's Task 7. A hypothesis probe shows "checking a guess" in small text.
- **Forest tab:** the drawing, layout, interactions and side panel from Global Constraints. The side panel shows:
  - the node's name, state line (`nodeStatus` text), definition and aliases;
  - facts, each with a "Move to…" control;
  - the guess (depth, p, kind, reason, evidence path);
  - probe history;
  - links (unlink ✕);
  - actions: Rename, Move (a select), Add child (name and label), Delete (`confirm()`).
- **Styling:**
  - colour tokens, with dark mode;
  - a system font stack;
  - a 16px gutter;
  - buttons at least 44px tall;
  - no horizontal page scroll at 375px (the forest canvas scrolls and pans inside its own box).
- [ ] **Failing assertion:** the page contains `<title>standin review</title>`, `X-Standin-Token` and `id="forest"`. Then write `page.html`, then run `pnpm vitest run packages/review/test/server.test.ts`. PASS.
- [ ] **Browser verification,** on a demo instance via Task 6's command:
  - rating with keys 1–4;
  - a spot-check;
  - a miss and judging it;
  - an approve with an edit;
  - the forest shows lit, probable and dark nodes plus the legend;
  - a click opens the panel;
  - rename;
  - drag-move, including a refused cycle;
  - add a child;
  - refile a fact;
  - the frontier toggle;
  - Finish;
  - mobile width;
  - dark mode;
  - no console errors.
- [ ] Commit: `The review page: session cards and the editable forest`

### Task 6: `standin review`

As in the superseded plan's Task 8: the files, `CliIO.onInterrupt`, the USAGE line, output, `--lan` with the QR code (`uqr` 0.1.3), and the tests. Also:
- it passes `hypothesize` (the role's model), `splitAt` and `hypotheses` config to `ProbeSession.start`, and `speakAt` to the server;
- the finish line reads: `Finished: graded <g> answers, released <r> held-out probes, <e> new voice samples, settled <s> guesses.`
- [ ] Failing tests (the superseded Task 8 list), then implement, then `pnpm test && pnpm typecheck && pnpm guard`. All PASS.
- [ ] Commit: `standin review: the local review page, with --lan and a QR code`
