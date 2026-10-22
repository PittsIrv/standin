# WT-2: Hypotheses and Learning. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution: Claude implements inline (the user's standing choice: no Codex, no subagents).

**Goal:** "Probably knows" becomes hypothesis nodes, which:
- come from a `hypothesize` model and from background seeding;
- are guarded against snowballing and sensitive categories;
- are calibrated by per-cell Beta counts;
- are probed most-uncertain first, then confirmed (lighting directly) or refuted by the person's ratings.

Inference rules, foundations, discovery and inferred-lighting proposals go away.

**Architecture:**
- **Migration 8** adds:
  - `hypotheses`;
  - a `kv` table;
  - `probes.hypothesis_id`;
  - `probe_responses.predicted_p` and `prior_p`.

  It also converts approved inferred lighting into open hypotheses and withdraws pending inferred proposals.
- **`@standin/knowledge`** gains a `hypotheses/` module:
  - `sensitive.ts`, `guards.ts`, `calibrate.ts`, `hypothesize.ts`;
  - lighting reads confirmed hypotheses as `probed`;
  - `answerMode` speaks probable nodes hedged;
  - the planner probes hypotheses by uncertainty.

**Tech Stack:** Node 24, TypeScript (strict), zod v4, vitest, `node:sqlite`.

**Spec:** `docs/specs/2026-10-21-world-tree.md` §3.4, §4, §5, §6.2, §6.3, §9, decisions 46–54. Knowledge-map decision 37 (two passed spot-checks at 4) stands.

## Global Constraints

- **`EvidenceKind`** = `background | part | prerequisite | work | other`. **`RawScore`** = `low | medium | high`. **`HypothesisStatus`** = `open | settled | withdrawn`.
  - The outcome of a settled hypothesis is **derived on read** from its responses: `confirmed` or `refuted`. So a spot-check graded later can still flip it.
- **Config** `hypotheses`:
  - `speakAt` 0.8;
  - `dropBelow` 0.3;
  - `dropAfter` 10;
  - `brierWindow` 20;
  - `priorCap` 10 (used in WT-3).
- **Cells and probability.** A cell is `kind × rawScore`. `P = (confirmed + a) / (confirmed + refuted + a + b)`, with `a = b = 1` unless priors are loaded (WT-3 stores them in `kv` under `priors`).
- **Which outcomes count:**
  - for learning, only **usable** responses: holdout `none`, or `rotating` once released;
  - for the Brier safeguard, only **held-out** responses, scored on the stored `predicted_p` against `prior_p`.
- **Outcome of a hypothesis probe:**
  - **confirmed:** `know` or `roughly` with no failed spot-check;
  - **refuted:** `no_idea`, or a failed spot-check;
  - **withdrawn:** `wouldnt_say`. The boundary applies as before.
  - **Depth 4** settles only on the second confirming probe at 4. Both are always spot-checked (decision 37). A refutation at 4 settles at once.
- **Guards** (spec §4.2). They reject a proposal when any of these hold:
  - its node isn't a Knowledge node;
  - its path is longer than 3 nodes (2 hops), or empty;
  - two consecutive path nodes share no live edge (any kind, either direction);
  - the path's first node is not **established**, meaning its own claim, probed lighting, gap, or a confirmed hypothesis. An open hypothesis never counts;
  - the node already has its own claim, probed lighting or gap;
  - the depth isn't 1–4;
  - its node name or reason matches a sensitive category.
- **Sensitive categories** (spec §6.2): health, religion, sexuality, gender identity, politics, ethnicity or race, immigration status, finances, criminal history, trade-union membership. `isSensitive(text)` is a deterministic word-boundary match against a keyword list per category.
- **Lighting sources after WT-2:**
  - claims;
  - approved `probed` lighting;
  - confirmed hypotheses (basis `probed`);
  - gaps;
  - inheritance.

  No seeding, upward or prerequisite rules. Probable nodes come from open hypotheses on nodes with no lighting of their own.
