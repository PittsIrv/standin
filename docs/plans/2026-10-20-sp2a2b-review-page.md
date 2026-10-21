# SP2a-2b: The Review Page. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution: Claude implements inline (the user's standing choice: no Codex, no subagents).

**Goal:** `standin review` starts a probing session and serves a local page. On it the person rates probes, answers spot-checks, judges misses, keeps or lowers claims, works through the review queue, and edits the tree. The page is driven entirely by the SP2a-2a engine.

**Architecture:**
- **`store`:** adds tree edits: rename, move, and delete an edge.
- **`knowledge`:** gains three things.
  - A tree view, moved out of the CLI's `map` command so the page and `standin map` share it.
  - `ProbeSession.current()`, so a reload shows the same probe again.
  - `pendingSpotCheck()` and `boundaries()`.
- **`compaction`:** gains `queuePlace`, moved out of the CLI.
- **A new `packages/review`:**
  - a `node:http` server with token security and one serialized request lane;
  - a card picker that applies the fixed order;
  - JSON routes;
  - one static `page.html` with inline CSS and JS.
- **`apps/cli`:** adds `standin review`, with `--lan` printing a QR code through `uqr`, and Ctrl-C running finish.

**Tech Stack:** Node 24, TypeScript (strict), `node:http`, `node:crypto`, zod v4, vitest, `uqr` 0.1.3.

**Spec:** `docs/specs/2026-10-07-knowledge-map.md` §2.4, §3.5, §3.6, §7, §9, and decisions 1–40.

## Global Constraints

- **No front-end framework and no build step.** The page is one HTML file with inline `<style>` and `<script>` and no external resources.
- **Binding:** `127.0.0.1` by default; `0.0.0.0` only with `--lan`.
- **Token:** `randomBytes(32).toString("base64url")`, compared with `timingSafeEqual`.
  - The page `GET /` requires `?t=<token>`.
  - Every `/api/*` request requires the header `X-Standin-Token: <token>`. A token in the API's query string is ignored.
  - Anything without a valid token gets **403**, including unknown paths.
