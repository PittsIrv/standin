# SP2a-2a: The Probing Engine. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution: Claude implements inline (the user's standing choice: no Codex, no subagents).

**Goal:** A tested probing engine: a session API that SP2a-2b's page drives. It covers:
- claim checks, gaps, and keeping or lowering a claim;
- foundations, which check all inferred lighting;
- discovery;
- spot-checks with batch grading;
- held-out probes and their release;
- boundaries;
- both calibration scores, shown in `standin map`.

**Architecture:**
- **`store`:** migration 6 adds probes, responses and sessions.
- **`@standin/knowledge`:** a `probing/` module.
  - **Expansion:** the `map` role, purpose `expand`.
  - **Probe writing:** the `quiz` role.
  - **A pure planner** that picks the next target by strict priority.
  - **`ProbeSession`**, the stateful API, which owns the holdout invariants.
  - **Grading:** the new `grade` role, through the batch API.
  - **Calibration.**
- **The demo persona** answers `expand`, `quiz` and `grade`, so everything runs offline.

**Tech Stack:** Node 24, TypeScript (strict), zod v4, vitest, `node:sqlite`.

**Spec:** `docs/specs/2026-10-07-knowledge-map.md` §4 and §6, and decisions 1–36.

## Global Constraints

- **Ratings:** `know | roughly | no_idea | wouldnt_say`. Difficulty runs 1–4, and difficulty `d` probes depth `d`.
- **Session size:** the first session ever is **40** probes, later ones **10**, and `size` overrides both.
- **Strict priority** (spec §4.3): pending follow-ups first, then claim checks, then foundations, then discovery.
- **Claim check** (§4.4):
  - For each approved claim (`basis` absent, depth ≥ 1) not yet checked: **3 probes at difficulty = the claimed depth**, each on a different component of the claimed node. The node is expanded first if it has no parts.
  - A claim is **checked** once its 3 probes are answered and no gap on it is `open`. Checked, kept and lowered claims are not probed again.
  - Claims at depth 0 are never probed.
- **Misses** (§4.4): a `no_idea` on a claim, follow-up or foundation probe, or a `know` whose spot-check graded `fail`. `roughly` is never a miss.
  - **Gap:** one follow-up probe on the same node at difficulty `d − 1`.
    - If `d − 1 = 0`, there is no follow-up and the gap level is 0.
    - Otherwise the gap level is `d − 1` when the follow-up rating is `know` or `roughly`, and `max(d − 2, 0)` otherwise.
    - The gap is recorded with `source: "probe"`, `status: "open"` (claim probes) or `"kept"` (foundation probes), and `responseId`.
  - **Not a gap:** nothing changes.
- **Keep or lower** (§4.4):
  - **Keep:** the claim's open gaps become `kept`, and the branch is no longer probed.
  - **Lower:** the gaps become `lowered`. A new competence memory at `min(gap levels)` supersedes the claim and is approved immediately (actor `person`, since it's the person's own decision). The claim counts as checked.
- **Foundations** (§4.5, decision 36): every approved node lit with `basis: "predicted"` gets **1 probe at its depth**, once.
  - `know` (with no failed spot-check) marks it **confirmed**: shown as `predicted, confirmed`, with no memory written.
  - A miss goes to the person.
- **Discovery** (§4.6):
  - **Candidates:** dark nodes that are a part, a sibling or a prerequisite of a node lit at ≥ 3. Lit nodes are expanded when there are no candidates.
  - **The walk:** start at difficulty 2; `know` steps up one level, and the walk stops on any other rating or after 4.
  - **The proposal:** at session finish, the highest level rated `know` becomes a lighting proposal with `basis: "probed"` (§3.6 rules: never repeated, a rejection is never re-proposed). Depth 4 needs **2** passed spot-checks at difficulty 4; until those grades arrive, it proposes 3. The 4 is re-proposed when the grades come in.
  - Discovery misses aren't shown to the person.