- **`answerMode` for a probable node.** It applies when the node's own path has no lighting or gap, and the node has an open hypothesis with `P ≥ speakAt`. Then the mode is `min(modeFor(depth), "brief")` and `from.via = "hypothesis"`. Otherwise it is `decline`.
- **Probe priority:**
  1. follow-ups;
  2. claim checks;
  3. open hypotheses, smallest `|P − 0.5|` first, then by name.
- **`ProbeKind`** gains `hypothesis`. `foundation` and `discovery` remain only so old rows still parse.
- **Commits:** the author is the repo's git user. Every message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Upgrading an instance with approved inferred lighting.** Each such node must end up probable, not lit, and must never be both. Task 1's migration test.
2. **A spot-check graded `fail` after a hypothesis was confirmed** must turn it refuted and unlit at the next read. Task 4.
3. **A held-out rotating probe** must not settle its hypothesis or move the counts until it is released. A fixed one never does. Task 3 and Task 6.
4. **Model output that names unknown nodes or ids, cites an open hypothesis, or names a sensitive topic** is dropped, and the rest is applied. Task 2 and Task 5.
5. **A model failure in `hypothesize`** is one warning. Refresh and sessions continue. Task 5.

---

### Task 1: Schema, migration 8, store

**Files:** `packages/schema/src/{records,config,ids,roles}.ts`, `packages/store/src/{migrations,probes,store,index}.ts`, new `packages/store/src/hypotheses.ts`; tests `packages/store/test/hypotheses.test.ts`, `packages/store/test/migration-8.test.ts`, `packages/schema/test/schema.test.ts`.

**Interfaces:**
- **Schema:**
  - `Hypothesis { id, nodeId, depth (1–4), rawScore, kind: EvidenceKind, path: string[], reason, status, createdAt, settledAt: string|null }`.
  - The id prefix `hyp`.
  - `Probe.hypothesisId: string | null` (default null).
  - `ProbeResponse.predictedP`, `priorP: number | null` (default null).
  - `ProbeKind += "hypothesis"`.
  - Config `hypotheses` (Global Constraints).
  - Role `hypothesize: { tier: "large", zone: "private", purpose: "Predict what the person probably knows, with the evidence for each guess" }`.