- **Page response headers:**
  - `Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
  - `Referrer-Policy: no-referrer`
  - `Cache-Control: no-store`
  - `X-Content-Type-Options: nosniff`

  API responses get the last three.
- **Card order** (decision 38). The first one that applies wins:
  1. the current unrated probe;
  2. a requested spot-check;
  3. a miss to judge;
  4. a claim to keep or lower;
  5. a new probe from `next()`;
  6. the review queue's first item;
  7. done.
- **Keys** (§7, plus rulings):

  | Card | Keys |
  |---|---|
  | Probe | `1` know, `2` roughly, `3` no idea, `4` wouldn't say |
  | Miss | `g` gap, `n` not a gap |
  | Claim | `k` keep, `l` lower |
  | Proposal | `a` approve, `r` reject, `e` edit then approve |
  | Still-true | `k` keep, `x` expire |
  | Any time | `f` finish |

  Keys are ignored while focus is in a text field. In the spot-check box, Ctrl/Cmd+Enter submits.
- **No skipping a spot-check.** Someone who can't answer types that, and grading turns it into a miss they can judge.
- **The browser isn't opened automatically.** The command prints the URL.
- **Stopping** (decision 40):
  - `finish()` runs at most once, whether from the button or Ctrl-C.
  - The HTTP response carries the report, and then the server closes.
- **Copy:** English, sentence case. Rating labels are "I know this", "Roughly", "No idea" and "Wouldn't say".
- **Dependencies:** the only new runtime dependency is `uqr`, pinned at exactly `0.1.3`, in `apps/cli`.
- **Commits:** the author is the repo's git user. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Reloading mid-probe** must show the same probe, not draw a new one. Task 3 pins `current()`; Task 5 pins the card route.
2. **A double-submitted rating** (a key held down, a double click) gets 409, with no second write. All handlers run in one serialized lane. Task 5.
3. **Finish twice** (the button, then Ctrl-C) runs one finish and returns the same report. Task 4.
4. **A malformed JSON body or a body over 64 KB** gets 400 or 413, and the server keeps serving. Task 4.
5. **Renaming to a taken name, or a move that would make a cycle,** gets 409 with a readable message, and nothing changes. Task 1 pins the store; Task 6 pins the routes.

---

### Task 1: Tree edits in the store

**Files:**
- Modify: `packages/store/src/tree.ts`, `packages/store/src/store.ts` (delegates), `packages/store/src/errors.ts` (or wherever `CycleError` lives), `packages/store/src/index.ts`
- Test: `packages/store/test/tree.test.ts`

**Interfaces:**
- Produces:
  - `store.renameTopic(id: string, name: string): Topic`. The old name joins `aliases`. It throws `NameTakenError` (`message: "There is already a topic named <name>."`) when another topic entity matches the new name by `normalizeName` on its name or aliases. Renaming to the topic's own alias promotes the alias.
  - `store.moveTopic(id: string, parentId: string | null): TopicEdge | null`. Soft-deletes the node's live outgoing `part_of` edges, then adds `part_of id → parentId` with `source: "person"`. All in one transaction, so a `CycleError` leaves the old parent in place. `null` makes it a root.
  - `store.deleteEdge(edgeId: string): void`. Sets `deleted_at`, and throws `NotFoundError("edge", id)` for an unknown id. A deleted edge is never re-added, as `addEdge` already guarantees.
  - `store.deleteTopic(id: string): Topic`, which wraps `setTopic(id, { deletedAt: now })`.
  - Export `NameTakenError`.

- [ ] **Step 1: Write the failing tests** in `tree.test.ts`, under `describe("tree edits")`:
  - `renames a topic, keeping the old name as an alias`. `ensureTopic("RL")`, then `renameTopic(id, "Reinforcement learning")`. Expect the name to change, `aliases` to contain `"RL"`, and `ensureTopic("rl").id` to be the same id.
  - `refuses a name another topic has`. Two topics A and B; `renameTopic(a, " b ")` throws `NameTakenError` with the message `There is already a topic named  b .`. Use `toThrow(NameTakenError)`, and assert A's name is unchanged.
  - `moves a topic to a new parent, or to the root`. Edges A→B (part_of), then `moveTopic(A, C)`. Expect `listEdges("part_of")` to be `[[A, C]]` and the edge's `source` to be `"person"`. Then `moveTopic(A, null)` makes `listEdges("part_of")` equal `[]`.
  - `refuses a move that makes a cycle and keeps the old parent`. With A→B and B→C, `moveTopic(C, A)` throws `CycleError`, and the edges are still `[[A,B],[B,C]]`.
  - `deletes an edge for good`. Delete the A→B edge, then `addEdge` the same pair again; expect `null`. `deleteEdge("edg_nope")` throws `NotFoundError`.
  - `deletes a topic`. `deleteTopic(B).deletedAt` is not null, and `listTopics()` excludes B.
- [ ] **Step 2: Run** `pnpm vitest run packages/store/test/tree.test.ts`. Expected: FAIL, `renameTopic is not a function`.
- [ ] **Step 3: Implement** the four functions in `tree.ts`, plus `NameTakenError` next to `CycleError`, the `Store` delegates and the exports.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit.** `Store: rename, move and delete in the knowledge tree`

### Task 2: Shared tree view and queue place

**Files:**
- Create: `packages/knowledge/src/tree-view.ts`
- Modify: `packages/knowledge/src/index.ts`, `apps/cli/src/commands/map.ts` (import instead of defining), `packages/compaction/src/queue.ts`, `packages/compaction/src/index.ts`, `apps/cli/src/commands/queue.ts`, `apps/cli/src/commands/decide.ts`
- Test: `packages/knowledge/test/tree-view.test.ts`; the existing `apps/cli/test/map.test.ts` must stay green.

**Interfaces:**
- Produces:
  - `TreeNode`: the CLI's `NodeView` fields, plus `parentId: string | null`.
  - `treeNodes(t: TreeSnapshot): TreeNode[]`.
  - `nodeStatus(v: TreeNode): string`, the CLI's `status()` unchanged.
  - `renderTree(t: TreeSnapshot): string`, the CLI's `render()` unchanged.
  - From `@standin/compaction`: `queuePlace(store, config, id): { group: QueueGroup | null; position: number | null }`.

- [ ] **Step 1: Write the failing test** `tree-view.test.ts`, using `knowledge/test/fixtures.ts`.
  - Build a tree with a claim at 3 on a parent and one child.
  - `treeNodes` gives the child `parentId` equal to the parent's id and `parent` equal to the parent's name.
  - `nodeStatus` of the child is `lit 3 (inherited from <parent>)`.
- [ ] **Step 2: Run** `pnpm vitest run packages/knowledge/test/tree-view.test.ts`. Expected: FAIL, the module is not found.
- [ ] **Step 3: Move** `views`, `status` and `render` out of `map.ts` into `tree-view.ts`, renamed as above, and add `parentId`. Move `queuePlace` into `compaction/src/queue.ts`. Point the CLI imports at both.
- [ ] **Step 4: Run** `pnpm vitest run packages/knowledge apps/cli packages/compaction`. Expected: PASS.
- [ ] **Step 5: Commit.** `Share the tree view and queue place with the review page`

### Task 3: Session reads for a page

**Files:**
- Modify: `packages/knowledge/src/probing/session.ts`, `packages/knowledge/src/index.ts`
- Test: `packages/knowledge/test/session.test.ts`

**Interfaces:**
- Produces:
  - `session.current(): ShownProbe | null`. The latest probe shown in this session that is still unrated, with the same fields `next()` returns (`done` counts responses shown here). Otherwise `null`.
  - `session.pendingSpotCheck(): { responseId: string; topic: string; question: string } | null`. A response in this session with `spotCheck === "requested"` and no answer.
  - `session.boundaries(): { nodeId: string; topic: string }[]`. Live topics with a non-null `boundaryTier`, ordered by name.

- [ ] **Step 1: Write the failing tests**, using `session-helpers.ts`:
  - `current() returns the shown, unrated probe until it is rated`. Start, `next()`, and `current()?.responseId` equals it. After `rate(..., "roughly")`, `current()` is `null`.
  - `pendingSpotCheck() returns a requested check until it is answered`. Use `queued([…])` so the spot-check draw is under `1/3`. Rate `know`, and the check is pending. After `answer()`, it is `null`.
  - `boundaries() lists topics marked wouldn't say, and undo clears them`.
