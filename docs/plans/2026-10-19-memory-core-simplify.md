# Memory Core, Simplified: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution: Claude implements inline (the user's standing choice: no Codex, no subagents).

**Goal:** Remove the memory core's guessed weights and its multilingual support. In their place:
- plain review-queue rules, with each decision logged;
- "Still true?" cards instead of silent expiry;
- raw text kept until purged, and no review cap;
- a recall@k experiment for duplicate search.

**Architecture:** Mostly deletions, across `schema`, `store`, `compaction`, `interview`, the demo persona and the CLI. New pieces:
- a SQLite migration (drop the language, confidence and salience columns; add `queue_decisions`);
- a typed review-item queue;
- a dedup eval module with a labeled dataset;
- the CLI commands `keep`, `expire`, `purge` and `eval dedup`.

**Tech Stack:** Node 24, TypeScript (strict), zod v4, vitest, `node:sqlite`.

**Spec:** `docs/specs/2026-10-18-memory-core-simplify.md`, amending `docs/specs/2026-10-01-sp1-memory-core.md`.

## Global Constraints

- **English only.** No `Lang` type, no `lang` field or column, and no `--lang` or `--languages` flags anywhere.
- **The guard:** `ObservationInput` rejects text in which more than half of the letters (`\p{L}`) are not Latin script (`\p{Script=Latin}`). The message is exactly `standin is English-only for now`. Text with no letters passes.
- **Queue order:**
  1. contradictions;
  2. "Still true?" cards;
  3. updates (`supersedesId` set);
  4. new.

  Within a group: more distinct source observations first, then oldest `recordedAt` first, then id.
- **Still-true trigger:** an approved memory with `isCurrentState` whose `lastCorroboratedAt` is older than `consolidation.freshnessDays` (default **120**), unless a proposed memory already supersedes or conflicts with it.
  - **Keep** sets `lastCorroboratedAt = now`, with the event note "still true".
  - **Expire** uses actor `person`, with the note "no longer true".
- **Nothing expires silently.** `consolidate` expires only memories whose `validUntil` has passed.
- **Purging:** raw observation text and span content are purged only by `standin purge --before <date>`, or by `consolidate` when the optional `consolidation.purgeAfterDays` is set. The old `retentionDays` key is ignored, so existing configs stop purging.
- **AI-memory sources** (`claude-memory`, `chatgpt-memory`, `muse-paste`) are labeled `unverified` wherever sources are shown.
- **Queue decisions:** every approve or reject made through the CLI records the item's 0-based queue position at decision time (null if it wasn't in the queue), its group, and the decision.
- **Commits:** Mingxi is the author. Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **An instance created before this change**, with a `config.json` holding `persona.languages`, `review.weeklyCap` and `consolidation.retentionDays: 90`. It loads without error, the old keys are ignored, and `consolidate` purges nothing. Tested in Task 1.
2. **A database at migration 3 holding Chinese observations and memories.** Migration 4 succeeds and the rows survive, minus their `lang`. The queue and `memories` list them, but nothing new in Chinese can be added. Tested in Task 2.
3. **Mostly-English text with a few non-Latin words**, e.g. "I learned Go (围棋) from my grandfather", or code and emoji. It passes the guard. A mostly-Chinese paragraph is rejected with the exact message. Tested in Task 1.
4. **Approving by id something that isn't in the current queue**, e.g. an exemplar, or a memory already approved elsewhere. The decision is logged with `position: null`, and nothing crashes. Tested in Task 6.
5. **A stale current-state memory that already has a pending update** ("currently reading A", with a proposal for "currently reading B"). It gets no still-true card, because the update card covers it. Tested in Task 3.

---

### Task 0: Branch setup

