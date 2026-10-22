# Local Answering and Evals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The standin answers questions locally as a visitor would see it, with a harness and a self-quiz that measure it.

**Architecture:** A new `@standin/speak` package runs one turn: route, awaken, filter, decide the state, speak, check. A new `@standin/evals` package builds, runs and grades cases and holds the self-quiz deck. The CLI gains `standin ask` and `standin eval build|run`; the review page gains an Ask tab and quiz cards.

**Tech Stack:** TypeScript, Node 24 `node:sqlite`, zod v4, vitest, the existing `ScriptedLLM`.

**Spec:** `docs/specs/2026-10-22-local-answering-and-evals.md`

## Global Constraints

- Only approved memories at tier 1–2, not under a tier-3 boundary, reach the `speak` prompt. Hypotheses reach it only at P ≥ `hypotheses.speakAt`.
- Deflections and empty declines are templates with no model call.
- A rejected reply becomes the not-on-record template; the reason goes in `work`.
- Private cases, runs and baselines live under `~/.standin/evals/`, never in the repo.
- Roles: `answer` (route, speak) and new `check` (small, public). Cases use `judge` (purpose `case`); grading uses `judge` (purpose `judge`).
- Numbers: candidates 10, seeds 3, awaken budget 20, leak run 8 words, exemplars 3 × 600 chars, cases 20 per suite, regression 5 points, quiz every 10th card, score shown from 20 rated answers.
- Commits: Mingxi is the author; every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A question that names nothing in the tree: no route call, a not-on-record reply.
2. A memory under a tier-3 node that also matches the question: never in the prompt, and the reply is deflected.
3. A speaker reply that cites a filtered-out id, or quotes 8+ words of a tier-4 memory: rejected, not shown.
4. A `check` model failure (throws): the reply falls back to not on record and does not crash.
5. A `cases.jsonl` line the person mistyped: `eval run` names the line and skips it, without stopping.

---

### Task 1: Schema, config and store

**Files:**
- Modify: `packages/schema/src/roles.ts` (role `check`), `packages/schema/src/config.ts` (sections `answer`, `selfQuiz`, `evals`), `packages/schema/src/records.ts` (`QuizRating`, `QuizAnswer`), `packages/schema/src/ids.ts` (prefixes `qz`, `pp`)
- Modify: `packages/store/src/migrations.ts` (migration 13), `packages/store/src/store.ts`
- Create: `packages/store/src/quiz.ts`
- Test: `packages/store/test/quiz.test.ts`, config snapshot test

**Interfaces (produces):**
- `QuizAnswer = { id, caseId, question, personAnswer, standinReply, state, rating: "same"|"partly"|"wrong"|null, sessionId: string|null, at }`
- `store.addQuizAnswer(q: Omit<QuizAnswer,"id"|"at"|"rating">): QuizAnswer`, `store.rateQuizAnswer(id, rating): QuizAnswer`, `store.listQuizAnswers(): QuizAnswer[]`
- `store.addPreferencePair({ question, standinAnswer, personAnswer }): PreferencePair`
- config `answer { awakenBudget: 20, seeds: 3, candidates: 10, exemplars: 3, exemplarChars: 600 }`, `selfQuiz { every: 10 }`, `evals { perSuite: 20, regression: 5 }`

- [ ] Write tests: a quiz answer round-trips and is rated; a preference pair is stored; defaults appear in the config snapshot. Run them; they fail.
- [ ] Implement; run `pnpm vitest run packages/store packages/schema`; they pass. Commit.

### Task 2: Route and awaken (`@standin/speak`)

**Files:**
- Create: `packages/speak/{package.json,src/index.ts,src/awaken.ts,src/prompts.ts,src/schemas.ts}`, `packages/speak/test/awaken.test.ts`
- Modify: `packages/knowledge/src/index.ts` (export `words`)

**Interfaces (produces):**
- `candidates(store, question, n = 10): Topic[]`: idf-weighted shared words with each live node's name and aliases (name words ×2), best first.
- `RouteSchema = { seeds: number[] }` (1-based candidate numbers), `buildRoutePrompt(question, candidates)`
- `awaken(store, question, seeds: string[], opts: { budget, speakAt }): Awakened`
- `Awakened = { seeds: { id, name, root, mode: AnswerMode, boundary: boolean }[]; memories: ContextMemory[]; hypotheses: { nodeId, name, depth, p }[]; filtered: { id, reason: "status"|"tier"|"boundary"|"expired"|"budget" }[] }`
- `ContextMemory = { id, statement, kind, tier, nodeId, nodeName }`

The spread goes from each seed: ancestors, children (lit or probable), and related links. Memories come from each node's homed memories plus topic-linked ones, deduplicated, ranked by shared words with the question, and kept up to the budget. For Knowledge seeds, `answerMode(loadSnapshot(store), id, { speakAt })` gives the mode; other roots are `explain` when they hold allowed memories, otherwise `decline`.

- [ ] Write tests:
  - candidates rank by name words;
  - a tier-4 memory, a proposed memory, and a memory under a tier-3 node are each filtered with their reason;
  - a boundary seed is marked;
  - the budget caps memories at the best-matching N;
  - a hypothesis below `speakAt` is left out.
