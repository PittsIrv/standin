# SP1 Memory Core: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution: Claude implements inline (the user chose this on 2026-10-01; no Codex, no subagents).

**Goal:** A working local memory core: schema, SQLite store with lifecycle and bitemporal history, LLM compaction, consolidation, CLI, and a demo persona that runs end to end offline.

**Architecture:** pnpm TypeScript monorepo. Packages export TS source (no build step). `schema` (zod) ← `store` (node:sqlite) ← `compaction` (uses an `llm` interface) ← `cli`. The demo persona ships a ScriptedLLM so CI never needs the network.

**Tech Stack:** Node 24, pnpm, TypeScript (strict), zod, vitest, tsx, `node:sqlite`, `@anthropic-ai/sdk`.

**Spec:** `docs/specs/2026-10-01-sp1-memory-core.md` (parent: `docs/specs/2026-10-01-standin-architecture.md`).

## Global Constraints

- Node ≥ 22.13 (`engines`); `node:sqlite` only, with no native SQLite dependency.
- IDs: prefix + 12 lowercase hex characters (`obs_`, `ent_`, `mem_`, `exm_`, `evt_`, `pp_`). Times are ISO-8601 UTC strings. The clock is injected everywhere.
- `STANDIN_HOME` defaults to `~/.standin`; the DB is `standin.db`, the config is `config.json`.
- Default compaction model is `claude-opus-5-5`; Anthropic calls go only through `@anthropic-ai/sdk` (`messages.parse` + `zodOutputFormat`).
- Statuses: `proposed | approved | rejected | superseded | expired | retracted`; transitions are enforced and every change is logged to `memory_events`.
- Source weights, role factors, kind and novelty weights, and defaults (`batchSize` 20, `retentionDays` 90, `freshnessDays` 120, `currentStateHalfLifeDays` 90, `weeklyCap` 25) are exactly as in the spec.
- License Apache-2.0. Instance data must never be committed; the guard runs in the pre-commit hook and in CI.

## Review Focus

1. **Compaction interrupted mid-observation and re-run:** each observation's writes happen in one transaction, so a re-run creates no partial or duplicate memories. Tested in Task 6.
2. **Ambiguous or unknown ID prefix in the CLI:** a clear error that names the matches, never acting on the wrong record. Tested in Task 4 (`getMemory`) and Task 7.
3. **CLI used before `init`:** the error says "run `standin init`" instead of a stack trace. Tested in Task 7.
4. **Empty or whitespace-only observation text:** rejected at `addObservation` with a validation error. Tested in Task 3.
5. **Approving an update whose target is no longer approved** (already superseded or retracted): the approval succeeds and the target is left untouched rather than throwing. Tested in Task 4.

---

### Task 1: Monorepo scaffold, safety rails, CI

**Files:** create `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.nvmrc`, `LICENSE`, `README.md`, `.githooks/pre-commit`, `scripts/guard-instance-data.mjs`, `scripts/guard-instance-data.test.mjs`, `.github/workflows/ci.yml`.

**Produces:** the `pnpm test`, `pnpm typecheck`, and `pnpm guard` scripts; the workspace globs `packages/*`, `apps/*`, `examples/*`.

- [ ] Write the guard test: given a list of paths, `findViolations(paths)` flags `a/standin.db`, `x.sqlite-wal`, `.standin/config.json`, `data/observations.jsonl`, and passes `examples/demo-persona/observations.jsonl` and `src/store.ts`.
- [ ] Implement `scripts/guard-instance-data.mjs` (exports `findViolations`; the CLI mode reads `git ls-files` plus `git diff --cached --name-only` and exits 1 with a list of violations).
- [ ] Root config: strict TS (`noUncheckedIndexedAccess`, `module`/`moduleResolution` NodeNext, `allowImportingTsExtensions` + `noEmit`), vitest with node env, `prepare` sets `core.hooksPath=.githooks`.
- [ ] CI: checkout, pnpm setup, Node 24, `pnpm install --frozen-lockfile`, `pnpm guard`, `pnpm typecheck`, `pnpm test`.
- [ ] `pnpm install && pnpm guard && pnpm test` passes. Commit.

### Task 2: `@standin/schema`

**Files:** `packages/schema/{package.json,src/index.ts,src/ids.ts,src/records.ts,src/config.ts}`, test `packages/schema/test/schema.test.ts`.

**Produces:**
- Types and zod schemas: `Tier, Lang, AuthorRole, SourceKind, Observation, ObservationInput, EntityKind, Entity, MemoryKind, MemoryStatus, Memory, MemoryAttrs, Exemplar, ExemplarStatus, MemoryEvent, Actor, PreferencePair, Config` (+ `ConfigInput`), `COMPACTION_RESULTS`.
- `newId(prefix: IdPrefix): string`, `isId(prefix, s): boolean`.
- `parseConfig(raw: unknown): Config` (applies defaults).
- `TERMINAL_STATUSES`, `ALLOWED_TRANSITIONS: Record<MemoryStatus, MemoryStatus[]>`.