- [ ] Branch `simplify-memory-core` from `main` (which has PR #3 merged).
- [ ] `pnpm install && pnpm typecheck && pnpm test` is green (169 passed, 3 skipped).

### Task 1: `@standin/schema`: English only, no confidence or salience, slimmer config

**Files:** modify `packages/schema/src/{records.ts,config.ts,index.ts}`; tests in `packages/schema/test/schema.test.ts`.

**Changes:**
- **`records.ts`:**
  - Delete `Lang`.
  - Remove `lang` from `ObservationInput`, `Observation`, the memory base, `Exemplar` and `PreferencePair`.
  - Remove `confidence` and `salience` from the memory base.
  - Add `export function isMostlyLatin(text: string): boolean`, and refine `ObservationInput.text` with it, using the exact message.
- **`config.ts`:**
  - Delete `persona.languages` and `review`.
  - Delete `consolidation.retentionDays` and `consolidation.currentStateHalfLifeDays`.
  - Add `consolidation.purgeAfterDays: z.number().positive().optional()`.
  - Keep `freshnessDays` (default 120).

**Steps:**
- [ ] Write the failing tests:
  - `isMostlyLatin`: true for "I learned Go (围棋) from my grandfather"; false for a mostly-Chinese sentence; true for "12345 🎲".
  - `ObservationInput` rejects the Chinese sentence with `standin is English-only for now`.
  - `parseConfig` accepts an old config object with `persona.languages`, `review.weeklyCap` and `consolidation.retentionDays: 90`. The result has no such keys and `purgeAfterDays` is undefined (Review Focus 1, 3).
  - Memory parsing no longer needs `lang`, `confidence` or `salience`.
- [ ] Implement. `pnpm typecheck` now fails across packages. That's expected, and Tasks 2–7 fix it. Run only `pnpm vitest run packages/schema`, which passes. Commit at the end of Task 2, together with the store, so `main`-style history stays typecheck-clean.

### Task 2: `@standin/store`: migration 4, sources, still-true, purge, queue decisions

**Files:** modify `packages/store/src/{migrations.ts,memories.ts,exemplars.ts,consolidate.ts,store.ts,text.ts,rows.ts,index.ts}`; delete `packages/store/src/confidence.ts` and `test/confidence.test.ts`; tests in `test/{lifecycle,consolidate,observations,neighbors}.test.ts` and new `test/simplify.test.ts`.

**Migration 4:**
```sql
ALTER TABLE observations DROP COLUMN lang;
ALTER TABLE memories DROP COLUMN lang;
ALTER TABLE memories DROP COLUMN confidence;
ALTER TABLE memories DROP COLUMN salience;
ALTER TABLE exemplars DROP COLUMN lang;
ALTER TABLE preference_pairs DROP COLUMN lang;
CREATE TABLE queue_decisions (
  id TEXT PRIMARY KEY, item_id TEXT NOT NULL, item_kind TEXT NOT NULL,   -- memory | still-true | exemplar
  queue_group TEXT, position INTEGER, decision TEXT NOT NULL,            -- approve | reject | keep | expire
  at TEXT NOT NULL
);
```

**Produces:**
```ts
export interface SourceSummary { counts: { sourceKind: SourceKind; count: number }[]; distinct: number; unverified: boolean }
store.memorySourceSummary(id: string): SourceSummary;
store.staleCurrentState(freshnessDays: number): Memory[];     // the still-true trigger (Global Constraints)
store.keepCurrent(id: string): Memory;                         // throws InvalidTransitionError unless approved and current-state
store.expire(id: string, note?: string, actor?: Actor): Memory;// actor defaults to "consolidation"; the CLI passes "person"
store.purge(before: string): { observations: number; spanContent: number };
store.recordQueueDecision(d: { itemId: string; itemKind: "memory" | "still-true" | "exemplar"; group: string | null; position: number | null; decision: "approve" | "reject" | "keep" | "expire" }): void;
// ConsolidationReport becomes { expired: string[]; purged: number; purgedSpanContent: number }  (no "recomputed")
// insertMemory's InsertContext loses `salience`; openStore loses `currentStateHalfLifeDays`
```
- **Removed:** `computeConfidence`, `recomputeConfidence`, `SOURCE_WEIGHTS`, `ROLE_FACTORS`.
- **`text.ts`:** drop the CJK wording in the comments. The logic is unchanged, since NFKC and bigrams work for English.
- **`consolidate`** expires memories past `validUntil`, then purges only if `purgeAfterDays` is set.

**Steps:**
- [ ] Write the failing tests:
  - **Migration (Review Focus 2):** a db built with migrations 1–3 and a Chinese observation and memory row migrates to 4 and reads back without `lang`.
  - **`memorySourceSummary`:** an interview source twice plus a slack source gives distinct 3; a `claude-memory` source sets `unverified`.
  - **`staleCurrentState`:**
    - excludes a fresh memory;
    - includes a 121-day-old one;
    - excludes one with a pending proposal that supersedes it (Review Focus 5).
  - **Keep and expire:** `keepCurrent` renews it so it's no longer stale, with an event note "still true". `expire(id, "no longer true", "person")` records actor `person`.
  - **No silent expiry:** `consolidate` with defaults never expires a stale current-state memory and never purges, but does expire a memory whose `validUntil` is past.
  - **`purge`:** clears text and span content before the date, and keeps hashes.
  - **`recordQueueDecision`:** round-trips a row.
- [ ] Update the existing store tests: drop the confidence assertions, and change the consolidation expectations.
- [ ] Implement. `pnpm vitest run packages/schema packages/store` passes. Commit both tasks: "Drop languages, confidence and salience from schema and store".

### Task 3: `@standin/compaction`: plain queue, English-only extraction

**Files:** modify `packages/compaction/src/{compact.ts,batch.ts,queue.ts,prompts.ts,schemas.ts,index.ts}`; delete `src/salience.ts` and `test/salience.test.ts`; tests in `test/{queue,compact,batch}.test.ts`.

**Produces:**
```ts
export type QueueGroup = "contradiction" | "still-true" | "update" | "new";
export interface ReviewItem { kind: "memory" | "still-true"; group: QueueGroup; memory: Memory; sources: SourceSummary }
export function reviewQueue(store: Store, config: Config): ReviewItem[];   // full queue, no cap, ordered per Global Constraints
```
- **`ExtractionSchema`** loses `lang` on memories.
- **The extraction prompt** says: write each memory as one first-person English sentence.
- **Exemplars** carry no `lang`.
- **`compact` and `compactBatch`** no longer compute confidence or salience.

**Steps:**
- [ ] Write the failing tests:
  - **Queue order:** with one of each kind (a contradiction, a stale current-state memory, an update, two new with 1 and 2 sources), `reviewQueue` returns the groups in order. The 2-source new item precedes the 1-source one. Equal sources fall back to oldest first.
  - **No duplicate card:** a stale memory with a pending update appears only as the update.
  - **English extraction:** the extraction prompt contains "English" and no longer contains "language of the source text".
- [ ] Implement. Update the compaction tests' fixtures (no `lang`). `pnpm vitest run packages/compaction` passes. Commit "Order the review queue by plain rules".

### Task 4: `@standin/interview` and the demo persona: English only

**Files:**
- interview: modify `packages/interview/src/{bank.ts,template.ts,observation.ts,parse.ts,index.ts}` and delete `src/lang.ts`; test in `test/interview.test.ts`;
- demo persona: modify `examples/demo-persona/observations.jsonl` and `src/fixtures.ts`.

- **`Question`** becomes `{ id; text; feeds; hint?: string }`, and `Section` becomes `{ id; title; questions }`. The Chinese strings are deleted.
- **The intro** loses "Mix languages freely." The hint "In both languages, if you use both." is deleted.
- **`renderTemplate(bank)`** has no lang parameter.
- **`answerToObservation(a, { bankId, occurredAt })`** writes `Q: {question}\n\nA: {answer}`.
- **The two Chinese demo observations become English with the same meaning:**
  - "I grew up playing Go with my grandfather, so building game AI was no surprise. Honestly, my grasp of reinforcement learning theory isn't deep; it's mostly engineering experience."
  - "I'd rather not discuss my salary publicly; feel free to email me about it."

  Their fixtures become English with the same kinds, tiers and entities ("Go", "salary"), and the competence domain becomes "reinforcement learning theory". The end-to-end counts don't change.

**Steps:**
- [ ] Update the failing interview tests:
  - The template has no `zh` text and no `--lang` handling.
  - The parse round-trip still works.
  - The observation text uses the English question.
- [ ] Implement. `pnpm vitest run packages/interview examples` passes. Commit "Make the interview kit and demo persona English-only".

### Task 5: Dedup eval

**Files:** create `packages/compaction/src/dedup-eval.ts` and `packages/compaction/eval/dedup.jsonl`; test `packages/compaction/test/dedup-eval.test.ts`.

**Dataset format**, one case per line:
```json
{"id": "para-01", "existing": [{"statement": "I led the robotics club's vision team.", "entities": [{"name": "robotics club", "kind": "org"}]}],
 "candidate": {"statement": "I headed computer vision for the robotics club.", "entities": [{"name": "robotics club", "kind": "org"}]},
 "expect": 0, "note": "paraphrase, shared entity"}
```
- `expect` is the index of the existing memory it should retrieve, or `null` (expect nothing; it counts toward the false-candidate average only).
- **About 30 cases:**
  - the demo persona's duplicate, update and contradiction cases;
  - 10 paraphrases sharing an entity;
  - 10 paraphrases with no shared entity;
  - 5 unrelated distractors.

  Each case has 3–6 existing memories, so retrieval has something to choose from.

**Produces:**
```ts
export type RetrievalMethod = { name: string; describe: string; retrieve(store: Store, q: { statement: string; entityIds: string[] }, k: number): string[] };
export const METHODS: RetrievalMethod[];   // "dice≥0.3+entity" (current findNeighbors), "dice-topk+entity" (no threshold), "entity-only"
export interface MethodReport { method: string; recall: Record<1 | 4 | 8, number>; avgCandidates: number; misses: string[] }  // misses: case ids not retrieved at k=8
export function evalDedup(cases: DedupCase[], methods?: RetrievalMethod[]): MethodReport[];
export function loadDedupCases(path?: string): DedupCase[];
```
- Each case runs in a fresh temp store, built with `insertMemory` and `resolveEntity`.

**Steps:**
- [ ] Write the failing tests:
  - On a 3-case inline set, `evalDedup` gives the expected recall for each method: entity-only finds a shared-entity paraphrase and misses a no-entity paraphrase.
  - `loadDedupCases()` parses the shipped file, and every `expect` index is in range.
- [ ] Write the dataset and implement. Commit "Add a recall@k experiment for duplicate search".

### Task 6: CLI

**Files:** modify `apps/cli/src/commands/{init.ts,observe.ts,interview.ts,queue.ts,decide.ts,memories.ts,consolidate.ts,index.ts}`, `apps/cli/src/{format.ts,home.ts,main.ts}`; create `commands/{purge.ts,eval.ts}`; tests in `apps/cli/test/e2e.test.ts` and a new `test/simplify.test.ts`. Update `README.md`.

**USAGE changes:**
```
  init [--name N] [--demo]                       (no --languages)
  observe --source K --role R [--ref S] [--occurred ISO] [--file F]
  interview template [--bank B] [--out F | --stdout]
  interview import <file> [--occurred ISO] [--dry-run]
  queue                                          the review queue, in order: contradictions, still true?, updates, new
  keep <id>                                      a "currently…" memory is still true (renews it)
  expire <id>                                    a "currently…" memory is no longer true
  purge --before ISO                             delete raw text and trace text for observations compacted before ISO
  eval dedup [--json]                            recall@1/4/8 of each duplicate-search method on the labeled set
```
- **`queue`:**
  - Prints a `group` column and a `sources` column ("interview×2, slack", with "unverified" appended where relevant) instead of `conf`.
  - Still-true rows read `still true? "<statement>" (last mentioned <date>)`.
  - Footer: "Approve with: standin approve <id> · still-true: standin keep|expire <id>".
- **Decision logging:** `approve`, `reject`, `keep` and `expire` compute the queue first and call `recordQueueDecision`, with the position and group, or `null` if the item isn't in the queue (Review Focus 4).
- **`memories`** shows `sources` instead of `conf`.
- **`consolidate`** prints "expired N" (plus the purge counts only when `purgeAfterDays` is set).
- **`format.ts`:** `displayWidth` becomes plain string length.
- **`home.ts`** no longer passes the half-life.
- **README:** remove the bilingual claims, the confidence and the weekly cap. Describe the queue order, still-true cards, `purge`, and the dedup eval.

**Steps:**
- [ ] Write the failing tests:
  - **End to end on the demo:** `init --demo` → `compact --demo-llm` → `queue --json` groups in order → `approve` logs a decision with a position.
  - **Still-true flow:** advance the clock 121 days → `queue` shows still-true rows → `keep` one and `expire` another.
  - **`purge --before`** clears text.
  - **Review Focus 4:** `approve exm_…` logs with position null.
  - **Guard:** `observe` with Chinese stdin fails with "English-only".
  - **`eval dedup --json`** reports 3 methods.
- [ ] Implement. Run `pnpm typecheck && pnpm test && pnpm guard`; all green. Commit "Simplify the CLI: plain queue, still-true cards, purge, dedup eval".

### Task 7: Run the experiment, then finish

- [ ] Run `standin eval dedup` and paste the report to Mingxi. **Mingxi picks the default method** (spec §4). If they pick a method other than the current one, switch `findNeighbors` to it in a small commit and adjust its tests.
- [ ] Self-review the branch diff against the spec (§2–§7) and the Review Focus.
- [ ] Push `simplify-memory-core` and open a PR, titled "Simplify the memory core: English only, plain queue rules, measured dedup". The body covers what changed, the experiment result, and the test plan, and ends with the Claude Code line. Merging needs Mingxi's OK.