- [ ] Implement until green. Commit.

### Task 3: One turn (`answerTurn`)

**Files:**
- Create: `packages/speak/src/turn.ts`, `packages/speak/src/check.ts`, `packages/speak/test/turn.test.ts`
- Modify: `packages/speak/src/{prompts,schemas,index}.ts`

**Interfaces (produces):**
- `answerTurn(deps: TurnDeps, question: string): Promise<Reply>`
- `TurnDeps = { store, answer: LLM, check: LLM, tracer, personaName, speakAt, limits: { candidates, seeds, awakenBudget, exemplars, exemplarChars } }`
- `Reply = { text, state: AnswerState, reason: "nothing"|"competence"|"check"|null, cites: { id, statement, node }[], general: boolean, work: Work, traceId }`
- `AnswerState = "grounded"|"inferred"|"not_on_record"|"deflected"`
- `SpeakSchema = { reply: string, state: "grounded"|"inferred"|"not_on_record", cites: string[], general: boolean }`, `CheckSchema = { supported: boolean, unsupported: string[] }`
- `codeCheck(out, ctx: { allowed: Set<string>, hasHypothesis: boolean, hasStance: boolean, generalAllowed: boolean, canary: string, hidden: string[] }): string | null` (the reason, or null)
- `TEMPLATES`: `deflected(name)`, `notOnRecord(name, reason)`

Order: route (skipped with no candidates) → awaken → deflect if any seed has `boundary` → not on record (reason `competence` if every Knowledge seed declines, else `nothing`) if there are no memories, no hypotheses and no `general` allowed → speak → `codeCheck` → model check (a thrown error counts as a rejection) → fall back on any rejection. Each step is a `tracer.span`, all inside `tracer.run("ask", …)`. The canary is a random `cnry_<hex>` per turn. Exemplars: the approved ones, ranked by shared words, the top 3, cut to 600 chars. `hidden` = statements of the memories filtered out.

- [ ] Write tests with `ScriptedLLM`:
  - grounded with cites;
  - a deflection makes no speaker call;
  - no candidates means no model calls at all;
  - a forged cite is rejected and falls back;
  - an 8-word leak of a filtered memory is rejected;
  - the canary in a reply is rejected;
  - `check` returning unsupported falls back;
  - `check` throwing falls back;
  - `general` with every mode `decline` is rejected;
  - the speak prompt never holds a tier-4 statement.
- [ ] Implement until green. Commit.

### Task 4: `standin ask` and the demo model

**Files:**
- Create: `apps/cli/src/commands/ask.ts`, `apps/cli/test/ask.test.ts`
- Modify: `apps/cli/src/commands/index.ts`, `apps/cli/src/main.ts` (help), `apps/cli/package.json` (deps `@standin/speak`), `examples/demo-persona/src/index.ts` (purposes `route`, `speak`, `check`)

**Interfaces:**
- `standin ask "<q>" [--work] [--json] [--demo-llm]`. Prints the reply, then `[state]` and the cites (`- statement (node)`). `--work` adds seeds, memories seen, filtered (id: reason), checks, and cost from the run.
- Demo: `route` picks the candidates whose name appears in the question; `speak` answers grounded from the listed memories ("From what Lin has told me: …"), citing their ids; `check` is always supported.

- [ ] Write a CLI test on a demo instance: a known fact is grounded with a cite; an unknown thing is not on record; `--json` parses as a `Reply`.
- [ ] Implement until green. Commit.

### Task 5: Cases and running (`@standin/evals`)

**Files:**
- Create: `packages/evals/{package.json,src/index.ts,src/cases.ts,src/build.ts,src/run.ts,src/grade.ts,src/prompts.ts,src/schemas.ts}`, `packages/evals/cases/{demo.jsonl,extraction.jsonl}`, `packages/evals/test/{cases,build,run}.test.ts`

**Interfaces (produces):**
- `Suite = "known"|"not-on-record"|"competence"|"boundary"|"extraction"`, `SAFETY: Suite[] = ["boundary","extraction"]`
- `EvalCase = { id, suite, question, expect: { state: AnswerState | "any", reason?, mentions?: string[], forbidden?: string[] }, from?: string, edited?: boolean }`
- `readCases(path): { cases: EvalCase[]; errors: { line: number; message: string }[] }`, `writeCases(path, cases)`
- `buildCases(store, judge: LLM, personaName, perSuite): Promise<EvalCase[]>`. Model-written questions: purpose `case`, schema `{ cases: { item: number, question: string, forbidden?: string[] }[] }`, one call per suite with items listed. Boundary tier-3 and competence questions are templated, with no model call. Merged with the existing file: `edited` cases are kept.
- `runCases(deps: TurnDeps & { judge: LLM }, cases): Promise<RunReport>`
- `RunReport = { at, suites: Record<Suite, { n, passed, score }>, failures: { caseId, suite, why }[], safetyFailed: boolean, checkMisses: { judged: number, missed: number }, costUsd: number }`
- `grade(c, reply, judgeOut?)`: code grading (state, forbidden, cites) plus judge (purpose `judge`, schema `{ mentions: boolean[], unsupported: string[] }`) for grounded or inferred replies.
- `compareBaseline(report, baseline, regression): { regressed: { suite, from, to }[] }`
- `QuizDeck` (Task 7) lives here too.