- [ ] Tests: `newId("mem")` matches `/^mem_[0-9a-f]{12}$/`; `Memory` rejects `tier: 5`, competence `depth: 7`, and stance attrs missing `topic`; `parseConfig({persona:{name:"X"}})` fills every default; `ObservationInput` rejects whitespace-only text; `ALLOWED_TRANSITIONS.proposed` equals `["approved","rejected"]`.
- [ ] Implement; tests pass; commit.

### Task 3: `@standin/store` part 1: DB, migrations, observations, entities, similarity, confidence

**Files:** `packages/store/{package.json,src/index.ts,src/db.ts,src/migrations.ts,src/text.ts,src/confidence.ts,src/store.ts}`, tests `test/observations.test.ts`, `test/text.test.ts`, `test/confidence.test.ts`.

**Interfaces produced:**
- `openStore({path, clock?}): Store`; `Store.close()`; `Clock = { now(): Date }`.
- `store.addObservation(input: ObservationInput): Observation` (idempotent by `contentHash`).
- `store.uncompactedObservations(limit: number, opts?: {retryFailed?: boolean}): Observation[]`.
- `store.markCompacted(id, result)`.
- `store.resolveEntity({name, kind}): Entity`.
- `text.ts`: `normalizeName(s)`, `bigrams(s): Set<string>`, `dice(a, b): number`, `contentHash(...parts): string`.
- `confidence.ts`: `SOURCE_WEIGHTS`, `ROLE_FACTORS`, `computeConfidence({affirmed, sources: {sourceKind, authorRole}[], isCurrentState, lastCorroboratedAt, now, halfLifeDays}): number`.

- [ ] Tests: the same text added twice returns the same id; whitespace-only text throws; `normalizeName("ＧａｍｅＡＩ ")` equals `normalizeName("gameai")`; `dice("我喜欢扑克","我很喜欢扑克") > 0.5`; English and CJK texts that share nothing score 0; noisy-OR of two interview sources is `1-(0.1*0.1)`; an engaged slack source gives `0.49`; an affirmed, non-current memory gives 1; an affirmed current-state memory 180 days old with a 90-day half-life gives 0.25 (floor); entity resolve is case- and width-insensitive and kind-scoped.
- [ ] Implement (WAL, `foreign_keys=ON`, `schema_migrations` table, a JSON helper for columns); tests pass; commit.

### Task 4: `@standin/store` part 2: memories, lifecycle, events, neighbors, bitemporal, exemplars

**Files:** `packages/store/src/{memories.ts,exemplars.ts}` (wired into `Store`), tests `test/lifecycle.test.ts`, `test/bitemporal.test.ts`, `test/neighbors.test.ts`, `test/exemplars.test.ts`.