- **Spot-checks** (§4.7):
  - Requested on `know`/`roughly` when `rng() < 1/3`.
  - **The answer:** an observation with `sourceKind: "probe"`, `authorRole: "self"`, `sourceRef: "probe:<probeId>"` and text `Q: …\n\nA: …`. It is marked `processed` immediately, and never compacted.
  - **Grading** uses the `grade` role (medium). At `finish`, ungraded answers are submitted through `submitBatch` when the provider is `batchCapable`, otherwise graded live. At `start`, the batch is collected. Failed outcomes have their batch id cleared and are resubmitted.
- **Holdout** (§4.8): assigned at probe creation, `rng() < 0.10` → `fixed`, `< 0.30` → `rotating`, otherwise `none`. A probe is never reassigned or shown twice.
  - **Prediction first:** `next()` stores `answerMode(node).mode` on the response before returning it.
  - **"Usable"** means `holdout: "none"`, or `rotating` and released. Only usable responses can:
    - confirm a foundation;
    - count in a discovery walk's proposal;
    - become exemplars.
  - **Misses:** fixed misses are never shown, and rotating misses only after release.
  - **Release:** at `finish`, rotating probes answered in this session are released, and their deferred exemplars created. At `start`, so are rotating probes answered in any session that never finished.
- **Boundaries** (§3.5): `wouldnt_say` sets `boundaryTier: 3` on the probe's node at once. `undoBoundary(nodeId)` clears it.
- **Calibration** (§6):
  - Computed over held-out, rated, non-`wouldnt_say` responses.
  - A response agrees when the prediction `explain`/`brief` meets `know`/`roughly`, or `decline` meets `no_idea`.
  - **Map score:** excludes responses whose node is in a kept branch (the node, or an ancestor, is the `claimNodeId` of a `kept` gap).
  - **Presented score:** all responses.
  - Each score is reported per `fixed` and `rotating` set as `{ n, agree, score | null }`.
- **Roles:**
  - `quiz` purpose becomes "Write knowledge probes for a node at a difficulty".
  - New `grade`: medium, private, "Grade spot-check answers".
  - `map` gains purpose `expand`, returning 4–8 components with definitions, plus prerequisites.
- **Model failures:** a failed expand, quiz or grade call adds a warning. That target is skipped for this session and the session goes on. `next()` returns `null` when no target can be served.
- **Tracing:** a session is a run of kind `review`. Model calls are spans under it.
- **Commits:** Mingxi is the author. Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **The same response rated twice** (a double-click). The second call throws `AlreadyRatedError`, and the first rating stands. Tested in Task 2.
2. **A fixed probe answered `no_idea` with a spot-check.** It is never in `pendingMisses()`, never confirms a foundation or counts for discovery, and never becomes an exemplar, even after several sessions. Tested in Task 5.
3. **A crash mid-session** (no `finish`). The next `start` releases that session's rotating probes and grades their spot-checks. Its unrated shown responses don't count anywhere. Tested in Task 5.
4. **`quiz`, `map` and `grade` all failing.** `start` succeeds with warnings, and `next()` returns `null` rather than throwing. A later session with working models picks up where this one left off. Tested in Task 5.
5. **A node deleted or merged while it has probes.** Merging moves probes and responses to the survivor (Task 2). The planner never targets a deleted node, and calibration still counts its past held-out responses (Task 8).

---

### Task 0: Branch setup

- [ ] Branch `sp2a2a-probing` from `main`. `pnpm typecheck && pnpm test` is green.

### Task 1: Schema

**Files:** `packages/schema/src/{records.ts,roles.ts,ids.ts}`; tests in `packages/schema/test/{schema.test.ts,models.test.ts}`.

