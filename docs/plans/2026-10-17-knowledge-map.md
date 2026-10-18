# Knowledge Map and Review Page (SP2a): Implementation Plan

> **Superseded.** The spec was revised on 2026-10-18 (claim-first, lit tree). This plan will be rewritten to match. Do not execute it.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution: Claude implements inline (the user's standing choice: no Codex, no subagents).

**Goal:** The standin gets a measured, reviewable map of what the person knows: topics with `parent` and `requires` edges, a depth (0–4) per topic combined cautiously from claims, authored work and probes, an answering rule, a holdout-based calibration score, and a local `standin review` page for probes, memory approvals and map edits.

**Architecture:**
- `@standin/schema` gains the knowledge records and the `map` role.
- `@standin/store` gains three tables (migration 4) and their queries.
- A new package, `@standin/knowledge`, holds:
  - the pure rules: depth estimate, propagation, `answerMode`, probe selection, calibration;
  - the store adapters: snapshot and proposals;
  - the three model tasks: `quiz`, `map`, `judge`;
  - a `ReviewSession` service that owns the holdout invariants.
- A new package, `@standin/review`, is the `node:http` server and the single HTML page.
- The CLI adds `standin review` and `standin map`.

**Tech Stack:** Node 24, TypeScript (strict), zod v4, vitest, `node:sqlite`, `node:http`, `qrcode-terminal@0.12.0` (the only new dependency; prints the `--lan` QR code).

**Spec:** `docs/specs/2026-10-07-knowledge-map.md`. Parents: `docs/specs/2026-10-01-standin-architecture.md` §5 and §7, `docs/specs/2026-10-03-model-routing.md`.

## Global Constraints

- **Depth scale:** 0 doesn't know, 1 aware, 2 working knowledge, 3 strong, 4 expert.
- **Basis order:** `probed` > `evidence` > `predicted` > `claimed`.
- **Confidence:**
  - `high`: probed or evidence;
  - `medium`: predicted from an established topic;
  - `low`: claimed, or predicted from a claim.
- **Claims** are capped at **2** until corroborated.
- **Evidence floors:** 1 authored item → **2**; 3 or more, or in-depth writing → **3**. Descendant topics count.
- **Probe level:** the highest difficulty `d` where at least **70%** of the ratings counted at `d` are `know`, and at least **70%** of graded spot-checks counted at `d` pass (if any).
  - Depth 4 also needs **2** passed spot-checks at difficulty 4.
  - Monotonic difficulty: a `know` or a pass at `d` also counts as support at every lower level.
- **Upward floor:** `min(child − 1, 3)`, the maximum over children, basis `predicted`.
- **Prerequisite floor:**
  - established `T` → `min(d − 1, 3)`, medium;
  - claimed `T` → `min(c − 1, 2)`, low, where `c` is the raw claim;
  - transitive, losing one level per hop;
  - never overrides a probed topic.
- **`answerMode`:** depth 3–4 → `explain`, 2 → `brief`, 0–1 or no topic → `decline`. Low confidence counts one level lower.
- **Probe volume:** the first session is **60** probes, later sessions **10**.
- **Adaptive start level:** the estimate's depth (clamped to 1–4), or **3** with no estimate.
- **Spot-checks:** about **1 in 5** of `know`/`roughly` ratings. The `judge` role grades them through the batch API when the provider has one.
- **Holdout:** assigned at random when the probe is written, and never reassigned.
  - `fixed` about **10%**: never released.
  - `rotating` about **20%**: released at the end of the session it was answered in.
  - `none`: the rest.
- **Held-out probes before release:**
  - their responses do not feed depth;
  - their spot-checks do not become exemplars.
  - A fixed probe's spot-check never becomes an exemplar.
- **Predictions:** every shown probe stores the topic's `answerMode` before the rating is accepted. The calibration score uses only that stored value.
- **Calibration score:**
  - The share of held-out responses where "would answer" (`explain`/`brief`) matches `know`/`roughly`, and `decline` matches `no_idea`.
  - `wouldnt_say` is excluded.
  - Reported separately for `fixed` and `rotating`.
- **`wouldnt_say`** never lowers depth. It suggests tier 3 for the topic's approved competence memory.
- **Nothing joins the map unreviewed.** Depth changes are proposed competence memories that supersede the approved one. Merges and edges are proposed `topic_edges`. Cycles are rejected with the cycle path.
- **Roles:**
  - `map`: medium tier, private. Purpose: "Propose topic merges, parent links and prerequisite links".
  - `quiz` (existing, medium): purpose becomes "Write knowledge probes for a topic".
  - `judge` (existing, large): purpose becomes "Grade eval answers and spot-checks".
  - `hypothesize` is Phase 2 and is **not** added.
- **Review page:**
  - Binds `127.0.0.1` by default. `--lan` binds `0.0.0.0` and prints a QR code of the token URL.
  - Every route needs the session token. The page is `/?t=<token>`. The API takes the token in the `x-standin-token` header and nowhere else. A missing or wrong token gets **403**.
  - No data leaves the machine except calls by the `quiz`, `map` and `judge` roles.
- **Tracing:** a review session is a run of kind `review`. Grading collection and probe writing appear as model-call spans under it.
- **Commits:** Mingxi is the author. Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Plan rulings

Choices the spec leaves open, decided here. Each is flagged for Mingxi's review.

1. **"Probes replace the estimate within what they cover."**
   - If some rated level above the probe level failed, the probes have found the boundary, so depth = probe level. This can go below the claim or the floor, and the reason line says so.
   - If every rated level passed, depth = `max(probe level, prior)`, where the prior is the capped claim, the evidence floor or a predicted floor.
   - So depth 4 is reachable only through probes.
2. **Only `know` counts as support at a level.** `roughly` counts against it. `wouldnt_say` is ignored.
   - With no qualifying level, depth is 1 if any response is `know`/`roughly`, else 0.
3. **The claim** is the depth of the most recently recorded competence memory for the topic that came from compaction (no `basis` in attrs) and whose status is `approved` or `superseded`.
   - **An approved competence memory without `basis`** is read by `answerMode` as `claimed`: depth capped at 2, low confidence. The cap holds even before the person reviews the map's proposal.
4. **Authored evidence:** distinct observations with `authorRole: "self"` and `sourceKind` in `github | website | gdrive` that are sources of approved memories linked to the topic or a descendant.
   - In-depth = `meta.inDepth === true`. The SP2b scanners set it. Nothing sets it in SP2a.
5. **Merges are a third edge kind, `same`** (`from` merges into `to`). That way merges, parents and prerequisites share one table and one review card type. Approving a merge:
   - moves aliases, memory links, probes and edges onto `to`;
   - deletes `from`;
   - drops self-loops and duplicate edges;
   - is refused with the cycle path if it would create a cycle.
6. **Spot-check answers become observations** (`sourceKind: "probe"`, `sourceRef: "probe:<probeId>"`, `authorRole: "self"`, text `Q: …\n\nA: …`).
   - They are marked `processed` at once and never compacted: the probe response is already the knowledge signal.
   - The exemplar text is the answer alone.
7. **A session = one `standin review` run.**
   - Rotating probes are released on Finish.
   - Any not released because the session crashed are released when the next session starts.
8. **Selection never re-shows a probe answered in the last 180 days.**
   - It skips topics probed in the last 90 days whose estimate is `probed` with high confidence.
   - At most 4 probes per topic per session.
   - A predicted prerequisite gets exactly 1 probe, at its predicted level.
9. **`quiz` writes 2 probes per difficulty (8 per call)** for topics about to be probed that lack an unshown probe at the needed level.
   - Language: the majority `lang` of the topic's competence memories, else the persona's first language.
10. **The map role** runs once per session over every topic plus the existing edges, and asks only for new proposals.
    - Duplicates of existing edges in any status are dropped.
    - Topic names it introduces (e.g. a missing foundation) become topic entities at once. They do nothing until an edge is approved.
11. **Depth proposals are not repeated.** No new proposal when the approved memory or a rejected map proposal already has the same depth and basis. A pending map proposal with a different value is rejected (actor `map`, note "replaced by a newer estimate") before the new one is inserted.
12. **Proposal statements** use first-person templates.
    - en: "I don't know {t}." / "I'm aware of {t}." / "I have working knowledge of {t}." / "I'm strong in {t}." / "I'm an expert in {t}."
    - zh: "我不懂{t}。" / "我了解过{t}。" / "我能用{t}做事。" / "我在{t}方面比较强。" / "我是{t}方面的专家。"
    - `lang` is `zh` if the topic name contains CJK characters, else `en`.
    - Tier: the approved memory's tier, else 1.
13. **Randomness** (holdout assignment and spot-check choice) comes from an injected `rng: () => number`, so tests are deterministic.

## Review Focus

1. **Two browser tabs or a double-click rating the same probe.** The second rating of a response is refused with 409, and the first one stands. Tested in Task 10.
2. **A topic merged while its probes are mid-session** (approve a `same` edge, then rate the next probe). Probes, responses and the topic's estimate follow the surviving topic, and nothing points at the deleted entity. Tested in Task 2 (store) and Task 10.
3. **The judge batch never finishes, or fails, before the next session.** The session still starts. Grades stay pending (`grade` null), so depth simply ignores them. A failed batch's responses are resubmitted next time. Tested in Task 9.
4. **The `quiz` or `map` model is down when a session starts.** Rating still works with whatever probes exist, and the CLI prints one warning. With zero probes the page says so instead of erroring. Tested in Task 10.
5. **A Chinese topic name and an English alias for the same topic** (`强化学习` / `reinforcement learning`). Estimates, probes and proposals key on the entity id, never the display name. A proposal statement uses the zh template only when the name itself is CJK. Tested in Task 7.

---

### Task 0: Branch setup

- [ ] PR #3 must be merged first: this plan uses `models.for(role)`, the tracer and the batch API. Branch `knowledge-map` from the updated `main`.
- [ ] Mark the spec as approved: Status line "Approved 2026-10-17 (decisions in §11)".
- [ ] `pnpm install && pnpm typecheck && pnpm test` is green before any change.

### Task 1: `@standin/schema`: knowledge records and the `map` role

**Files:** modify `packages/schema/src/{records.ts,roles.ts,index.ts}`; test in `packages/schema/test/schema.test.ts` and `test/models.test.ts`.

**Produces** (in `records.ts`):
```ts
export const Depth = z.number().int().min(0).max(4);
export const DepthBasis = z.enum(["probed", "evidence", "predicted", "claimed"]);
export const DepthConfidence = z.enum(["high", "medium", "low"]);
export const CompetenceAttrs = z.object({
  domain: z.string().min(1), depth: Depth,
  // Set only on proposals written by the knowledge map; absent on extracted claims.
  basis: DepthBasis.optional(), confidence: DepthConfidence.optional(), reasons: z.array(z.string()).optional(),
});
export const EdgeKind = z.enum(["parent", "requires", "same"]);
export const EdgeStatus = z.enum(["proposed", "approved", "rejected"]);
export const TopicEdge = z.object({ id, fromTopic, toTopic, kind: EdgeKind, status: EdgeStatus, reason: z.string().nullable(), createdAt: IsoTime, decidedAt: IsoTime.nullable() });
export const Holdout = z.enum(["none", "fixed", "rotating"]);
export const Difficulty = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export const Probe = z.object({ id, topicId, question: NonBlank, difficulty: Difficulty, lang: Lang, holdout: Holdout, createdAt: IsoTime, releasedAt: IsoTime.nullable() });
export const Rating = z.enum(["know", "roughly", "no_idea", "wouldnt_say"]);
export const AnswerMode = z.enum(["explain", "brief", "decline"]);
export const Grade = z.enum(["pass", "fail"]);
export const ProbeResponse = z.object({
  id, probeId, shownAt: IsoTime, predictedMode: AnswerMode, rating: Rating.nullable(), answeredAt: IsoTime.nullable(),
  spotCheckRequested: z.boolean(), spotCheckAnswer: z.string().nullable(), observationId: z.string().nullable(),
  grade: Grade.nullable(), gradeReason: z.string().nullable(), gradeBatchId: z.string().nullable(), gradedAt: IsoTime.nullable(),
});
// Actor gains "map"; SourceKind gains "probe". Each record exports its inferred type.
```
- Ids use `newId` prefixes `edg`, `prb` and `rsp`.
- `roles.ts`: add `map` (medium, private), and update the `quiz` and `judge` purposes (Global Constraints).

**Steps:**
- [ ] Write the failing tests:
  - A competence memory parses with and without `basis`/`confidence`/`reasons`, and rejects `depth: 5`.
  - `Probe` rejects difficulty 0 and an unknown holdout.
  - `ProbeResponse` accepts a null rating.
  - `ROLES.map` is `{ tier: "medium", zone: "private" }`, and `ROLE_NAMES` includes `map`.
  - `Actor` and `SourceKind` accept `map` and `probe`.
- [ ] Implement. Typecheck and tests pass. Commit "Add knowledge-map records and the map role".

### Task 2: `@standin/store`: topic edges, probes, responses, merges

**Files:** modify `packages/store/src/{migrations.ts,store.ts,memories.ts,index.ts}`; create `packages/store/src/knowledge.ts`; test `packages/store/test/knowledge.test.ts`.

**Migration 4:**
```sql
CREATE TABLE topic_edges (
  id TEXT PRIMARY KEY, from_topic TEXT NOT NULL REFERENCES entities(id), to_topic TEXT NOT NULL REFERENCES entities(id),
  kind TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL, decided_at TEXT,
  UNIQUE (from_topic, to_topic, kind)
);
CREATE TABLE probes (
  id TEXT PRIMARY KEY, topic_id TEXT NOT NULL REFERENCES entities(id), question TEXT NOT NULL,
  difficulty INTEGER NOT NULL CHECK (difficulty BETWEEN 1 AND 4), lang TEXT NOT NULL,
  holdout TEXT NOT NULL, created_at TEXT NOT NULL, released_at TEXT
);
CREATE INDEX probes_topic ON probes (topic_id, difficulty);
CREATE TABLE probe_responses (
  id TEXT PRIMARY KEY, probe_id TEXT NOT NULL REFERENCES probes(id), shown_at TEXT NOT NULL,
  predicted_mode TEXT NOT NULL, rating TEXT, answered_at TEXT,
  spot_check_requested INTEGER NOT NULL DEFAULT 0, spot_check_answer TEXT, observation_id TEXT REFERENCES observations(id),
  grade TEXT, grade_reason TEXT, grade_batch_id TEXT, graded_at TEXT
);
CREATE INDEX probe_responses_probe ON probe_responses (probe_id);
```

**Produces** (Store methods delegating to `knowledge.ts`):
```ts
proposeEdge(input: { from: string; to: string; kind: EdgeKind; reason: string | null }): TopicEdge | null; // null if (from,to,kind) exists in any status
listEdges(filter?: { status?: EdgeStatus; kind?: EdgeKind }): TopicEdge[];
approveEdge(id: string): TopicEdge;   // throws CycleError(path: string[]) for parent/requires cycles; `same` runs mergeTopics
rejectEdge(id: string): TopicEdge;
mergeTopics(fromId: string, intoId: string): void;  // see Plan ruling 5
insertProbe(input: { topicId: string; question: string; difficulty: Difficulty; lang: Lang; holdout: Holdout }): Probe;
listProbes(filter?: { topicId?: string }): Probe[];
showProbe(probeId: string, predictedMode: AnswerMode): ProbeResponse;      // creates the response row with the prediction
rateResponse(id: string, rating: Rating, opts?: { spotCheck?: boolean }): ProbeResponse; // throws AlreadyRatedError if rated
answerSpotCheck(id: string, answer: string, observationId: string): ProbeResponse;
listResponses(filter?: { probeId?: string; ungraded?: boolean; rated?: boolean }): (ProbeResponse & { probe: Probe })[];
setGradeBatch(responseIds: string[], batchId: string | null): void;
recordGrade(id: string, grade: Grade, reason: string): ProbeResponse;
releaseRotating(answeredBefore: string): Probe[];   // sets released_at on rotating probes with a rated response before the cutoff
reject(id, note?, actor?: Actor)                    // memories.ts: actor defaults to "person"
```
- `CycleError` and `AlreadyRatedError` are exported from `errors.ts`.
- Cycle detection is a DFS over approved edges of the same kind plus the candidate edge. The error message is the path joined with " → ".

**Steps:**
- [ ] Write the failing tests:
  - **Edges.** A duplicate edge returns `null`. Approving A→B, B→C, then C→A (parent) throws `CycleError` with path `[A, B, C, A]`, and the edge stays proposed.
  - **Merge.** Approving a `same` edge moves aliases (the from-name becomes an alias), memory links, probes and edges. It drops a resulting self-loop and deletes the `from` entity. Afterwards `getEntity(from)` throws `NotFoundError` and no row references `from` (Review Focus 2).
  - **Ratings.** `rateResponse` twice throws `AlreadyRatedError`.
  - **Release.** `releaseRotating` releases only rotating probes answered before the cutoff, and never `fixed` or `none`.
  - **Grades.** `recordGrade` sets `gradedAt`.
- [ ] Implement. Tests pass, and existing store tests are unchanged. Commit "Store topic edges, probes and responses".

### Task 3: Compaction links competence memories to topics

**Files:** modify `packages/compaction/src/compact.ts` (`apply`); test in `packages/compaction/test/compact.test.ts`.

- In `apply`, a `competence` candidate adds `store.resolveEntity({ name: attrs.domain, kind: "topic" }).id` to its `entityIds`, if it isn't already linked.
- **Produces** `topicOf(store: Store, m: Memory): Entity | null` in `@standin/knowledge` (Task 7). It returns the memory's linked topic entity whose name or alias normalizes to `attrs.domain`.

**Steps:**
- [ ] Write the failing tests:
  - Extracting a competence memory with domain "强化学习" creates a topic entity of that name and links it.
  - A second extraction whose domain is an existing alias links the same entity.
- [ ] Implement. All compaction tests pass, including the demo end-to-end counts. Commit "Link competence memories to topic entities".

### Task 4: `@standin/knowledge`: one topic's estimate

**Files:** create the package `packages/knowledge` (`package.json` like `compaction`'s, depending on schema, store, llm, models and trace; `src/index.ts`; `src/depth.ts`); test `packages/knowledge/test/depth.test.ts`. Register the package in `tsconfig.json`.

**Produces:**
```ts
export interface ResponseSignal { difficulty: Difficulty; rating: Rating; grade: Grade | null }
export interface TopicSignals { claim: number | null; authored: { count: number; inDepth: boolean }; responses: ResponseSignal[] }
export interface Estimate {
  depth: number; basis: DepthBasis; confidence: DepthConfidence; reasons: string[];
  rawClaim: number | null; probed: boolean;   // probed: depth was set by probes (predicted floors may not override it)
  disagreement: boolean;                      // probes below claim/floor, or claim ≥ 2 above evidence and probes
}
export function probeLevel(responses: ResponseSignal[]): { level: number; maxRated: number } | null; // null: no rated responses
export function estimateTopic(s: TopicSignals): Estimate | null;   // null: no claim, no authored work, no responses
```
- `probeLevel` implements the Global Constraints probe rule and Plan rulings 1–2. Counted at `d`: ratings at exactly `d`, plus `know` ratings above `d`. Same for spot-checks with passes.
- `wouldnt_say` responses are filtered out before anything is counted.
- Reasons are short English lines, e.g. "claimed 4, capped at 2 until corroborated", "3 authored works: floor 3", "probes: know 3 of 4 at difficulty ≥ 3; spot-checks 2 of 2", "probes put this below the claim (1 < 3)".

**Steps:**
- [ ] Write the table-driven failing tests, each row with input and `{depth, basis, confidence}`:
  - **Claim cap:** claim 4, nothing else → 2, claimed, low.
  - **Evidence floors:** claim 4 + 1 authored → 2, evidence, high; claim 4 + 3 authored → 3, evidence, high; 1 authored with `inDepth` → 3.
  - **Probe level:** know at 1, 2, 3 and no_idea at 4 → 3, probed, high.
  - **Monotonic difficulty:** a single `know` at 3, and nothing else → 3, since 1 and 2 are implied. Because every rated level passed, the result is `max(3, prior)`.
  - **Depth 4 gate:** know at 4 with 1 passed spot-check at 4 → 3. With 2 passes → 4.
  - **Spot-check rule:** know twice at 2 and twice at 3, with both spot-checks at 3 graded fail → level 3 fails the 70% rule. Level 2 qualifies (no spot-checks counted there), so the result is 2, probed.
  - **Probes override claims:** claim 3 + 2 authored (floor 2), probes know at 1, no_idea at 2 → 1, probed, with `disagreement: true` and a "below the claim" reason.
  - **`roughly`** at 2 alone → 1. **`wouldnt_say` only** → `null` when nothing else exists.
- [ ] Implement. Tests pass. Commit "Estimate one topic's depth from claims, evidence and probes".

### Task 5: `@standin/knowledge`: propagation over the map

**Files:** create `packages/knowledge/src/propagate.ts`; test `packages/knowledge/test/propagate.test.ts`.

**Produces:**
```ts
export interface MapSnapshot {
  topics: { id: string; name: string }[];
  edges: { from: string; to: string; kind: "parent" | "requires" }[];   // approved only
  signals: Map<string, TopicSignals>;                                   // authored counts NOT yet rolled up
}
export function estimateMap(m: MapSnapshot): Map<string, Estimate>;
```
- Roll authored counts up from descendants (`parent` edges), then call `estimateTopic` for each topic.
- Iterate to a fixpoint, applying floors:
  - **Upward:** for each `parent` edge child→parent, floor `min(child.depth − 1, 3)`. Confidence: medium if the child is probed, evidence, or medium-predicted; else low.
  - **Prerequisite:** for each `requires` edge T→P, the floor depends on T:
    - T probed, evidence, or medium-predicted: `min(T.depth − 1, 3)`, medium;
    - T claimed: `min(T.rawClaim − 1, 2)`, low;
    - T low-predicted: `min(T.depth − 1, 2)`, low.
- A floor applies only where it is higher than the current depth and the topic isn't `probed`. The result is basis `predicted`, with the reason "predicted {k} from {T name} ({basis} {d}), which requires it" (or "…, a specialization of it" for parents).
- Topics with no estimate get one from floors alone. Floors only rise and depth is bounded, so the loop terminates.

**Steps:**
- [ ] Write the failing tests:
  - **Upward:** RLHF probed at 4 → RL 3 medium → ML 2 medium.
  - **Prerequisite, established:** RLHF probed 4 requires Probability → Probability 3, medium.
  - **Prerequisite, claimed:** a claim of 4 → Probability 2, low.
  - **Transitive:** RLHF 4 → Probability 3 → Calculus 2, for the chain RLHF requires Probability requires Calculus.
  - **Never overrides probes:** Probability probed at 1 stays 1, with `disagreement: true`.
  - **Authored roll-up:** 3 authored items on 3 children give the parent a floor of 3.
- [ ] Implement. Tests pass. Commit "Propagate depth up the tree and down prerequisites".

### Task 6: `@standin/knowledge`: `answerMode` and the calibration score

**Files:** create `packages/knowledge/src/answer.ts` and `src/calibration.ts`; test `packages/knowledge/test/answer.test.ts`.

**Produces:**
```ts
export function answerMode(e: Pick<Estimate, "depth" | "confidence"> | null): AnswerMode;
export interface SetScore { n: number; agree: number; score: number | null }   // score null when n = 0
export function calibrationScore(rows: { holdout: Holdout; predictedMode: AnswerMode; rating: Rating | null }[]): { fixed: SetScore; rotating: SetScore };
```

**Steps:**
- [ ] Write the failing tests:
  - **`answerMode`:** depths 0–4 at high confidence → decline, decline, brief, explain, explain. Depth 3 at low → brief. Depth 2 at low → decline. `null` → decline.
  - **Calibration:** explain+know, brief+roughly and decline+no_idea all agree. explain+no_idea and decline+know disagree. `wouldnt_say`, unrated and `none` rows are excluded. Fixed and rotating are scored separately. Empty → `score: null`.
- [ ] Implement. Commit "Add the answering rule and the calibration score".

### Task 7: `@standin/knowledge`: snapshot from the store, and depth proposals

**Files:** create `packages/knowledge/src/{snapshot.ts,propose.ts,topics.ts}`; test `packages/knowledge/test/propose.test.ts` with a temp store.

**Produces:**
```ts
export function topicOf(store: Store, m: Memory): Entity | null;
export function loadSnapshot(store: Store): MapSnapshot;   // usable responses only: holdout none, or rotating with released_at
export function approvedEstimate(store: Store, topicId: string): Pick<Estimate, "depth" | "confidence" | "basis"> | null; // Plan ruling 3
export interface ProposalReport { proposed: number; replaced: number; unchanged: number; tierSuggestions: number }
export function proposeDepthChanges(store: Store, estimates: Map<string, Estimate>): ProposalReport;
export function suggestTierForWouldntSay(store: Store, topicId: string): Memory | null;  // proposed copy at tier 3 superseding the approved memory, or null
```
- A proposal is inserted through `store.insertMemory` with:
  - `kind: "competence"`;
  - attrs `{ domain: topic name, depth, basis, confidence, reasons }`;
  - `supersedesId` = the approved competence memory for the topic, if any;
  - the topic linked in `entityIds`;
  - actor `map`;
  - salience 1;
  - no source observations.
- Deduplication follows Plan ruling 11; statement, language and tier follow Plan ruling 12.

**Steps:**
- [ ] Write the failing tests:
  - **Holdout:** a held-out unreleased `know` at difficulty 4 does not change the snapshot's signals. After `releaseRotating` it does. A fixed probe's response never does.
  - **First proposal:** an approved claim of 4 with no other signal → one proposal at depth 2, `basis: "claimed"`, superseding nothing (the claim memory itself stays approved). Running again proposes nothing. Rejecting it and running again proposes nothing.
  - **Supersession:** approving the proposal supersedes the claim memory. `approvedEstimate` then returns depth 2, basis claimed.
  - **Topic names:** a topic named `强化学习` with alias `reinforcement learning` gets a zh statement keyed by the entity id (Review Focus 5).
  - **`wouldnt_say`:** `suggestTierForWouldntSay` creates a tier-3 proposed copy only when the approved memory's tier is below 3.
- [ ] Implement. Commit "Propose depth changes from the knowledge map".

### Task 8: `@standin/knowledge`: probe selection and holdout assignment

**Files:** create `packages/knowledge/src/select.ts`; test `packages/knowledge/test/select.test.ts`.

**Produces:**
```ts
export function assignHoldout(rng: () => number): Holdout;   // < 0.10 fixed, < 0.30 rotating, else none
export interface TopicPlan { topicId: string; startLevel: Difficulty; single: boolean }  // single: predicted prerequisite, one probe
export function planTopics(estimates: Map<string, Estimate>, snapshot: MapSnapshot, recent: { topicId: string; at: string }[], now: Date): TopicPlan[];
export class AdaptiveRun {   // one topic's placement-test walk
  constructor(plan: TopicPlan);
  get nextLevel(): Difficulty | null;            // null when done
  record(level: Difficulty, rating: Rating): void;
}
export const SESSION_SIZE = { first: 60, later: 10 } as const;
```
- `planTopics` priority:
  1. low confidence;
  2. `disagreement`;
  3. `predicted` from an established topic (`single: true`);
  4. frontier: topics with no estimate and an approved edge to a topic at depth ≥ 3.
- Ties break by name. Skips follow Plan ruling 8.
- `AdaptiveRun`:
  - start at `startLevel`;
  - `know` → up one; `no_idea` or `roughly` → down one (Plan ruling 2: `roughly` counts against a level);
  - stop when two adjacent levels disagree, at a bound (4 known or 1 failed), after 4 probes, or after 1 if `single`;
  - `wouldnt_say` ends the topic.

**Steps:**
- [ ] Write the failing tests:
  - **Holdout shares:** `assignHoldout` over 10,000 draws of a seeded LCG gives fixed within 0.10±0.01 and rotating within 0.20±0.01.
  - **Adaptive walk:** start 3, know → 4, no_idea → stop with the level pinned at 3.
  - **Short runs:** a `single` run stops after one.
  - **Priority order** matches the list above. A topic probed 10 days ago with high confidence is skipped.
- [ ] Implement. Commit "Select probes adaptively and assign holdout sets".

### Task 9: `@standin/knowledge`: the `quiz`, `map` and `judge` tasks

**Files:** create `packages/knowledge/src/{prompts.ts,schemas.ts,tasks.ts}`; test `packages/knowledge/test/tasks.test.ts`. Modify `examples/demo-persona/src/{index.ts,fixtures.ts}` so `demoLLM()` answers purposes `quiz`, `map` and `judge`.

**Produces:**
```ts
export const QuizSchema = z.object({ probes: z.array(z.object({ difficulty: z.number().int().min(1).max(4), question: z.string() })) });
export const MapSchema = z.object({
  merges: z.array(z.object({ from: z.string(), into: z.string(), reason: z.string() })),
  parents: z.array(z.object({ child: z.string(), parent: z.string(), reason: z.string() })),
  requires: z.array(z.object({ topic: z.string(), requires: z.string(), reason: z.string() })),
});
export const JudgeSchema = z.object({ grade: Grade, reason: z.string() });
export async function writeProbes(store: Store, llm: LLM, topic: Entity, opts: { lang: Lang; rng: () => number; personaName: string }): Promise<Probe[]>;
export async function proposeMapEdits(store: Store, llm: LLM, personaName: string): Promise<{ proposed: number }>;
export async function gradeSpotChecks(store: Store, judge: TracedModel): Promise<{ collected: number; submitted: number; pending: number }>;
```
- **`writeProbes`** (purpose `quiz`):
  - The prompt asks for 2 questions per difficulty, testing "could someone at this level explain or do X", never dates or names, in `opts.lang`.
  - Out-of-range or blank items are dropped. Each kept item gets `assignHoldout(rng)`.
- **`proposeMapEdits`** (purpose `map`):
  - The prompt lists the topics with their aliases and the existing edges.
  - Names are resolved with `resolveEntity({ kind: "topic" })` and passed to `store.proposeEdge`.
- **`gradeSpotChecks`** (purpose `judge`):
  - If an open grade batch has ended, collect it: `recordGrade` for each ok outcome, and clear the batch id on failures so they are resubmitted.
  - Then submit every answered, ungraded response not already in a batch. This uses `judge.submitBatch` when `judge.batchCapable`, otherwise live calls.
  - The prompt includes the question, difficulty and answer. It grades understanding at that difficulty and ignores wording and language.

**Steps:**
- [ ] Write the failing tests (`ScriptedLLM`):
  - **`writeProbes`** stores 8 probes, drops a difficulty-5 item, and assigns holdout from the rng.
  - **`proposeMapEdits`** creates edges, ignores one that duplicates an existing rejected edge, and creates a missing foundation topic.
  - **`gradeSpotChecks`, in order:**
    - Submit: the responses get a batch id, and `pending` counts them.
    - Collect while still processing: nothing changes.
    - Collect after the end: grades are recorded.
    - A failed outcome is resubmitted on the next call (Review Focus 3).
    - Without batch support, grades are recorded live.
- [ ] Add the demo fixtures and implement. Commit "Write probes, propose map edits and grade spot-checks".

### Task 10: `@standin/knowledge`: `ReviewSession`

**Files:** create `packages/knowledge/src/session.ts`; test `packages/knowledge/test/session.test.ts`.

**Produces:**
```ts
export interface SessionDeps { store: Store; models: Models; config: Config; tracer: Tracer; rng: () => number; warn: (msg: string) => void }
export interface NextProbe { responseId: string; probeId: string; topic: string; question: string; difficulty: Difficulty; lang: Lang; done: number; total: number }
export class ReviewSession {
  static async start(deps: SessionDeps): Promise<ReviewSession>;
  next(): NextProbe | null;
  rate(responseId: string, rating: Rating): { spotCheck: boolean };
  answer(responseId: string, text: string): void;
  approveEdge(id: string): TopicEdge;                // re-plans the current walk if its topic was merged
  finish(): Promise<{ released: number; grading: { submitted: number } }>;
  readonly warnings: string[];
}
```
- **`start`:**
  1. `releaseRotating(now)` (Plan ruling 7);
  2. `gradeSpotChecks`;
  3. `proposeMapEdits`;
  4. `estimateMap` then `proposeDepthChanges`;
  5. plan the topics;
  6. `writeProbes` for the planned topics that need them.
  - Each model step is wrapped. A failure adds one warning and the session continues (Review Focus 4).
  - The whole session runs inside `tracer.run("review", …)`, which `finish` ends.
- **`next`:**
  - Picks the planned walk's level.
  - Takes an unshown probe for that topic and level (Plan ruling 8).
  - Records `showProbe(probeId, answerMode(approvedEstimate(topic)))` **before** returning.
  - Size: `SESSION_SIZE.first` if no response exists yet, else `.later`.
- **`rate`:**
  - Records the rating.
  - A `know`/`roughly` rating requests a spot-check when `rng() < 0.2`.
  - `wouldnt_say` calls `suggestTierForWouldntSay`.
- **`answer`:**
  - Creates the probe observation and links it (Plan ruling 6).
  - Inserts an exemplar only when the probe is `none`, or already released.
  - For a rotating probe, the exemplar is created by `finish` at release time. A fixed probe never gets one.
- **`finish`:** releases this session's rotating probes and creates their deferred exemplars, then submits grading.

**Steps:**
- [ ] Write the failing tests (temp store, demo `ScriptedLLM`, fixed rng):
  - **Prediction first:** the stored `predictedMode` equals `answerMode` at show time. Approving a depth change before rating does not change it.
  - **First and later sessions:** the first session serves up to 60 probes, the next one 10.
  - **Holdout:** a rotating probe's response doesn't change the snapshot until `finish`. A fixed probe's spot-check never produces an exemplar. A `none` probe's spot-check does.
  - **Double rating:** rating the same response twice throws `AlreadyRatedError` (Review Focus 1).
  - **Merge mid-session:** approving a `same` edge mid-session continues on the surviving topic (Review Focus 2).
  - **Models down:** with `quiz` and `map` throwing, `start` succeeds with 2 warnings. With no probes, `next()` returns `null`.
  - **Trace:** the session produces a run of kind `review`, with `quiz`/`map`/`judge` spans under it.
- [ ] Implement. Commit "Run review sessions with holdout-safe probing".

### Task 11: `@standin/review`: the local server and page

**Files:** create the package `packages/review` (`src/server.ts`, `src/page.html`, `src/index.ts`), depending on knowledge, compaction (`reviewQueue`), store and schema; test `packages/review/test/server.test.ts`.

**Produces:**
```ts
export interface ReviewServerOptions { session: ReviewSession; store: Store; config: Config; lan: boolean; port?: number; token?: string }
export async function startReviewServer(o: ReviewServerOptions): Promise<{ url: string; host: string; port: number; token: string; close(): Promise<void> }>;
```
- **Token:** 32 bytes from `crypto.randomBytes`, base64url. It is compared with `timingSafeEqual`.
- **Binding:** host is `127.0.0.1`, or `0.0.0.0` with `lan`. Port defaults to 0 (any free port).
- **Routes.** Every route checks the token, and anything else is 403.

  | Route | Does |
  |---|---|
  | `GET /?t=` | The page |
  | `GET /api/state` | `{ queue, exemplars, edges, warnings, progress }` |
  | `GET /api/next` | `NextProbe \| null` |
  | `POST /api/responses/:id/rate {rating}` | `{spotCheck}`; 409 on `AlreadyRatedError` |
  | `POST /api/responses/:id/answer {text}` | Records the spot-check answer |
  | `POST /api/memories/:id/approve {statement?, tier?}` | |
  | `POST /api/memories/:id/reject` | |
  | `POST /api/exemplars/:id/approve` and `/reject` | |
  | `POST /api/edges/:id/approve` and `/reject` | 409 with the cycle path on `CycleError` |
  | `POST /api/finish` | Finishes the session |

- **Responses:** errors are JSON `{ error }`, with 404 for `NotFoundError` and 400 for validation.
- **Page:** plain HTML, CSS and JS in one file.
  - Probe card with keys `1`–`4` (know, roughly, no idea, wouldn't say). The text box opens when `spotCheck` is true; Enter submits, Esc skips.
  - Memory cards show depth changes with their reasons and the old → new depth. Keys `a`/`r`/`e`.
  - Edge cards for merges, parents and prerequisites.
  - Dark-mode aware, and works at phone width.

**Steps:**
- [ ] Write the failing tests (`fetch` against a server on port 0, with a temp instance):
  - **Token:** no token, or a wrong one, gets 403 on `/` and on `/api/state`. A token given as a query parameter on `/api/*` gets 403.
  - **Binding:** the `host` is `127.0.0.1` without `lan` and `0.0.0.0` with it.
  - **End to end:**
    - `next` → `rate` (know) → `answer` when asked;
    - approve one memory and reject another;
    - an edge approval that would make a cycle gets 409 with the path;
    - `finish` releases rotating probes.
  - **Double rating:** the second `rate` gets 409 (Review Focus 1).
- [ ] Implement. Commit "Serve the local review page".

### Task 12: CLI `review` and `map`; docs

**Files:** create `apps/cli/src/commands/{review.ts,map.ts}`; modify `commands/index.ts`, `main.ts` (USAGE) and `apps/cli/package.json` (add `@standin/review`, `@standin/knowledge`, `qrcode-terminal`); test in `apps/cli/test/e2e.test.ts`. Update `README.md`.

**USAGE lines:**
```
  review [--lan] [--port N] [--demo-llm]         probe what you know and review proposals on a local page
  map [--json]                                   topics with depth, basis and confidence; calibration score
```
- **`review`:**
  - Starts a session and the server, prints the URL, and with `--lan` prints the QR code and a warning that the page shows private data.
  - Prints warnings, then waits for SIGINT or `/api/finish`, finishes the session and exits 0.
  - Tests start it with an injected `io.signal` (an `AbortSignal` added to `CliIO`) instead of SIGINT.
- **`map`:**
  - Prints the parent tree, indented: `name  depth  basis  confidence`, then `requires: …` lines.
  - Ends with "calibration: fixed a/n (x%), rotating a/n (y%)", or "not enough held-out answers yet".
- **README:** a "Knowledge map" section covering the depth scale, how depth is combined, probes and spot-checks, holdout and the calibration score, the answering rule, and `standin review` with its security notes.

**Steps:**
- [ ] Write the failing e2e test on the demo persona:
  - `init --demo` → `compact --demo-llm` → approve the extracted competence memories;
  - `review --demo-llm` with an aborting signal after a scripted HTTP walk: rate 3 probes, then finish;
  - `map --json` shows the topics with estimates and the calibration counts for both sets, and `traces --kind review` lists the session.
- [ ] Implement. Run `pnpm typecheck && pnpm test && pnpm guard`.
- [ ] Manual smoke test against a temp `STANDIN_HOME`: `standin review --demo-llm`, open the URL, and rate with the keyboard. Commit "Add review and map commands".

### Task 13: Finish

- [ ] Self-review the branch diff against the spec (§2–§8) and the Review Focus. Fix anything that drifted.
- [ ] Optional live check, only if credentials exist: a real `standin review` with 5 probes, then `standin usage --by role` shows `quiz`, `map` and `judge`.
- [ ] Push `knowledge-map` and open a PR. The title is "Knowledge map and local review page (SP2a)". The body covers what changed, the plan rulings, and the test plan, and ends with the Claude Code line. Merging needs Mingxi's OK.
