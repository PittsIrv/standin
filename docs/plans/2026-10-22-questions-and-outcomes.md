# WT-3: Questions and Opt-in Outcomes. Implementation Plan

**Spec:** `docs/specs/2026-10-22-questions-and-outcomes.md` (decisions 81–83).

## Review focus

- A question whose answer has only sensitive statements stays open (nothing saved).
- A server restart between "Read it" and "Looks right" saves nothing and leaves the question open.
- An export never contains a node name, topic, id or time.
- A priors file with an unknown cell or a non-positive count stores nothing.

### Task 1: Store
`questions` table (migration 12), `Question` record, `addQuestion` / `getQuestion` / `listQuestions` / `setQuestionStatus`, `deleteKv`; source kind `answer`.

### Task 2: Asking
`askQuestions(store, map, persona, limits)`: purpose `question`, nodes beyond Knowledge with facts and no open or dismissed question; ≤ 3 new, ≤ 10 open, one per node, `isSensitive` check. A refresh step after homing; config `questions` and `sharing`; the demo asks about projects and pets.

### Task 3: The card
`CardSession.questionDue()` (every 5th card), `anyQuestion()`, `readAnswer`, `answerQuestion` (via `saveIntro` with `homeNodeId`), `skipQuestion`, `dismissQuestion`; card order; routes `/api/question/{read,confirm,skip,dismiss}`; the question card on the page, sharing the confirm screen.

### Task 4: CLI and docs
`standin questions [--sheet]` (the sheet imports with `standin interview import`, which answers the questions); `standin outcomes export [--out F]` (needs `sharing.outcomes`), `standin outcomes priors <file> | --clear`; README.