**Produces:**
```ts
export const Rating = z.enum(["know", "roughly", "no_idea", "wouldnt_say"]);
export const Holdout = z.enum(["none", "fixed", "rotating"]);
export const AnswerModeName = z.enum(["explain", "brief", "decline"]);
export const ProbeKind = z.enum(["claim", "followup", "foundation", "discovery"]);
export const Probe = z.object({ id, nodeId, checkOf: z.string().nullable(), kind: ProbeKind, difficulty: Depth.min(1), question: NonBlank, holdout: Holdout, createdAt: IsoTime, releasedAt: IsoTime.nullable() });
export const ProbeResponse = z.object({ id, probeId, sessionId, shownAt: IsoTime, predictedMode: AnswerModeName, rating: Rating.nullable(), answeredAt: IsoTime.nullable(),
  spotCheck: z.enum(["none", "requested", "answered"]), spotCheckAnswer: z.string().nullable(), observationId: z.string().nullable(),
  grade: z.enum(["pass", "fail"]).nullable(), gradeReason: z.string().nullable(), gradeBatchId: z.string().nullable(),
  judged: z.enum(["gap", "not_gap"]).nullable() });
export const ReviewSession = z.object({ id, startedAt: IsoTime, endedAt: IsoTime.nullable(), size: z.number().int().positive() });
// Gap gains responseId: z.string().nullable(); SourceKind gains "probe"; ID_PREFIXES gain "prb", "rsp", "ses"; roles per Global Constraints
```

**Steps:**
- [ ] Write the failing tests: each record parses its happy path and rejects difficulty 0, an unknown rating, and an unknown holdout; `ROLES.grade` is `{ medium, private }`; `SourceKind` accepts `"probe"`.
- [ ] Implement. Run `pnpm vitest run packages/schema`; it passes. (Commit with Task 2.)

### Task 2: Store: probes, responses, sessions

**Files:** `packages/store/src/{migrations.ts,probes.ts,store.ts,tree.ts,errors.ts,index.ts}`; test `packages/store/test/probes.test.ts`.

**Migration 6:** tables `probes`, `probe_responses` and `review_sessions`, with columns mirroring Task 1's records, plus `ALTER TABLE gaps ADD COLUMN response_id TEXT REFERENCES probe_responses(id)`.

**Produces:**
```ts
startSession(size: number): ReviewSession; endSession(id: string): ReviewSession; listSessions(): ReviewSession[];
insertProbe(p: Omit<Probe, "id" | "createdAt" | "releasedAt">): Probe; listProbes(f?: { nodeId?: string; kind?: ProbeKind }): Probe[];
showProbe(probeId: string, sessionId: string, predictedMode: AnswerModeName): ProbeResponse;   // throws if the probe was ever shown
rateResponse(id: string, rating: Rating, spotCheck: boolean): ProbeResponse;                     // AlreadyRatedError if rated
answerSpotCheck(id: string, answer: string, observationId: string): ProbeResponse;
judgeResponse(id: string, judged: "gap" | "not_gap"): ProbeResponse;
recordGrade(id: string, grade: "pass" | "fail", reason: string): ProbeResponse; setGradeBatch(ids: string[], batchId: string | null): void;
listResponses(f?: { sessionId?: string; rated?: boolean; ungraded?: boolean }): (ProbeResponse & { probe: Probe })[];
releaseRotating(sessionIds: string[]): Probe[];      // rotating probes with a rated response in those sessions
setGap(id: string, patch: { status?: Gap["status"]; level?: number }): Gap;
// mergeTopics also moves probes.node_id / probes.check_of
```

**Steps:**
- [ ] Write the failing tests:
  - **Double rating:** rating twice throws `AlreadyRatedError` (Review Focus 1).
  - **No repeats:** `showProbe` on an already shown probe throws.
  - **Release:** `releaseRotating` releases only rotating probes rated in the given sessions, never `fixed` or `none`.
  - **Merges:** `mergeTopics` moves probes to the survivor (Review Focus 5).
  - **Gaps:** `setGap` updates the status.
- [ ] Implement. Run `pnpm vitest run packages/schema packages/store`; it passes. Commit "Store probes, responses and review sessions".

### Task 3: Expansion and probe writing