- [ ] **Step 2: Run** `pnpm vitest run packages/knowledge/test/session.test.ts`. Expected: FAIL, `current is not a function`.
- [ ] **Step 3: Implement** the three methods on `ProbeSession`, reading the store. Export the spot-check type as `PendingSpotCheck`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit.** `Session: current probe, pending spot-check, boundaries`

### Task 4: Review server: security, the request lane, finish

**Files:**
- Create: `packages/review/package.json` (`@standin/review`, deps: `@standin/compaction`, `@standin/knowledge`, `@standin/schema`, `@standin/store`, `zod`), `packages/review/src/index.ts`, `packages/review/src/server.ts`, `packages/review/src/page.html` (placeholder: `<!doctype html><title>standin review</title>`; filled in by Task 7)
- Test: `packages/review/test/server.test.ts`, `packages/review/test/helpers.ts`

**Interfaces:**
- Consumes: `ProbeSession`, `FinishReport` (knowledge), `Store`, `Config`.
- Produces:
  ```ts
  interface ReviewServerOptions { session: ProbeSession; store: Store; config: Config; host?: string; port?: number; token?: string }
  interface ReviewServer {
    url: string;            // http://<host>:<port>/?t=<token>; host printed as given (127.0.0.1 by default)
    port: number;
    token: string;
    finish(): Promise<FinishReport>;   // idempotent; closes the server after
    closed: Promise<FinishReport>;     // resolves once finished and closed
  }
  function startReviewServer(o: ReviewServerOptions): Promise<ReviewServer>;
  type Handler = (body: unknown) => Promise<unknown> | unknown;
  ```
  - Internally: `route(method, path, handler)`. Every handler runs through one promise chain, so requests are serialized.
  - Errors map to statuses: `NotFoundError` → 404; `AlreadyRatedError`, `InvalidTransitionError`, `NameTakenError` and `CycleError` → 409; `ZodError` or bad JSON → 400 (`{ error }`); a body over 65 536 bytes → 413. Anything else is a 500 with `{ error: message }`.
  - `POST /api/finish` returns `{ report, warnings }`, then closes.
  - Task 5 adds routes through `routes.ts`.
- `helpers.ts` builds a temp store, a `ProbeSession` with the scripted models from `knowledge/test/session-helpers.ts` (import it by relative path), and a server on port 0. It exposes `api(path, body?, token?)` and `page(query)`.

