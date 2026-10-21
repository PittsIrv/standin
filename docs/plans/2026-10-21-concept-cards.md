# Concept Cards. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution: Claude implements inline (the user's standing choice: no Codex, no subagents).

**Goal:** Replace quiz probing with concept cards (`docs/specs/2026-10-21-concept-cards.md`):
- the person rates a concept 0–4 (or "wouldn't say");
- the answer lights its branch;
- middle answers walk the concept's parts, up to one level above the answer;
- guesses learn from every answer, scored predict-then-learn.

**Architecture:**
- A new `@standin/knowledge` module, `cards/`:
  - `plan.ts`: pure; the next card, by the spec's order;
  - `session.ts`: `CardSession`, the stateful API the page drives;
  - `score.ts`: predict-then-learn scores.
- Splits gain levels and a strict, code-checked shape.
- The old `probing/` quiz session, `quiz.ts`, `grade.ts`, the old planner and the held-out calibration are deleted, along with their tests and the `quiz` and `grade` roles.
- Old probe rows stay readable.

**Spec:** `docs/specs/2026-10-21-concept-cards.md`, decisions 56–64.

## Global Constraints

- **Answer levels:** `4` Expert, `3` Know well, `2` Used it, `1` Heard of it, `0` No. `wouldnt_say` sets a tier-3 boundary.
  - A stored card response has `level` 0–4, or null for wouldn't-say.
  - It also has `rating` for compatibility: level ≥ 3 → `know`, 1–2 → `roughly`, 0 → `no_idea`, or `wouldnt_say`.
- **Lighting from cards.** The latest card answer per node lights it with basis `stated`, which is added to `DepthBasis`. It is own lighting: it wins over inheritance, and it counts as established for guesses.
- **Walk rule:**
  - **Where walks start:** nodes with a stated level 1–3, and claimed nodes at depth 1–3.
  - **Which parts qualify:** live `part_of` children (frontier included) with `partLevel ≤ level + 1`. A null `partLevel` counts as 2.
  - **When a walk stops:** it asks nothing when fewer than **2** parts qualify (`MIN_PARTS = 2`), or the node has `walkStopped`.
  - **Expansion:** an unexpanded start with no qualifying parts is expanded once (`expand:<id>`).
- **Order** (spec §4):
  1. keep or lower;
  2. guesses, by `|P − 0.5|` then name, skipping nodes with a boundary or already answered;
  3. walk parts, depth-first over the Knowledge tree in name order;
  4. new areas: children of the Knowledge root, and seeded fields, with no stated answer, claim, approved lighting or open guess;
  5. done.
- **Splits:**
  - `ExpandSchema` components gain `level: 1–4`;
  - the prompt asks for 3–7 non-overlapping parts that together cover the concept;
  - `checkSplit()` rejects counts outside 3–7, duplicates, levels outside 1–4, and a part equal to (or an alias of) the parent. One retry; then the valid parts are used;
  - a created part stores `topics.part_level`, which is never overwritten if set.
- **Keep or lower:**
  - **When it's due:** for a claim at depth d whose direct qualifying parts are all answered or stopped, with at least one part stated below d, and no decision since the latest such answer;
  - **Where decisions are stored:** `kv("keepLower:<claimNodeId>")` = ISO time;
  - **Lower** supersedes the claim at the lowest part level, via the existing approve path.
- **Scores** (spec §7). Every card response with a level and a recorded prediction counts:
  - **map score:** agree = (predictedMode ≠ decline) === (level ≥ 2);
  - **guess Brier:** `predictedP` against `priorP` over card responses that have a `hypothesisId`. `safeguard()` uses this.