**Interfaces produced (on `Store`):**
- `insertMemory(input: NewMemory, ctx: {sourceObservationIds: string[]; entityIds: string[]; actor: Actor; salience: number}): Memory`.
- `addCorroboration(memoryId, observationId): Memory`.
- `getMemory(idOrPrefix): Memory` (throws `NotFoundError` / `AmbiguousIdError`).
- `listMemories(filter?: {status?, kind?}): Memory[]`.
- `memorySources(id): Observation[]`; `memoryEntities(id): Entity[]`; `memoryEvents(id): MemoryEvent[]`.
- `approve(id, edits?: {statement?: string; tier?: Tier}): Memory`; `reject(id)`; `retract(id)`; `expire(id, note?)`. All throw `InvalidTransitionError`.
- `findNeighbors({statement, entityIds}, opts?: {limit?, minSimilarity?}): {memory: Memory; score: number}[]`.
- `memoriesAsOf({validAt: Date; recordedAt?: Date}): Memory[]`.
- `recomputeConfidence(id)`.
- Exemplars: `insertExemplar({observationId, text, lang, register}): Exemplar | null` (null when it's a duplicate), `approveExemplar`, `rejectExemplar`, `listExemplars(filter?)`.

- [ ] Lifecycle tests: proposed→approved sets affirmed, confidence 1, decidedAt, and an event; approved→approved throws; rejected→approved throws; retract only from approved; approving with `{tier: 3, statement}` records an edit note; approving an update supersedes an approved target and sets its `validUntil`; **approving an update whose target is already retracted leaves the target retracted (Review Focus 5)**; prefix lookup is ambiguous → `AmbiguousIdError` listing candidates (**Review Focus 2**).
- [ ] Bitemporal test: memory A is approved at t1 and superseded by B at t2. `memoriesAsOf({validAt: t1.5, recordedAt: t1.5})` contains A only; `recordedAt: t3` with `validAt: t3` contains B only; `validAt` before A's validFrom excludes A.
- [ ] Neighbor tests: a shared entity ranks above higher text similarity without a shared entity; superseded memories are excluded; rejected memories are included; CJK statements match.
- [ ] Exemplar tests: a duplicate text returns null; a duplicate of a rejected exemplar returns null.
- [ ] Implement; tests pass; commit.

### Task 5: Consolidation

**Files:** `packages/store/src/consolidate.ts`, test `test/consolidate.test.ts`.

**Produces:** `store.consolidate(config: Config): ConsolidationReport` = `{expired: string[], recomputed: number, purged: number}`.

- [ ] Tests (fake clock): approved with `validUntil` in the past → expired, with an event by `consolidation`; a current-state approved memory not corroborated for 121 days with `freshnessDays` 120 → expired; non-current memories are untouched; a proposed AI-memory claim's confidence is recomputed; a compacted observation older than 90 days gets `text=null` and `purgedAt` set while its hash is kept, and an uncompacted old observation is not purged.
- [ ] Implement in a single transaction; tests pass; commit.

### Task 6: `@standin/llm` and `@standin/compaction`

**Files:** `packages/llm/{package.json,src/index.ts,src/types.ts,src/anthropic.ts,src/scripted.ts}`, test `packages/llm/test/scripted.test.ts`, `packages/llm/test/anthropic.live.test.ts`; `packages/compaction/{package.json,src/index.ts,src/schemas.ts,src/prompts.ts,src/salience.ts,src/compact.ts,src/queue.ts}`, tests `test/salience.test.ts`, `test/compact.test.ts`, `test/queue.test.ts`.

**Interfaces produced:**
- `interface LLM { generateObject<T>(req: GenerateObjectRequest<T>): Promise<T> }`, where `GenerateObjectRequest<T> = {system: string; prompt: string; schema: z.ZodType<T>; maxTokens?: number; purpose?: string}`.
- `class LLMError extends Error`.
- `new AnthropicLLM({model, client?})`.
- `new ScriptedLLM(handler: (req) => unknown | Promise<unknown>)`, which validates the handler output with `req.schema` and throws `LLMError` on mismatch.
- `ExtractionSchema`, `ReconcileSchema`; `buildExtractionPrompt(obs, personaName)`, `buildReconcilePrompt(candidate, neighbors)`. Each request sets `purpose: "extract" | "reconcile"` so scripted handlers can route.
- `salience({kind, confidence, novelty, demandHits?}): number`.
- `compact({store, llm, config, limit?, retryFailed?}): Promise<CompactionReport>`, where `CompactionReport = {processed, skippedExposed, failed: {observationId, error}[], created, corroborated, droppedAsRejected, updates, contradictions, exemplars}`.
- `reviewQueue(store, {cap}): Memory[]`.

- [ ] ScriptedLLM tests: valid output is passed through; invalid output throws `LLMError`.
- [ ] Salience tests: the exact formula values from the spec.
- [ ] Compaction tests (ScriptedLLM + a temp store): an exposed observation is skipped with no LLM call; new → a proposed memory with source and entity links; a second observation saying the same thing → corroborated (still one memory, two sources, higher confidence); a duplicate of a rejected memory → dropped; update → `supersedesId`; contradiction → `conflictsWithId`; reconcile returns an unknown `targetId` → treated as new; an extraction that throws for one observation → that observation is `failed` and the others are processed; `retryFailed` retries it; exemplars are kept only for `self`; **a simulated crash during insert (the handler throws after the first candidate is applied) leaves no partial memories, and a re-run creates them exactly once (Review Focus 1)**.
- [ ] Queue test: contradictions come first, then descending salience, capped.
- [ ] Live test, skipped unless `STANDIN_LIVE=1`: extracts at least one memory from a two-sentence observation.
- [ ] Implement; tests pass; commit.

### Task 7: CLI and demo persona, end to end

**Files:** `apps/cli/{package.json,bin/standin.mjs,src/main.ts,src/home.ts,src/format.ts,src/commands/*.ts}`, test `apps/cli/test/e2e.test.ts`; `examples/demo-persona/{package.json,README.md,observations.jsonl,src/index.ts,src/fixtures.ts}`.

**Interfaces produced:**
- `runCli(argv: string[], io: {stdout, stderr, env}): Promise<number>` (testable without spawning a process).
- `@standin/demo-persona` exports `demoObservations(): ObservationInput[]` and `demoLLM(): ScriptedLLM`.
- The `standin` bin uses tsx to run `src/main.ts`.

- [ ] E2E test in a temp `STANDIN_HOME`: `memories` before init exits 1 with "run `standin init`" (**Review Focus 3**); `init --demo --name "Lin Qiao"` succeeds; `compact --demo-llm` reports the exposed observation skipped, ≥1 corroboration, 1 update, 1 contradiction; `queue` lists the contradiction first; approve, reject, and approve the update target chain; `memories --status approved --json` matches expectations; `memories --as-of <past>` shows the earlier current-state fact; `consolidate` runs; an ambiguous prefix gives a non-zero exit with candidates listed (**Review Focus 2**).
- [ ] Write the demo persona: ~10 bilingual observations per the spec, plus hand-written fixtures.
- [ ] Implement the commands with minimal arg parsing (`node:util` `parseArgs`).
- [ ] The README documents the quickstart (`pnpm i`, `pnpm standin init --demo`, `pnpm standin compact --demo-llm`, `pnpm standin queue`).
- [ ] Full `pnpm typecheck && pnpm test && pnpm guard` passes. Commit.