- [ ] **Step 1: Write the failing tests** in `server.test.ts`:
  - `binds to 127.0.0.1 by default`: `server.url` starts with `http://127.0.0.1:`.
  - `serves the page only with the token in the URL`:
    - `GET /?t=<token>` returns 200, `text/html`, and the CSP and Referrer-Policy headers exactly as in Global Constraints;
    - `GET /` returns 403;
    - `GET /?t=wrong` returns 403.
  - `requires the token header on the API`:
    - `GET /api/card` without the header returns 403;
    - `GET /api/card?t=<token>` without the header returns 403;
    - a wrong header returns 403;
    - an unknown path without a token returns 403;
    - an unknown path with a token returns 404.
  - `rejects malformed and oversized bodies and keeps serving`: `POST /api/rate` with body `{` returns 400, a 70 000-byte body returns 413, and `GET /api/card` still returns 200.
  - `finishes once, from either side, and closes`:
    - call `server.finish()` and `POST /api/finish` together;
    - both reports are deep-equal;
    - the session's `endedAt` is set;
    - `closed` resolves;
    - a later fetch rejects, because the connection is refused.
- [ ] **Step 2: Run** `pnpm install && pnpm vitest run packages/review`. Expected: FAIL, `startReviewServer` is not found.
- [ ] **Step 3: Implement `server.ts`.**
  - Read the page once with `readFileSync(new URL("./page.html", import.meta.url), "utf8")`.
  - Before any routing, check the token with `timingSafeEqual` on equal-length buffers, treating a length mismatch as invalid.
  - Write the response before calling `server.close()`, and call `closeAllConnections()` after it.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit.** `Review server: token, one request lane, finish`

### Task 5: Cards and decisions

**Files:**
- Create: `packages/review/src/cards.ts`, `packages/review/src/routes.ts`
- Modify: `packages/review/src/server.ts` (register routes)
- Test: `packages/review/test/cards.test.ts`

**Interfaces:**
- Consumes: Task 3's session reads, Task 2's `queuePlace`, and `reviewQueue`.
- Produces:
  ```ts
  interface QueueCard { id: string; stillTrue: boolean; group: QueueGroup; memoryKind: MemoryKind; statement: string; tier: number;
    reasons: string[]; sources: SourceSummary; replaces: string | null; conflictsWith: string | null }
  type Card =
    | { type: "probe"; probe: ShownProbe }
    | { type: "spot-check"; check: PendingSpotCheck }
    | { type: "miss"; miss: Miss }
    | { type: "claim"; decision: ClaimDecision }
    | { type: "proposal"; item: QueueCard }
    | { type: "done" };
  function nextCard(session: ProbeSession, store: Store, config: Config): Promise<Card>; // the Global Constraints order
  ```
  - `replaces` and `conflictsWith` are the other memory's statement. `reasons` is `attrs.reasons ?? []` for competence memories, else `[]`.
  - Routes, with bodies validated by zod:

    | Route | Body | Returns |
    |---|---|---|
    | `GET /api/card` | none | `{ card: Card, warnings: string[] }` |
    | `POST /api/rate` | `{ responseId, rating: Rating }` | `{ spotCheck }` |
    | `POST /api/answer` | `{ responseId, text: string (1..4000) }` | |
    | `POST /api/judge` | `{ responseId, gap: boolean }` | |
    | `POST /api/claim` | `{ claimNodeId, choice: "keep" \| "lower" }` | |
    | `POST /api/decide` | `{ id, decision: "approve" \| "reject" \| "keep" \| "expire", statement?: string }` | the memory |

  - `/api/decide` records a queue decision with `queuePlace`, exactly as the CLI's `approve`, `reject`, `keep` and `expire` do. The `itemKind` is `"still-true"` for keep and expire.
  - `/api/card` returns warnings once, then clears the session's list.
  - The bodies that return nothing respond `{ ok: true }`.