- **Commits:** the author is the repo's git user. Every message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Answering a node that already has an older quiz response or a hypothesis** must light it at the new answer and settle the guess. Task 3.
2. **A split that returns junk** (one part, the parent's own name, level 9) must not create junk nodes. Task 2.
3. **A walk on a deleted or boundary node** must not ask anything there. Task 4.
4. **Pressing "skip the rest" mid-walk** asks nothing more under that parent. Task 4.
5. **An instance with old quiz data** (probes, responses, held-out rows) still loads, and its old answers don't break scores. Task 3.

---

### Task 1: Schema, migration 9, store

**Files:** `packages/schema/src/{records,roles}.ts`, `packages/store/src/{migrations,probes,tree,store}.ts`; tests `packages/store/test/cards.test.ts`, `packages/schema/test/schema.test.ts`.

**Interfaces:**
- **Schema:**
  - `DepthBasis += "stated"` and `ProbeKind += "card"`;
  - `ProbeResponse.level: number|null` (default null);
  - `Topic.partLevel: number|null` and `Topic.walkStopped: boolean`;
  - the `quiz` and `grade` roles are removed.
- **Migration 9:** `probe_responses.level INTEGER`, `topics.part_level INTEGER`, `topics.walk_stopped INTEGER NOT NULL DEFAULT 0`.
- **Store:**
  - `answerCard(responseId, answer: number | "wouldnt_say"): ProbeResponse` (sets `rating`, `level` and `answered_at`; `AlreadyRatedError` if already answered);
  - `setTopic` patch gains `partLevel?`, `walkStopped?`;
  - `stateds(): Map<nodeId, { level; responseId; answeredAt }>` (the latest card answer per node).
- [ ] **Failing tests:**
  - `answerCard` maps levels to ratings and refuses a second answer;
  - wouldn't-say has a null level;
  - `stateds()` keeps the latest answer per node;
  - `setTopic` with `partLevel` and `walkStopped`;
  - the roles list has no `quiz` or `grade`.
- [ ] Implement, then `pnpm vitest run packages/schema packages/store`. PASS (remove role references in other packages only as far as the typecheck needs, and finish in Task 4).
- [ ] Commit: `Concept-card answers, part levels and walk stops in the store`

### Task 2: Splits with levels and a strict shape

**Files:** `packages/knowledge/src/probing/{expand,prompts,schemas}.ts`, the demo persona; test `packages/knowledge/test/splits.test.ts`.

**Interfaces:**
- `checkSplit(parent: Topic, components): { ok: Component[]; problems: string[] }`.
- `expandNode` retries once when there are problems, then uses `ok`. Created parts get `partLevel` and `frontier`.
- The demo expansion returns 4 parts at levels 1, 2, 3, 4.
- [ ] **Failing tests:**
  - a good split stores parts with their levels;
  - a junk split (1 part; the parent's name; level 9; a duplicate) triggers one retry, then keeps only the valid parts;
  - an existing part's `partLevel` isn't overwritten;
  - an alias of the parent is rejected.
- [ ] Implement, then `pnpm vitest run packages/knowledge`. PASS.
- [ ] Commit: `Splits come with levels, in a shape checked in code`

### Task 3: Lighting, learning and scores from stated answers

**Files:** `packages/knowledge/src/{snapshot,lighting,answer,tree-view,node-detail}.ts`, `hypotheses/{calibrate,guards}.ts`, new `cards/score.ts`; delete `probing/calibration.ts` and its test; `apps/cli/src/commands/map.ts`; tests `packages/knowledge/test/cards-lighting.test.ts`, `apps/cli/test/map.test.ts`.

**Interfaces:**
- `TreeSnapshot.stated: Map<nodeId, number>`. `computeLighting` adds stated values, basis `stated`. `answerMode` treats stated as own lighting. The tree view prints `lit 3 (you said)` and `dark (you said so)`.
- `established()` and `spokenFor()` include stated.
- `outcomeOf(h, responses)`:
  - for card responses (`level !== null`, `probe.hypothesisId === h.id`): `level ≥ h.depth` → confirmed, otherwise refuted;
  - older quiz responses keep their old rule.
- `cardScores(store): { map: { n; agree; score }; guesses: Safeguard }` replaces `calibration()`. `safeguard()` also reads card responses with a `hypothesisId`, with no holdout filter.
- **`standin map`** prints `Map score: a/n (x%) of your answers matched the standin's prediction`, or `Map score: no answers yet`. `--private` adds the guess-calibration line (wording unchanged).
- [ ] **Failing tests:**
  - a stated 3 lights the branch and beats inheritance from a claimed parent;
  - a stated 0 is dark;
  - a stated answer on a guessed node settles it, confirmed at or above and refuted below;
  - `cardScores` from scripted answers;
  - an old quiz response doesn't throw;
  - the CLI map score line.
- [ ] Implement, then `pnpm vitest run packages/knowledge apps/cli`. PASS.
- [ ] Commit: `Card answers light the tree and teach the guesses, scored predict-then-learn`

### Task 4: The card planner and session

**Files:** new `packages/knowledge/src/cards/{plan,session}.ts`; delete `probing/{session,plan,quiz,grade}.ts`, `probing/prompts.ts`'s quiz and grade builders, and their schemas; delete the tests `session.test.ts`, `session-hypotheses.test.ts`, `plan.test.ts`, `gaps-probe.test.ts`, `grade.test.ts`, `probing-models.test.ts` (keep `session-helpers.ts`, updated); `packages/knowledge/src/index.ts`; tests `packages/knowledge/test/cards-plan.test.ts`, `packages/knowledge/test/cards-session.test.ts`.

**Interfaces:**
- **Planner:** `nextCardTarget(t: TreeSnapshot, s: { answered: Set<string> /* node ids with a card answer this or earlier */; hypothesesAnswered: Set<string> }, skip): Target | "expand:<id>" | null`, where:
  - `Target = { kind: "keep-lower"; claimNodeId } | { kind: "guess"; nodeId; hypothesisId } | { kind: "part"; nodeId; parentId } | { kind: "area"; nodeId }`.
- **`CardSession.start(deps: { store; map; hypothesize?; tracer; personaName; splitAt?; hypotheses? })`** runs the refresh (as now) and starts a session row. Its methods:
  - `next(): Promise<ShownCard | null>`, where `ShownCard = { responseId; nodeId; topic; definition; path: string[] /* ancestors */; reason: "guess"|"part"|"area"; parent: string|null; done }`.
    - It writes a `card` probe (question = definition, difficulty = `partLevel ?? 1`, `hypothesisId` for guesses).
    - It records the prediction (mode, plus p and prior for guesses) via `showProbe`.
  - `current(): ShownCard | null`
  - `answer(responseId, answer: number | "wouldnt_say")`: stores it, sets the boundary for wouldn't-say, and settles or withdraws the guess.
  - `skipRest(parentId)`: sets `walkStopped`.
  - `keepLowerDue(): ClaimDecision | null` and `decideClaim(claimNodeId, "keep" | "lower")`. `ClaimDecision = { claimNodeId; topic; claimed; lower: { topic; level }[] }`.
  - `boundaries()` and `undoBoundary()`, as now.
  - `finish(): { answered; settled }`, which ends the session.
- **Session helpers:** `session-helpers.ts` drops quiz and grade, and scripts `expand` with levels.
- [ ] **Failing tests** (planner, with snapshot fixtures):
  - order: keep-lower, then guess (least sure), then part, then area, then null;
  - Expert and No ask nothing below;
  - "Heard of it" asks only parts at level ≤ 2;
  - fewer than 2 qualifying parts asks nothing;
  - `walkStopped` asks nothing;
  - an unexpanded start returns `expand:`;
  - a claim at 3 walks its parts but is never asked itself;
  - boundary and deleted nodes are skipped.
- [ ] **Failing tests** (session, store-backed):
  - a guess card answered 3 at depth 2 settles it as confirmed and lights the node `stated` 3;
  - a middle answer then walks the parts, depth-first;
  - `skipRest` stops the walk;
  - a part rated below a claim makes keep-lower due once all parts are answered, and lower drops the claim to the lowest part level;
  - wouldn't-say sets a boundary and withdraws the guess;
  - `current()` survives a reload;
  - `finish()` counts.
- [ ] Implement, then `pnpm vitest run packages/knowledge`. PASS.
- [ ] Commit: `Concept-card sessions replace quizzes`

### Task 5: The page and the command

**Files:** `packages/review/src/{cards,routes,server}.ts`, `packages/review/src/page.html`, `packages/review/test/*`, `apps/cli/src/commands/review.ts`, `apps/cli/test/review.test.ts`, `examples/demo-persona`, `README.md`.

**Interfaces:**
- **Cards:** `Card = { type: "card"; card: ShownCard } | { type: "keep-lower"; decision: ClaimDecision } | { type: "proposal"; item } | { type: "done" }`.
- **Routes:**
  - `POST /api/answer { responseId, answer: 0|1|2|3|4|"wouldnt_say" }`
  - `POST /api/skip { parentId }`
  - `POST /api/claim { claimNodeId, choice }`

  The old rate, answer-text and judge routes are removed. The forest, edit and decide routes stay.
- **The page's card:**
  - the concept's name, large, and its definition in the reading serif;
  - its path ("Knowledge › Computer science › Machine learning");
  - why it's asked ("We guessed you probably know this", "A part of Machine learning", "An area you haven't told us about");
  - six buttons with the keys `4 3 2 1 0 w`;
  - for a part card, "Skip the rest of <parent>" (`s`).
- **The command** prints `Finished: answered <n> cards, settled <s> guesses.`
- The README's probing section is rewritten for cards.
- [ ] **Failing tests:**
  - the card order over HTTP (guess → its parts → done);
  - answer 409 on a second answer;
  - skip;
  - keep-lower;
  - the CLI e2e finishes with the new line.

  Then implement, then `pnpm test && pnpm typecheck && pnpm guard`. All PASS.
- [ ] **Browser:** on the demo, answer by keys, walk a split, skip the rest, check the forest shows stated lighting, and check phone width and dark mode.
- [ ] Commit: `The review page asks concept cards`
