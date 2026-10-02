# SP1: Memory Core, Spec

**Date:** 2026-10-01
**Status:** Approved for implementation (2026-10-01)
**Parent:** `2026-10-01-standin-architecture.md` (§5 memory model, §11 OSS structure, §12 row 1)

## Goal

Deliver the foundation that every later sub-project depends on: the monorepo, the typed schema, the local SQLite memory store with lifecycle and bitemporal history, LLM-driven compaction from observations into memories, consolidation, a minimal CLI, and a demo persona that runs end to end in CI without network access.

## Non-goals (deferred to later sub-projects)

Ingest adapters other than manual/stdin and the demo loader (SP2) · sensitivity scanners and the review UI (SP2) · publish to Cloudflare (SP2/SP4) · semantic embeddings (SP4, where the edge needs them) · L2 style-card generation (SP7) · visitor question log (SP4).

## Repository layout

```
standin/
  package.json            pnpm workspace root; scripts: test, typecheck, guard
  pnpm-workspace.yaml
  tsconfig.base.json      strict, ES2023, NodeNext
  LICENSE                 Apache-2.0
  README.md
  .githooks/pre-commit    runs guard
  .github/workflows/ci.yml
  scripts/guard-instance-data.mjs
  packages/schema         zod schemas + inferred types (no runtime deps beyond zod)
  packages/llm            LLM provider interface, Anthropic provider, scripted fake
  packages/store          SQLite store (node:sqlite), lifecycle, bitemporal queries, consolidation, confidence
  packages/compaction     extraction + reconciliation pipeline, salience, review queue
  apps/cli                `standin` command
  examples/demo-persona   fictional bilingual persona: observations + LLM fixtures
```

Packages export TypeScript source directly (`"exports": {".": "./src/index.ts"}`); there is no build step in SP1. Tests use vitest, and the CLI runs via `tsx`. Node ≥ 22.13 is required for unflagged `node:sqlite`; development uses Node 24.

## Schema (`@standin/schema`)

All records are zod schemas with inferred TS types. IDs are a prefix plus 12 lowercase hex characters (`obs_`, `ent_`, `mem_`, `exm_`, `evt_`, `pp_`). Times are ISO-8601 UTC strings.

- `Tier`: `1 | 2 | 3 | 4`.
- `Lang`: `"en" | "zh" | "mixed" | "other"`.
- `AuthorRole`: `"self" | "engaged" | "exposed"`.
- `SourceKind`: `interview | checkin | manual | slack | github | website | gdrive | claude-memory | chatgpt-memory | muse-paste | chatgpt-export | claude-export | demo`.
- `Observation`: `id, sourceKind, sourceRef, authorRole, lang, text (nullable after purge), contentHash, occurredAt, ingestedAt, compactedAt?, compactionResult? ("processed" | "skipped_exposed" | "failed"), purgedAt?, meta (record)`.
- `EntityKind`: `project | org | place | person | work | topic`. `Entity`: `id, kind, name, aliases[]`.
- `MemoryKind`: `fact | competence | stance | negative`.
- `MemoryStatus`: `proposed | approved | rejected | superseded | expired | retracted`.
- `Memory`: `id, kind, statement, lang, tier, status, confidence (0..1), salience (≥0), validFrom?, validUntil?, isCurrentState, affirmed, supersedesId?, conflictsWithId?, recordedAt, decidedAt?, lastCorroboratedAt, attrs`. `attrs` is discriminated by kind: competence `{domain, depth: 0..4}`; stance `{topic, strength: 1..5}`; fact and negative `{}`.
- `Exemplar`: `id, observationId, text, lang, register ("casual" | "formal"), status ("proposed" | "approved" | "rejected"), contentHash, recordedAt, decidedAt?`.
- `MemoryEvent`: `id, memoryId, fromStatus?, toStatus, at, actor ("compaction" | "person" | "consolidation"), note?`.
- `PreferencePair`: `id, question, standinAnswer, personAnswer, lang, createdAt`. The table exists in SP1; SP6 populates it.
- `Config`: `persona {name, languages[]}`, `compaction {model (default "claude-opus-5-5"), batchSize (20)}`, `consolidation {retentionDays (90), freshnessDays (120), currentStateHalfLifeDays (90)}`, `review {weeklyCap (25)}`. Defaults are applied by zod.

## Store (`@standin/store`)

SQLite via `node:sqlite`, one file at `$STANDIN_HOME/standin.db` (`STANDIN_HOME` defaults to `~/.standin`). It uses a versioned migration table, foreign keys on, WAL mode, and an injectable clock (`now(): Date`).