- [ ] **Step 1: Write the failing tests** in `cards.test.ts`. Each one goes through HTTP with the Task 4 helpers.
  - `shows the same probe on reload`: two `GET /api/card` calls return the same `probe.responseId`.
  - `refuses a second rating with 409 and keeps the first`.
  - `walks the fixed order`. Set up one claim at depth 2 and a session of size 3, with an rng where no probe is held out and the first rating draws a spot-check.
    - Rate the first probe `know`, and the card is `spot-check`.
    - Answer it. Rate the next probe `no_idea`, and the card is `miss`.
    - Judge it a gap, and the card is the follow-up `probe`.
    - Rate the follow-up so the gap settles, and once the claim's checks are answered the card is `claim`. Choose `lower`.
    - Then the card is `proposal` for a seeded queue memory. Approve it with an edited `statement`.
    - Then the card is `done`.
    - Assert that `listQueueDecisions()` (or the store's equivalent) has the approve with its group and position.
  - `rejects and expires through decide`. A still-true card (seed with a current-state memory older than `freshnessDays`) can be expired, and a proposal can be rejected. Both are logged.
- [ ] **Step 2: Run** `pnpm vitest run packages/review/test/cards.test.ts`. Expected: FAIL, 404 on `/api/card`.
- [ ] **Step 3: Implement** `cards.ts` and `routes.ts`, and register the routes.
- [ ] **Step 4: Run** `pnpm vitest run packages/review`. Expected: PASS.
- [ ] **Step 5: Commit.** `Review page API: cards in a fixed order, and decisions`

### Task 6: Tree, boundaries and queue tabs

**Files:**
- Modify: `packages/review/src/routes.ts`
- Test: `packages/review/test/tabs.test.ts`

**Interfaces:**
- Consumes: Task 1's tree edits, Task 2's `treeNodes`, and Task 3's `boundaries()`.
- Produces:

  | Route | Body | Returns |
  |---|---|---|
  | `GET /api/tree` | none | `{ nodes: TreeNode[] (with status: nodeStatus(v)), edges: TopicEdge[] (live, both kinds) }` |
  | `POST /api/tree/rename` | `{ nodeId, name: string (1..120, trimmed) }` | |
  | `POST /api/tree/move` | `{ nodeId, parentId: string \| null }` | |
  | `POST /api/tree/delete-node` | `{ nodeId }` | |
  | `POST /api/tree/delete-edge` | `{ edgeId }` | |
  | `GET /api/boundaries` | none | `{ boundaries }` |
  | `POST /api/boundaries/undo` | `{ nodeId }` | |
  | `GET /api/queue` | none | `{ items: QueueCard[] }`, the whole queue in order |

- [ ] **Step 1: Write the failing tests** in `tabs.test.ts`:
  - `renames, moves and deletes through the API, and the tree reflects it`.
  - `answers 409 with the message for a taken name or a cycle, and changes nothing`.
  - `lists a boundary set by wouldn't say, and undoes it`.
  - `lists the queue in order`.
- [ ] **Step 2: Run** `pnpm vitest run packages/review/test/tabs.test.ts`. Expected: FAIL, 404.
- [ ] **Step 3: Implement** the routes.
- [ ] **Step 4: Run** `pnpm vitest run packages/review`. Expected: PASS.
- [ ] **Step 5: Commit.** `Review page API: tree edits, boundaries and the queue`

### Task 7: The page

**Files:**
- Modify: `packages/review/src/page.html`
- Test: `packages/review/test/server.test.ts` (one assertion); the rest is verified in the browser.

**Interfaces:**
- Consumes: every route in Tasks 4–6, through `fetch` with the `X-Standin-Token` header. The token comes from `new URLSearchParams(location.search).get("t")`.

**What the page shows:**
- **The header:** "standin review", progress `done / total` from the probe card, the tabs Session · Tree · Boundaries · Queue, and a Finish button.
- **Session tab:** one card. Each card shows its key hints on its buttons.
  - **Probe card:** the topic, the question, and the difficulty as "level d". The kind is in small text: claim check, follow-up, foundation or discovery.
  - **Spot-check card:** "In a line, how would you answer?", a textarea, and Submit.
  - **Miss card:** the question, and "You said no idea" or "Your one-line answer didn't hold up". Then "Is this a gap in what you know?" with the buttons Gap / Not a gap.
  - **Claim card:** "You said <statement for claimed depth>. Gaps: <topic> (fine up to <level>)…", with Keep / Lower.
  - **Proposal card:** the statement, then "why:" reasons, "replaces:" or "conflicts with:", and sources. Edit turns the statement into a text field; Enter approves the edit.
  - **Done card:** "Nothing left for this session." and the Finish button.
- **Tree tab:** an indented tree with each node's status. Each node has Rename (an inline field), Move (a `<select>` of topics plus "(top level)"), and Delete (`confirm()`). Its `requires` edges show as "needs: X ✕". Errors show inline.
- **Boundaries tab:** a list with Undo.
- **Queue tab:** a read-only list in order.
- **Finish:** shows the report: "Graded N answers, released N held-out probes, N new voice samples, N new proposals." Then "You can close this tab." and all buttons are disabled.
- **Warnings** from `/api/card` show as a dismissible banner.
- **Styling:**
  - Colour tokens on `:root`, with dark-mode overrides under `@media (prefers-color-scheme: dark)`, and an explicit `body` background.
  - System font stack.
  - Max width 40rem, 16px side gutter, no horizontal scroll at 375px.
  - Buttons at least 44px tall, for phones.

- [ ] **Step 1: Add a failing assertion** to `serves the page only with the token in the URL`: the body contains `<title>standin review</title>` and `X-Standin-Token`.
- [ ] **Step 2: Run** `pnpm vitest run packages/review/test/server.test.ts`. Expected: FAIL, because the placeholder has no `X-Standin-Token`.
- [ ] **Step 3: Write `page.html`.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Verify in the browser.**
  - Start a demo instance in the scratchpad with `standin init --demo`.
  - Approve claims, then run `standin review --demo-llm --probes 4` (after Task 8, or through a small scratch script before it).
  - Open the URL in the built-in browser and check:
    - rating by keys 1–4;
    - a spot-check, a miss and judging it;
    - approving with an edit;
    - a tree rename;
    - boundary undo;
    - Finish;
    - mobile width;
    - dark mode;
    - no console errors.
- [ ] **Step 6: Commit.** `The review page`

### Task 8: `standin review`

**Files:**
- Create: `apps/cli/src/commands/review.ts`, `apps/cli/test/review.test.ts`
- Modify:
  - `apps/cli/package.json`: add `"@standin/review": "workspace:*"` and `"uqr": "0.1.3"`;
  - `apps/cli/src/commands/index.ts`;
  - `apps/cli/src/main.ts`: add `CliIO.onInterrupt?: (handler: () => void) => () => void`, and the USAGE line;
  - `apps/cli/bin/standin.mjs`: pass `onInterrupt: (h) => { process.once("SIGINT", h); return () => process.off("SIGINT", h); }`;
  - `README.md`: one line under the commands.

**Interfaces:**
- Consumes: `startReviewServer`, `ProbeSession.start`, `instanceModels(...).for("map" | "quiz" | "grade")`, and `instanceTracer`.
- Produces: `standin review [--probes N] [--port P] [--lan] [--demo-llm]`.
  - USAGE: `review [--probes N] [--port P] [--lan] [--demo-llm]   rate probes and review proposals in a local page (Ctrl-C finishes)`
- Output, in order:
  - `Starting a review session (this refreshes your tree)…`
  - each `warning: …`
  - `Review page: <url>`. With `--lan`, the URL uses the first non-internal IPv4 from `os.networkInterfaces()`. If there is none, the command fails with `CliError("no local network address found")`.
  - With `--lan`, the QR code from `renderUnicodeCompact(url)` (uqr), then `Anyone on your network with this link can see your private data.`
  - `Press Ctrl-C or use Finish on the page to end the session.`
  - After the server closes: `Finished: graded <gradingSubmitted> answers, released <released> held-out probes, <exemplars> new voice samples, <discoveryProposals> new proposals.`
  - If any proposals are waiting in `reviewQueue`, then: `Next: standin queue`.
  - Exit code 0.
- `--probes` must be a positive integer. Otherwise: `CliError("--probes must be a positive integer")`.

- [ ] **Step 1: Write the failing tests** in `review.test.ts`, with the harness style of `more-ways-in.test.ts` plus `onInterrupt` capture:
  - `runs a session in the page and finishes from it`.
    - `init`, then approve a competence memory through the store.
    - Start `run("review", "--demo-llm", "--probes", "2", "--port", "0")` without awaiting it.
    - `vi.waitFor` the `Review page:` line, and parse the URL and token from it.
    - `GET /api/card` returns a probe; rate it `no_idea`.
    - `POST /api/finish`.
    - The command resolves 0, and the output contains `Finished: graded`.
  - `Ctrl-C finishes the session`. Start it the same way, then call the captured interrupt handler. It resolves 0 with `Finished:`, and the session's `endedAt` is set.
  - `rejects a bad --probes`. `--probes 0` exits 1 with `--probes must be a positive integer`.
- [ ] **Step 2: Run** `pnpm install && pnpm vitest run apps/cli/test/review.test.ts`. Expected: FAIL, `Unknown command: review`.
- [ ] **Step 3: Implement** `review.ts`. Unregister the interrupt handler once the server closes.
- [ ] **Step 4: Run** `pnpm vitest run apps/cli/test/review.test.ts`. Expected: PASS.
- [ ] **Step 5: Run the whole suite and the type check:** `pnpm test && pnpm typecheck && pnpm guard`. Expected: all pass.
- [ ] **Step 6: Commit.** `standin review: the local review page, with --lan and a QR code`