**Files:** `packages/knowledge/src/probing/{expand.ts,quiz.ts,prompts.ts,schemas.ts}`; test `packages/knowledge/test/probing-models.test.ts`; demo fixtures (`expand`, `quiz`) in `examples/demo-persona/src/{index.ts,fixtures.ts}`.

**Produces:**
```ts
export const ExpandSchema = z.object({ components: z.array(z.object({ name: z.string(), definition: z.string() })), prerequisites: z.array(z.object({ name: z.string(), definition: z.string() })) });
export const QuizSchema = z.object({ probes: z.array(z.object({ question: z.string() })) });
export async function expandNode(store: Store, map: LLM, nodeId: string, personaName: string): Promise<{ components: string[]; prerequisites: string[] }>; // once per node (expandedAt); part_of source "expansion", requires source "expansion"; cycles skipped
export async function writeProbes(store: Store, quiz: LLM, o: { nodeId: string; difficulty: number; kind: ProbeKind; checkOf: string | null; count: number; rng: () => number }): Promise<Probe[]>;
export function assignHoldout(rng: () => number): Holdout;
```
- **The `quiz` prompt** includes the node's name and definition, and its parent's name. It asks for questions testing "could someone at this level explain or do X" at the given difficulty (with the 0–4 scale), never dates or names, in English, one sentence each.

**Steps:**
- [ ] Write the failing tests (`ScriptedLLM`):
  - **Expansion runs once:** `expandNode` adds 5 parts and 1 prerequisite and sets `expandedAt`; a second call makes no model call.
  - **Bad answers are dropped:** a component that would make a cycle is skipped, and blank questions are dropped.
  - **Holdout shares:** `assignHoldout` over 10,000 draws of a seeded LCG gives fixed 0.10 ± 0.01 and rotating 0.20 ± 0.01.
  - **`writeProbes`** stores `count` probes, each with a holdout from the rng.
- [ ] Implement with the demo fixtures. Commit "Expand nodes and write probes".

### Task 4: The planner

**Files:** `packages/knowledge/src/probing/plan.ts`; test `packages/knowledge/test/plan.test.ts`.

**Produces:**
```ts
export type Target =
  | { kind: "followup"; nodeId: string; difficulty: number; checkOf: string | null; gapOf: string }   // gapOf: the response judged a gap
  | { kind: "claim"; nodeId: string; difficulty: number; checkOf: string }                            // nodeId: a component of checkOf
  | { kind: "foundation"; nodeId: string; difficulty: number }
  | { kind: "discovery"; nodeId: string; difficulty: number };
export interface ProbeState { responses: (ProbeResponse & { probe: Probe })[]; children: Map<string, string[]> }
export function nextTarget(t: TreeSnapshot, s: ProbeState, skip: Set<string>): Target | "expand:<nodeId>" | null;
```
- **Pure, with this priority:**
  1. **Follow-ups** for responses judged `gap` that have no follow-up yet.
  2. **Claim checks:** claims in name order. A component counts as used once it has a claim probe for that claim. If a claim's node has fewer than 3 parts and isn't expanded, return `expand:<id>`.
  3. **Foundations:** nodes with approved `predicted` lighting and no foundation response.
  4. **Discovery:** continue an unfinished walk first. Otherwise take the first candidate in name order. If there are no candidates, return `expand:<id>` for the first unexpanded node lit at ≥ 3.