- **Migration 8:**
  - the tables `hypotheses` and `kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
  - the columns `probes.hypothesis_id`, `probe_responses.predicted_p` and `prior_p`;
  - **data conversion,** as a function:
    - each **approved** competence memory with `attrs.basis = "predicted"` becomes an open hypothesis (node = its linked topic, depth, raw `medium`, path `[node]`, reason = joined reasons);
    - its kind comes from the reasons: `core of your background` → `background`, `is part of it` → `part`, `needed for` → `prerequisite`, else `other`;
    - the memory itself is retracted, with an event whose actor is `map` and whose note is `replaced by a hypothesis`;
    - each **proposed** one is rejected, with actor `map` and note `withdrawn: inferred lighting is now a hypothesis`.
- **Store:**
  - `insertHypothesis(h: Omit<Hypothesis,"id"|"status"|"createdAt"|"settledAt">): Hypothesis`
  - `listHypotheses(f?: { status?; nodeId? }): Hypothesis[]`
  - `getHypothesis(id)`
  - `settleHypothesis(id): Hypothesis`
  - `withdrawHypothesis(id): Hypothesis`
  - `getKv(key): string | null` and `setKv(key, value)`
  - `insertProbe` accepts `hypothesisId`. `showProbe(probeId, sessionId, mode, p?: { predictedP: number; priorP: number })`.
- [ ] **Failing tests:**
  - schema defaults and the role;
  - store round-trip: insert, list by status or node, settle and withdraw, kv;
  - a probe carrying `hypothesisId` and the response's stored `predictedP` and `priorP`;
  - **migration 8 test:**
    - `migrate(db, 7)`;
    - raw insert of an approved predicted memory linked to a topic (reason "core of your background: …"), and a proposed one;
    - `migrate(db)` gives one open `background` hypothesis at that depth, the approved memory `retracted`, and the proposed one `rejected`.
- [ ] Implement, then `pnpm vitest run packages/schema packages/store`. PASS.
- [ ] Commit: `Hypotheses in the store; migration 8 turns inferred lighting into hypotheses`

### Task 2: Sensitive categories and guards

**Files:** `packages/knowledge/src/hypotheses/{sensitive,guards}.ts`, `packages/knowledge/src/index.ts`; tests `packages/knowledge/test/hypotheses-guards.test.ts`, `packages/knowledge/test/sensitive-cases.json` (the tricky-case set).

**Interfaces:**
- `SENSITIVE_CATEGORIES: Record<string, string[]>` and `isSensitive(text: string): string | null` (returns the category).
- `checkHypothesis(t: TreeSnapshot, p: { nodeId: string; depth: number; path: string[]; reason: string }, edges: TopicEdge[]): string | null` returns the reason it is rejected, or null when it is fine.
- `established(t: TreeSnapshot, nodeId): boolean`.
- [ ] **Failing tests:**
  - `sensitive-cases.json` holds about 30 cases `{ text, category | null }`. Examples:
    - "Insulin dosing" → health; "HIV treatment" → health;
    - "Torah study" → religion; "Arabic" → null (a language, not a religion); "Islamic finance" → religion;
    - "Democratic Party" → politics; "political philosophy" → null;
    - "Spanish" → null; "Mandarin" → null;
    - "tax returns" → finances; "game theory" → null;
    - "LGBTQ community" → sexuality; "asylum process" → immigration status.

    Each one matches.
  - The guards, one test per rule in Global Constraints. Snapshots are built with `knowledge/test/fixtures.ts`, plus a Life node and hypotheses.
- [ ] Implement, then `pnpm vitest run packages/knowledge/test/hypotheses-guards.test.ts`. PASS.
- [ ] Commit: `Guards against guesses on guesses and on sensitive categories`

### Task 3: Calibration from outcomes

**Files:** `packages/knowledge/src/hypotheses/calibrate.ts`; test `packages/knowledge/test/hypotheses-calibrate.test.ts`.

**Interfaces:**
- `outcomeOf(h: Hypothesis, responses: (ProbeResponse & { probe: Probe })[]): "confirmed" | "refuted" | null`. It reads only the usable responses whose `probe.hypothesisId === h.id`, and applies the depth-4 rule.
- `cells(store, priors?: Record<string, {a:number;b:number}>): Map<string, { confirmed: number; refuted: number; a: number; b: number; p: number }>`. The key is `${kind}:${rawScore}`. All 15 cells are always present.
- `probabilityOf(h, cells, opts: { safeguard: boolean }): number`. It returns the prior-only `a/(a+b)` when the safeguard is tripped.
- `safeguard(store, window: number): { tripped: boolean; calibrated: number | null; prior: number | null; n: number }`. It takes the Brier score over the last `window` held-out hypothesis responses that have a non-null `predictedP`. A response with no outcome (`wouldnt_say`) is skipped. It trips when `calibrated > prior`.
- `loadPriors(store): Record<string,{a,b}> | undefined` reads `kv("priors")`.
- [ ] **Failing tests:**
  - counts and `P` from scripted outcomes;
  - rotating responses don't count until released, and fixed ones never;
  - a later failed grade flips confirmed to refuted;
  - depth 4 needs two confirmations;
  - the safeguard trips when calibrated predictions scored worse;
  - every cell is present with `p = 0.5` on an empty store.
- [ ] Implement, then run the file. PASS.
- [ ] Commit: `Reliability counts per evidence kind and score, with a Brier safeguard`

### Task 4: Lighting, answering and the snapshot

**Files:**
- `packages/knowledge/src/{snapshot,lighting,answer,gaps,refresh,index,tree-view}.ts`, `packages/knowledge/src/tasks.ts` (seeding);
- delete `packages/knowledge/src/proposals.ts` and `probing/discovery.ts`, with their tests (`proposals.test.ts` and the discovery half of `grade-discovery.test.ts`).

Update `lighting.test.ts`, `refresh.test.ts`, `answer.test.ts` and `apps/cli/test/map.test.ts`, keeping their intent.

**Interfaces:**
- **Snapshot:**
  - `TreeSnapshot.hypotheses: Map<nodeId, { id; depth; p; kind; rawScore }>` holds open hypotheses with `p` computed via Task 3.
  - `TreeSnapshot.confirmedHypotheses: Map<nodeId, depth>` holds the highest confirmed depth per node.
  - `seeded` and `confirmed` stay for old data, but no rule reads them.
- `computeLighting(t)` reads claims, approved `probed`, and `confirmedHypotheses` (basis `probed`, reason `probe confirmed: <kind>`).
- `answerMode(t, nodeId, opts?: { speakAt?: number })` follows Global Constraints. `AnswerDecision.from.via` gains `"hypothesis"`.
- **Seeding.** `seedBackground` still creates the field and core nodes, then inserts open hypotheses for each (kind `background`, depth 2, raw `medium`, path `[field]` for the field itself and `[field, core]` for a core node), skipping any that already exist. *Ruling inside the plan:* a hypothesis seeded straight from a background **fact** cites the fact's node as the established start. Here, the field node counts as established while its seed memory is approved. `established()` gains that one extra case.
- **Refresh** no longer proposes lighting. `RefreshReport` drops `proposed` and `replaced` and gains `hypotheses: { added; withdrawn; rejected }` (filled in Task 5).
- **Tree view:**
  - `TreeNode.state` gains `"probable"`;
  - `TreeNode.p` and `TreeNode.hypothesis` (`{ depth; p; kind; reason }`) are filled for probable nodes;
  - `nodeStatus` prints `probable 2 (p 0.64, background)`.
- [ ] **Failing tests:**
  - a seeded CS background gives probable nodes (not lit) at 2 with p 0.5;
  - a confirmed hypothesis lights its node `lit 2 (probed)`;
  - a later failed spot-check unlights it;
  - `answerMode` on a probable node with p 0.9 is `brief` via `hypothesis`, and with p 0.6 it is `decline`;
  - a claim on the node overrides the hypothesis.
- [ ] Implement and delete the replaced modules. Then `pnpm vitest run packages/knowledge apps/cli`. PASS.
- [ ] Commit: `Hypotheses replace inference rules; confirmed ones light, probable ones speak hedged`

### Task 5: The hypothesize role

**Files:** `packages/knowledge/src/hypotheses/hypothesize.ts`, `prompts.ts`, `schemas.ts`, `refresh.ts`; `examples/demo-persona/src/{index,fixtures}.ts`; test `packages/knowledge/test/hypothesize.test.ts`.

**Interfaces:**
- **Schema:** `HypothesizeSchema = { hypotheses: [{ node, depth, rawScore, kind, path: string[] /* node names */, reason }], withdraw: string[] /* node names */ }`.
- `hypothesize(store, model, personaName, cfg): Promise<{ added: number; withdrawn: number; rejected: string[] }>`:
  - **One `hypothesize` call, purpose `hypothesize`.** The prompt contains:
    - the Knowledge subtree with each node's state;
    - the approved background and work facts;
    - the open hypotheses;
    - each cell's `p` and outcome count.
  - **Names to ids.** Names resolve to Knowledge nodes, case-insensitively, and to frontier nodes too. Unknown names are rejected.
  - **Checks.** Each proposal is checked by `checkHypothesis`, and dropped when its cell has `P < dropBelow` after at least `dropAfter` outcomes.
  - **Incremental:**
    - an open hypothesis at the same node and depth is kept;
    - one at a different depth is withdrawn and replaced;
    - `withdraw` names withdraw that node's open hypothesis.
  - **Rejected** entries are `"<node>: <reason>"`.
- **Skipping the call.** The call is skipped, and the result is zeros, when nothing changed since the last run: no memory decided, response rated, or hypothesis settled after `kv("hypothesize.lastRun")`. The time of the run is written to `kv` after it.
- **Refresh** runs seed → place → home → split → gaps → hypothesize. A failure is a warning.
- **Demo:**
  - `hypothesize` returns two fixture hypotheses:
    - `Python` at 2, kind `other`, path `[Rust, Programming languages, Python]`, reason "a language next to one you know well";
    - `Game AI` at 2, kind `part`, path `[game-playing AI, Game AI]`;
  - `withdraw: []`.
- [ ] **Failing tests:**
  - valid proposals are added;
  - an unknown node, a path from an open hypothesis, a sensitive node ("Insulin dosing" placed under Knowledge) and an over-long path are rejected with reasons;
  - a changed depth replaces the old hypothesis;
  - a second run with no changes makes no call;
  - a model failure becomes a refresh warning.
- [ ] Implement, then `pnpm vitest run packages/knowledge examples`. PASS.
- [ ] Commit: `The hypothesize role proposes guarded, incremental hypotheses`

### Task 6: Probing hypotheses

**Files:** `packages/knowledge/src/probing/{plan,session,quiz,expand}.ts`; tests `packages/knowledge/test/plan.test.ts`, `session.test.ts` (updated: foundation and discovery cases are replaced by hypothesis cases).

**Interfaces:**
- **Plan.** `Target` gains `{ kind: "hypothesis"; nodeId; difficulty; hypothesisId }`. `nextTarget` priority follows Global Constraints. A depth-4 hypothesis whose first probe confirmed asks once more at 4. The foundation and discovery branches are removed.
- **Writing probes.** `ProbeSession.probeFor` writes hypothesis probes with `hypothesisId`.
- **Showing a probe.** `next()` stores `predictedP` and `priorP` for hypothesis probes, via Task 3, before the rating.
- **Rating.** `rate()`:
  - for a hypothesis probe at 4, always requests a spot-check;
  - after rating, settles the hypothesis when its outcome is decided (Task 3's `outcomeOf` on usable responses), or withdraws it on `wouldnt_say`;
  - a held-out probe does not settle until release. `releaseAndDefer` then re-checks the hypotheses of the probes it released.
- **Finishing.** `FinishReport` drops `discoveryProposals` and gains `settled: number`.
- **Refresh at start.** `SessionDeps` gains optional `splitAt` and `hypotheses` (config), passed to `refresh`.
- [ ] **Failing tests:**
  - the most uncertain hypothesis is asked first;
  - a confirmation settles it and lights the node;
  - `no_idea` refutes it;
  - `wouldnt_say` withdraws it and sets the boundary;
  - depth 4 asks twice, both spot-checked;
  - a rotating held-out hypothesis probe settles only at finish (release);
  - `predictedP` is stored when shown.
- [ ] Implement, then `pnpm vitest run packages/knowledge`. PASS.
- [ ] Commit: `Sessions probe hypotheses, most uncertain first`

### Task 7: The CLI shows hypotheses

**Files:** `apps/cli/src/commands/map.ts`; test `apps/cli/test/map.test.ts`.

**Interfaces:**
- **`standin map`:** probable nodes read `probable 2 (p 0.50, background)`. `map refresh` prints `hypotheses: +A, withdrawn W, rejected R` with the reasons for rejection.
- **`--private`** adds `Hypothesis calibration: Brier X (calibrated) vs Y (prior) over N held-out answers`, or `not enough held-out hypothesis answers yet`. It also adds `using prior-only probabilities` when the safeguard is tripped.
- **`map --json`** nodes carry `state: "probable"`, `p` and `hypothesis`.
- [ ] **Failing tests:** on the demo, after `map refresh`, Algorithms reads `probable 2 (p 0.50, background)`, and `--private` prints the hypothesis-calibration line.
- [ ] Implement. Then `pnpm test && pnpm typecheck && pnpm guard`. All PASS.
- [ ] Commit: `standin map shows hypotheses and their calibration`