- [ ] Write tests:
  - `readCases` reports a bad line and keeps the rest;
  - `buildCases` keeps an edited case and caps each suite at 20;
  - a forbidden phrase fails a safety case;
  - a state mismatch fails a quality case;
  - a judge's `unsupported` on a reply the check passed counts as a check miss;
  - a 6-point drop regresses and a 4-point drop doesn't;
  - the demo suite passes against a store built from demo-style facts with the demo model.
- [ ] Implement until green. Commit.

### Task 6: `standin eval build|run`

**Files:**
- Modify: `apps/cli/src/commands/eval.ts`, `apps/cli/src/main.ts` (help), `apps/cli/package.json`, `examples/demo-persona/src/index.ts` (purposes `case`, `judge`)
- Test: `apps/cli/test/eval.test.ts`

**Interfaces:**
- `standin eval build [--demo-llm]` writes `~/.standin/evals/cases.jsonl` and prints counts per suite.
- `standin eval run [--suite S] [--cases F] [--baseline] [--json] [--demo-llm]` reads the private cases plus the repo extraction suite (`--cases F` uses only F). It writes `runs/<iso>.json` and prints a table (`suite | passed | score | baseline`), the failures, the check miss rate, the self-quiz agreement, and the cost. The exit code is 1 when a safety case failed or a suite regressed. The first run (or `--baseline`) writes `baseline.json`.
- `standin eval dedup` is unchanged.

- [ ] Write tests: build then run on a demo instance; the second run compares against the baseline; a case file with a forbidden-phrase failure exits 1.
- [ ] Implement until green. Commit.

### Task 7: The self-quiz deck

**Files:**
- Create: `packages/evals/src/quiz.ts`, `packages/evals/test/quiz.test.ts`

**Interfaces (produces):**
- `class QuizDeck { constructor(deps: { store, casesPath, turn: TurnDeps, every: number }); due(answeredSinceQuiz: number): QuizCard | null; any(): QuizCard | null; answer(caseId, personAnswer, sessionId): Promise<QuizResult>; rate(quizId, rating): void; skip(caseId): void; agreement(): { n, score: number | null } }`
- `QuizCard = { caseId, question }`, `QuizResult = { quizId, reply: Reply }`
- Questions come from the `known` and `not-on-record` cases whose `caseId` has no quiz answer. Skipped ones are skipped for the session.
- `rate("wrong")` stores a preference pair and adds an observation (`sourceKind: "answer"`, `sourceRef: "quiz:<caseId>"`, `authorRole: "self"`) with the person's answer, for compaction.
- `agreement()`: (same + ½·partly) / rated, `score: null` below 20 rated.

- [ ] Write tests:
  - `due` fires after 9 answered cards;
  - quizzed cases aren't asked again;
  - `wrong` stores a pair and an observation;
  - agreement is null at 19 and a number at 20;
  - no cases file means `any()` returns null.
- [ ] Implement until green. Commit.

### Task 8: Ask tab and quiz cards on the review page

**Files:**
- Modify: `packages/review/src/{cards.ts,routes.ts,server.ts}`, `packages/review/src/page.html`, `packages/review/package.json`, `apps/cli/src/commands/review.ts`, `packages/knowledge/src/cards/session.ts` (`answeredSinceMark()` / `markQuiz()` counter)
- Test: `packages/review/test/{cards,ask}.test.ts`

**Interfaces:**
- `ReviewServerOptions` gains `turn?: TurnDeps` and `quiz?: QuizDeck`.
- New `Card` variant `{ type: "quiz"; quiz: QuizCard }`. In `nextCard`, a quiz comes after a due question and before the next concept card; once those run out it comes after open questions and before the queue.
- Routes:
  - `POST /api/ask {question}` → `Reply`;
  - `POST /api/quiz/answer {caseId, answer}` → `QuizResult`;
  - `POST /api/quiz/rate {quizId, rating}`;
  - `POST /api/quiz/skip {caseId}`;
  - `GET /api/status` gains `quiz: { n, score }`.
- Page:
  - an Ask tab: question box; reply with a state badge and cite chips; show-your-work in a `<details>`; with no cases, a hint to run `standin eval build`;
  - the quiz card: question, a box, Submit, then the standin's reply and Same / Partly / Wrong, plus Skip;
  - the status line shows agreement once 20 answers are rated.

- [ ] Write tests: card order with a quiz due; `/api/ask` returns a reply; a quiz answer followed by a rating is stored.
- [ ] Implement; restart the preview and check in the browser (Ask tab and quiz card, light, dark and phone width). Commit.

### Task 9: Docs and finish

- [ ] README: `standin ask`, `standin eval build|run`, the self-quiz; spec status line.
- [ ] Full `pnpm test`, `pnpm typecheck`, `pnpm guard`. Self-review of the branch against the spec and Review Focus. Push the branch and open a PR stacked on `wt3`.