- **Kept or lowered claims,** and nodes in their kept branches, are skipped, as are deleted nodes and anything in `skip` (targets whose probes couldn't be written this session).

**Steps:**
- [ ] Write the failing table-driven tests, each a snapshot plus responses → the expected target:
  - **Claim checks:** claim at 3 with 4 parts → claim probe at difficulty 3 on the first unused part; after 3 answered → the next claim. A claim at 0 is skipped. An unexpanded claimed node → `expand:`.
  - **Order:** a pending follow-up beats claims, and claims beat foundations.
  - **Foundations:** a seeded node at 2 → foundation at difficulty 2, once.
  - **Discovery walk:** `know` at 2 → 3; `no_idea` stops it; 4 is the cap.
  - **Skipping:** kept branches skipped; deleted nodes skipped.
- [ ] Implement. Commit "Plan probes by strict priority".

### Task 5: `ProbeSession`

**Files:** `packages/knowledge/src/probing/session.ts`; test `packages/knowledge/test/session.test.ts`.

**Produces:**
```ts
export interface SessionDeps { store: Store; map: LLM; quiz: LLM; grade: TracedModel | LLM; tracer: Tracer; rng: () => number; personaName: string; size?: number }
export interface ShownProbe { responseId: string; nodeId: string; topic: string; question: string; difficulty: number; kind: ProbeKind; done: number; total: number }
export class ProbeSession {
  static start(deps: SessionDeps): Promise<ProbeSession>;   // inside tracer.run("review"): release unfinished sessions, collect grades, refresh() (SP2a-1), startSession
  next(): Promise<ShownProbe | null>;                         // plans, expands or writes on demand, shows (prediction first)
  rate(responseId: string, rating: Rating): { spotCheck: boolean };
  answer(responseId: string, text: string): void;             // spot-check answer → probe observation; exemplar now only if holdout none
  undoBoundary(nodeId: string): void;
  finish(): Promise<FinishReport>;                            // release, deferred exemplars, discovery proposals, submit grading, endSession
  readonly warnings: string[];
}
export interface FinishReport { released: number; exemplars: number; discoveryProposals: number; gradingSubmitted: number }
```

**Steps:**
- [ ] Write the failing tests (temp store; demo-style `ScriptedLLM`s; a seeded rng that forces chosen holdouts and spot-checks):
  - **Prediction first:** the stored `predictedMode` equals `answerMode` at show time, and approving lighting before rating doesn't change it.
  - **Session size:** the first session serves up to 40, the second up to 10, and `size: 3` serves 3.
  - **`wouldnt_say`:** sets a boundary immediately; `undoBoundary` clears it.
  - **Spot-checks:** a `none` probe's answer creates a proposed exemplar at once. A rotating probe's exemplar appears only after `finish`. A fixed probe never gets one (Review Focus 2).
  - **Crash recovery:** a session left without `finish`, then a new `start`, releases its rotating probes (Review Focus 3).
  - **Models down:** with all models throwing, `start` succeeds, `warnings` is non-empty, and `next()` returns `null` (Review Focus 4).
  - **Trace:** the session is a `review` run with `map`, `quiz` and `grade` spans.
- [ ] Implement. Commit "Run probe sessions with holdout-safe rules".

### Task 6: Misses, gaps, keep and lower

**Files:** `packages/knowledge/src/probing/{misses.ts,session.ts}`; test `packages/knowledge/test/gaps-probe.test.ts`.

**Produces** (`ProbeSession` methods):
```ts
pendingMisses(): { responseId: string; topic: string; question: string; difficulty: number; reason: "no_idea" | "failed_check" }[];  // judgeable only (holdout rules)
judgeMiss(responseId: string, isGap: boolean): void;      // gap → schedules the follow-up (or records level 0 when d = 1)
pendingClaimDecisions(): { claimNodeId: string; topic: string; claimed: number; gaps: { topic: string; level: number }[] }[];
decideClaim(claimNodeId: string, choice: "keep" | "lower"): void;
```

**Steps:**
- [ ] Write the failing tests:
  - **The full gap path:** a claim at 3; `no_idea` on part A → pending miss → judged a gap → the next target is a follow-up at 2 on A → rated `know` → an open gap on A at level 2 → `pendingClaimDecisions` lists it.
  - **Keep:** gaps become kept; the claim isn't probed again; `answerMode(A)` is brief, and a sibling explains.
  - **Lower:** the claim memory is superseded by an approved one at 2.
  - **Other judgments:** a miss judged "not a gap" changes nothing. A miss at difficulty 1 judged a gap records level 0 with no follow-up.
  - **Failed spot-checks:** a `know` whose spot-check is graded `fail` appears in the next session's `pendingMisses` as `failed_check`.
  - **Holdout:** fixed misses never appear; rotating misses appear only after release (Review Focus 2).
  - **Foundations:** a foundation miss judged a gap → a kept gap on that node.
- [ ] Implement. Commit "Turn misses into gaps the person confirms, then keep or lower".

### Task 7: Grading, foundations confirmed, discovery proposals

**Files:** `packages/knowledge/src/probing/{grade.ts,discovery.ts}`, `snapshot.ts` (confirmed foundations), `lighting.ts` (probed is never overridden); test `packages/knowledge/test/grade-discovery.test.ts`; demo fixture `grade`.

**Produces:**
```ts
export const GradeSchema = z.object({ grade: z.enum(["pass", "fail"]), reason: z.string() });
export async function collectGrades(store: Store, grade: LLM): Promise<{ collected: number; failedResubmit: number }>;
export async function submitGrades(store: Store, grade: LLM): Promise<{ submitted: number; gradedLive: number }>;
export function discoveryProposals(store: Store, t: TreeSnapshot): string[];   // §4.6 rules, basis "probed"
// TreeSnapshot gains `confirmed: Set<string>`; RuleValue basis gains "probed" (from approved probed lighting), and computeLighting never raises a probed node
```

**Steps:**
- [ ] Write the failing tests:
  - **Grading:**
    - with batch support, submit sets the batch id;
    - collect while processing changes nothing;
    - collect when ended records the grades;
    - a failed outcome is resubmitted next time;
    - without batch support, grading happens live.
  - **Foundations:** a usable `know` confirms the node: `map --json` shows basis `predicted`, `confirmed: true`.
  - **Discovery:**
    - know at 2, 3 and 4 with no grades → proposal at 3;
    - after 2 passed grades at 4 → proposal at 4;
    - a rejected 3 is never re-proposed.
  - **Precedence:** approved probed lighting is not raised by inference.
- [ ] Implement. Commit "Grade spot-checks, confirm foundations, propose discoveries".

### Task 8: Calibration, and showing it

**Files:** `packages/knowledge/src/probing/calibration.ts`; `apps/cli/src/commands/map.ts` (calibration lines, `--private`); tests `packages/knowledge/test/calibration.test.ts` and `apps/cli/test/map.test.ts`; README.

**Produces:**
```ts
export interface SetScore { n: number; agree: number; score: number | null }
export function calibration(store: Store, t: TreeSnapshot): { map: { fixed: SetScore; rotating: SetScore }; presented: { fixed: SetScore; rotating: SetScore } };
```
- **`standin map`** ends with "Calibration (map score): fixed a/n (x%), rotating a/n (y%)", or "not enough held-out answers yet".
- **`--private`** adds the presented score and the difference between the two.

**Steps:**
- [ ] Write the failing tests:
  - **Agreement:** explain + know, brief + roughly and decline + no_idea agree; explain + no_idea disagrees.
  - **Exclusions:** `wouldnt_say`, unrated and `none` responses are excluded. A kept-branch response counts in the presented score but not the map score.
  - **Empty:** with no responses, `score: null`.
  - **Deleted nodes:** a deleted node's past held-out responses still count (Review Focus 5).
  - **CLI:** `map` prints both lines as specified.
- [ ] Implement. README: a "Probing" section explaining sessions, claim checks, gaps, keep/lower, holdout and calibration, and noting that the page comes in SP2a-2b. Run `pnpm typecheck && pnpm test && pnpm guard`, all green. Commit "Score calibration on held-out probes".

### Task 9: Finish

- [ ] Self-review the branch against the spec (§4, §6, decisions 35–36) and the Review Focus.
- [ ] Push `sp2a2a-probing` and open a PR titled "SP2a-2a: the probing engine". Merging needs Mingxi's OK.