Tables: `observations`, `entities`, `memories`, `memory_sources (memory_id, observation_id)`, `memory_entities (memory_id, entity_id)`, `memory_events`, `exemplars`, `preference_pairs`. JSON columns (`attrs`, `aliases`, `meta`) are stored as text.

**API (behavioral contract):**
- `addObservation(input)` computes `contentHash` (sha256 of the normalized text plus source kind) and is idempotent: re-adding the same content returns the existing record.
- `uncompactedObservations(limit)` and `markCompacted(id, result)`.
- `resolveEntity({name, kind})` matches on a normalized name (NFKC, lowercased, punctuation and whitespace collapsed) against names and aliases of the same kind, and creates the entity if there is no match.
- `insertMemory(input, {sourceObservationIds, entityIds, actor})` inserts with status `proposed` and writes a creation event.
- `addCorroboration(memoryId, observationId)` links the source, sets `lastCorroboratedAt`, and recomputes confidence.
- `findNeighbors({statement, entityIds}, {limit = 8, minSimilarity = 0.3})` returns non-terminal and rejected memories that share an entity, plus memories whose character-bigram Dice similarity to the statement is ≥ `minSimilarity`. Results are ranked by similarity, with a +0.5 boost for a shared entity. Superseded, expired, and retracted memories are excluded.
- **Lifecycle transitions** are enforced. Invalid transitions throw `InvalidTransitionError`.
  - `approve(id, {statement?, tier?})`: proposed → approved. Sets `affirmed = true`, `decidedAt`, and confidence 1. If `supersedesId` or `conflictsWithId` points to an approved memory, that memory becomes `superseded` (its `validUntil` is set to the new memory's `validFrom ?? now` if it was unset). Edits are recorded in the event note.
  - `reject(id)`: proposed → rejected.
  - `retract(id)`: approved → retracted.
  - `expire(id)`: approved → expired (consolidation only).
- Every transition writes a `memory_events` row.
- `listMemories({status?, kind?})` and `getMemory(id)`, which also accepts a unique ID prefix of 6 or more characters.
- **Bitemporal** `memoriesAsOf({validAt, recordedAt = now})`: memories whose status, replayed from `memory_events` up to `recordedAt`, was `approved` at that time, and whose valid interval contains `validAt` (null bounds are open).
- Exemplars: `insertExemplar` (deduplicated by content hash, including against rejected exemplars), `approveExemplar`, `rejectExemplar`, `listExemplars`.
- `consolidate()` runs in one transaction and returns a report:
  1. Expire approved memories whose `validUntil < now`, and approved current-state memories whose `lastCorroboratedAt` is older than `freshnessDays`.
  2. Recompute confidence for proposed and approved memories.
  3. Purge observations that are compacted and whose `ingestedAt` is older than `retentionDays`: `text = NULL`, `purgedAt = now`, hash and pointers kept.

**Confidence (pure function `computeConfidence`):**
- `affirmed` → 1.0, multiplied by the current-state decay below.
- Otherwise, a noisy-OR over sources: `1 − Π(1 − w(source))`, where `w` is the source weight times a role factor (`self` 1.0, `engaged` 0.7). Source weights: interview / checkin / manual 0.9 · github / website 0.85 · demo 0.8 · slack 0.7 · gdrive / chatgpt-export / claude-export 0.6 · claude-memory / chatgpt-memory / muse-paste 0.4.
- Current-state memories decay as `max(0.25, 0.5^(daysSinceCorroboration / halfLife))`.

## LLM provider (`@standin/llm`)

```ts
interface LLM {
  generateObject<T>(req: { system: string; prompt: string; schema: ZodType<T>; maxTokens?: number }): Promise<T>;
}
```

- `AnthropicLLM({model, client?})` uses the official `@anthropic-ai/sdk` with `messages.parse` and `zodOutputFormat`. It checks `stop_reason` (refusal or max_tokens → `LLMError`) and resolves credentials the SDK's default way.
- `ScriptedLLM(handler)` is a deterministic fake for tests and the demo. The handler receives the request and returns the object; the output is still validated against the schema.

## Compaction (`@standin/compaction`)

`compact({store, llm, config, limit?}) → CompactionReport`.

For each uncompacted observation:

1. `authorRole === "exposed"` → mark it `skipped_exposed` and stop (exposure ≠ knowledge).
2. **Extract** (one LLM call). The input is the observation text plus its source kind, author role, language, the occurred-at date, and the persona name. The output schema contains:
   - `memories[]`: `{kind, statement, lang, entities[{name, kind}], suggestedTier, validFrom?, validUntil?, isCurrentState, attrs}`.
   - `exemplars[]`: `{text, register}`. Exemplars are only kept when `authorRole === "self"`.
   The prompt rules: only claims about the persona supported by the text; statements in the persona's first-person voice and the original language; competence only from demonstrated or self-reported ability; `negative` only for explicit "never/don't know" statements; suggested tier 1 for things already public, 2 for ordinary personal details, 3 for sensitive topics (compensation, immigration status, health, relationships, other people, confidential work, unpublished research). Tier 4 is never suggested by the model.
3. For each candidate: resolve entities → `findNeighbors`. With no neighbors the action is `new`. Otherwise **reconcile** (one LLM call) returns `{action: new | duplicate | update | contradiction, targetId?}`, and `targetId` must be one of the neighbor IDs or the decision is treated as `new`.
4. Apply the decision:
   - `duplicate` of a rejected memory → drop (counted as `droppedAsRejected`).
   - `duplicate` of a proposed or approved memory → `addCorroboration`.
   - `update` → insert with `supersedesId`.
   - `contradiction` → insert with `conflictsWithId`.
   - `update` or `contradiction` targeting a rejected memory → insert as new.
   - `new` → insert.
   The inserted memory's confidence is computed from its source, and its salience is computed (below).
5. Insert exemplars (deduplicated), then mark the observation `processed`.
6. An LLM or validation error on one observation marks it `failed`, adds it to the report, and processing continues. A failed observation is retried on the next run only when called with `retryFailed: true`.

**Salience** (a pure function): `kindWeight × (0.5 + 0.5 × confidence) × noveltyWeight × (1 + demandHits)`. Kind weights: fact 1.0, competence 1.0, stance 0.9, negative 0.8. Novelty weights: new 1.0, update 0.8, contradiction 1.2. `demandHits` defaults to 0 (SP4 supplies it).

**Review queue** `reviewQueue(store, {cap = config.review.weeklyCap})`: proposed memories ordered with contradictions first, then by salience descending, capped.

## CLI (`apps/cli`, bin `standin`)

| Command | Behavior |
|---|---|
| `standin init [--name N] [--demo]` | Create `$STANDIN_HOME`, `config.json`, and the DB. `--demo` loads the demo persona's observations |
| `standin observe --source K --role R --lang L [--ref S] [--occurred ISO] [--file F]` | Add an observation from a file or stdin |
| `standin compact [--limit N] [--retry-failed] [--demo-llm]` | Run compaction. `--demo-llm` uses the demo fixtures' ScriptedLLM (works offline) |
| `standin queue` | Print the review queue |
| `standin approve <id> [--tier T] [--statement S]` / `reject <id>` / `retract <id>` | Lifecycle actions |
| `standin memories [--status S] [--kind K] [--as-of ISO] [--recorded-at ISO]` | List memories (bitemporal when `--as-of` is given) |
| `standin consolidate` | Run consolidation |

Output is human-readable tables. `--json` on list commands prints JSON.

## Demo persona (`examples/demo-persona`)

A fictional bilingual person, **"Lin Qiao (乔林)"**, a graduate student who builds board-game AIs. The fixture set contains about 10 observations across `interview`, `slack`, `chatgpt-memory`, and `website` sources: at least two in Chinese, one `exposed`, one later observation that updates a current-state fact, one that contradicts an AI-memory claim, one duplicate, and one sensitive (tier-3) item. `fixtures.ts` provides a ScriptedLLM handler that returns hand-written extraction and reconciliation outputs keyed by observation ID and candidate statement.

## Safety rails

- `.gitignore` covers `*.db`, `*.sqlite*`, `.standin/`, `.env*`.
- `scripts/guard-instance-data.mjs` fails if staged or tracked files include SQLite files, a `.standin/` path, or `observations*.jsonl` outside `examples/`. It runs in the pre-commit hook (installed by `prepare`) and in CI.

## Testing and acceptance

- Unit tests: schema validation; ID format; confidence and salience functions; every lifecycle transition, valid and invalid; supersession on approve; bitemporal replay (a memory approved then superseded is visible at an earlier `recordedAt` and absent later); neighbors (shared-entity boost, CJK bigram similarity); consolidation (expiry, decay, purge keeps the hash); exemplar dedupe including against rejected ones.
- Compaction tests with ScriptedLLM: exposed is skipped; duplicate corroborates; a rejected duplicate is dropped; update and contradiction link correctly; invalid `targetId` falls back to `new`; a per-observation failure is isolated.
- **End to end:** run the whole demo persona through `init --demo` → `compact --demo-llm` → approve/reject → `consolidate` → `memories --as-of`, in a temp `STANDIN_HOME`, with no network.
- `pnpm typecheck` and `pnpm test` pass; CI runs both plus the guard.
- A live-provider test runs only when Anthropic credentials are available (`STANDIN_LIVE=1`). Otherwise it is skipped.
