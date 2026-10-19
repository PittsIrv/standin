# More Ways In: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution: Claude implements inline (the user's standing choice: no Codex, no subagents).

**Goal:** Five detailed question banks with repeating per-item blocks, plus `standin tell` for direct facts. Everything flows through the normal observation → compaction → review pipeline.

**Architecture:**
- **`@standin/interview`:**
  - `Section` gains an optional `repeat` (a label and a number of copies).
  - The template renders repeating sections as marked blocks.
  - The parser numbers the copies.
  - `answersToObservations` makes one observation per repeated item and one per plain answer.
- **The CLI** adds `tell` and switches `interview import` to the new function.

**Tech Stack:** Node 24, TypeScript (strict), zod v4, vitest.

**Spec:** `docs/specs/2026-10-19-more-ways-in.md`.

## Global Constraints

- **The repeat marker:** each copy of a repeating block starts with the line `<!-- repeat: <section id> -->`.
  - Inside it, headings are `### <section>.<field>`.
  - The parser renames them `<section>.<n>.<field>`, where `n` is 1-based and counts markers of that section in order.
  - A block ends at the next `## ` heading or the next repeat marker.
- **The template** renders **3** copies of each repeating block. Its intro says: "To add another project (or skill, course…), copy a whole block, including its `<!-- repeat -->` line."
- **One observation per repeated item.** For example, `sourceRef: interview:projects-v1#projects.2` and text:
  ```
  Project 2 (Kite):

  Q: What's the project called, and what is it in one sentence?
  A: Kite, a Go-variant engine.

  Q: …
  A: …
  ```
  - The label is the section's `repeat.label` and `n`.
  - The parenthesized name is the first line of the item's first answered question, truncated to 60 characters, and omitted if that question is blank.
  - Blank questions are left out. A fully blank item produces nothing.
  - `meta`: `{ bank, item: "<section>.<n>", questionIds: [...] }`.
- **Plain questions** keep today's format, one observation each: `Q: …\n\nA: …`, with `sourceRef interview:<bank>#<id>`.
- **English check:** `interview import` applies the English-only check to every answer before writing anything (as today).
- **`standin tell`:**
  - `standin tell "<text>"`, `standin tell --file F`, or text on stdin.
  - Creates an observation with `sourceKind: manual`, `authorRole: self`, `sourceRef: tell:<ISO timestamp>`, and `occurredAt` = now (or `--occurred`).
  - Prints the id and "Next: standin compact".
- **Wording:** the bank wording below is approved. Copy it exactly.
- **Commits:** Mingxi is the author. Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

### Approved bank wording

Each bank is `{ id, sections }`. In the lists below:
- **(repeat "Label")** marks a repeating section;
- `feeds` follows each question in brackets;
- hints are in italics.

**`projects-v1`**
- Section `projects`, titled "Projects" (repeat "Project"):
  - `name`: What's the project called, and what is it in one sentence? [fact]
  - `role`: What was your role, and who else was involved? *Roles are enough; don't name private individuals.* [fact]
  - `when`: When did you work on it, and is it finished, ongoing, or abandoned? [fact, current]
  - `stack`: What did you build it with (languages, tools, models)? [competence]
  - `hardest`: What was the hardest problem, and how did you solve it? [competence, voice]
  - `outcome`: How did it turn out? Users, results, what you're proud of. [fact]
  - `differently`: What would you do differently now? [stance, voice]
  - `link`: Is there a public link (repo, demo, write-up)? *Only links you'd put on your website.* [fact]
- Section `next`, titled "Next":
  - `next.build`: What do you want to build next? [current]

**`skills-v1`**
- Section `skills`, titled "Skills" (repeat "Skill"):
  - `name`: Which skill, tool, or area? [competence]
  - `depth`: How deep, 0–4? *0 don't know · 1 aware of it · 2 working knowledge · 3 strong · 4 expert* [competence]
  - `where`: Where have you used it? Name a project, course, or job. [fact, competence]
  - `cant`: What can't you do with it yet, or which parts haven't you touched? [negative]
- Section `learning`, titled "Learning":
  - `learning.now`: What are you learning right now? [current]

**`education-v1`**
- Section `program`, titled "Program":
  - `program.current`: Which program are you in (or did you finish), at which school, and what year? [fact]
- Section `courses`, titled "Courses" (repeat "Course"):
  - `name`: Which course? [fact]
  - `covered`: What did it cover? [competence]
  - `depth`: How deep did you go? Did you just pass, or could you teach parts of it? [competence]
  - `built`: Anything you built or wrote for it? [fact, competence]
- Section `beyond`, titled "Beyond classes":
  - `beyond.self`: What did you learn outside of classes (research, clubs, self-study)? [competence]

**`opinions-v1`**
- Section `work`, titled "How you work":
  - `work.style`: How do you like to work: alone or in a team, fast or careful, mornings or nights? [stance, voice]
  - `work.collaborator`: What makes a collaborator great to work with, for you? [stance]
- Section `opinions`, titled "Opinions" (repeat "Opinion"):
  - `claim`: A strong opinion you hold in your field. [stance]
  - `why`: Why do you think so? [stance, voice]
  - `strength`: How strongly (1–5), and what would change your mind? [stance]
- Section `contrarian`, titled "Against the grain":
  - `contrarian.disagree`: What do you disagree with most people in your field about? [stance]
  - `contrarian.changed`: What's an opinion you've changed your mind on? [stance, voice]

**`life-v1`**
- Section `fun`, titled "For fun":
  - `fun.hobbies`: What do you do for fun? [fact]
- Section `interests`, titled "Interests" (repeat "Interest"):
  - `name`: An interest or hobby. [fact]
  - `depth`: How long have you been into it, and how deep? [fact]
  - `now`: Anything in it you're into right now (reading, playing, watching)? [current]
- Section `share`, titled "To share":
  - `share.recommend`: What would you recommend to a friend right now (a book, game, place)? [stance, current]
  - `share.fact`: A fun fact about you that you're happy to share. [fact]

In repeating sections, question ids are written as `<section>.<field>` (e.g. `projects.name`) in the bank. The parser adds the number.

## Review Focus

1. **A person copies a block but forgets the repeat marker,** so the same `### projects.role` appears twice in one block. That is an `AnswerSheetError` naming the heading. It must not silently merge or drop either answer. Tested in Task 1.
2. **A person deletes the two unused copies, or fills only copy 3.** Numbering follows the markers actually present, so a lone copy is item 1. Blank items create nothing. Tested in Task 1.
3. **Re-importing the same filled sheet** adds nothing: every item and answer is "unchanged". Editing one answer of an item re-imports only that item. Tested in Task 4.
4. **`core-v1` sheets written before this change** (no repeat markers) import exactly as before. Tested in Task 2.
5. **`standin tell` with an empty string, with nothing on stdin, or with Chinese text** fails with a clear message and writes nothing. Tested in Task 4.

---

### Task 0: Branch setup

- [ ] Branch `more-ways-in` from `main` (PR #4 merged).
- [ ] `pnpm typecheck && pnpm test` is green.

### Task 1: Repeating sections in banks, template and parser

**Files:** modify `packages/interview/src/{bank.ts,template.ts,parse.ts}`; test in `packages/interview/test/repeat.test.ts`.

**Produces:**
```ts
export interface Section { id: string; title: string; questions: Question[]; repeat?: { label: string; copies: number } }
export interface Answer {
  questionId: string; question: Question | null; writtenQuestion: string; answer: string;
  /** Set for answers inside a repeating block: which section and which copy (1-based). */
  item: { section: string; index: number } | null;
}
// renderTemplate(bank): repeating sections render `repeat.copies` blocks, each starting with the repeat marker
// parseAnswerSheet: numbers ids inside repeat blocks; looks questions up by the unnumbered id
```

**Steps:**
- [ ] Write the failing tests, using a two-section test bank (one plain section, one with `repeat: { label: "Project", copies: 3 }`):
  - **The template** has 3 markers and 3 copies of each heading, plus the copy-a-block instruction.
  - **Numbering:** filling copies 1 and 3 gives answers `projects.1.name`, `projects.3.role` and so on. Each has `item` set, and `question` points at the bank's `projects.name`.
  - **Review Focus 2:** after deleting copies 1–2 and filling the remaining one, its answers are `projects.1.*`. All-blank copies produce no answers.
  - **Review Focus 1:** a duplicate heading inside one block throws an `AnswerSheetError` naming `projects.role`.
  - **Plain sections** still parse with `item: null`.
- [ ] Implement:
  - The parser turns each repeat marker into a sentinel line before comments are stripped.
  - Duplicate-id detection runs on the numbered ids.
- [ ] Run the tests; they pass, along with the existing interview tests. Commit "Support repeating blocks in question banks".

### Task 2: One observation per repeated item

**Files:** modify `packages/interview/src/{observation.ts,index.ts}`; test in `packages/interview/test/repeat.test.ts`.

**Produces:**
```ts
export function answersToObservations(answers: Answer[], bank: QuestionBank | null, opts: { bankId: string | null; occurredAt: string }): { key: string; input: ObservationInput }[];
// key: the plain question id, or "<section>.<n>" for an item. answerToObservation stays for plain answers.
```

**Steps:**
- [ ] Write the failing tests:
  - **Item observations:** a filled item with name "Kite, a Go-variant engine." and role gives exactly the text in Global Constraints (`Project 2 (Kite, a Go-variant engine.):` …), the `sourceRef` and the meta.
  - **No collisions:** two items with the same stack answer produce two different observations.
  - **Plain answers** come out exactly as `answerToObservation` produces them.
  - **Review Focus 4:** a `core-v1` sheet gives the same inputs as before this change.
- [ ] Implement. Commit "Turn each repeated item into one observation".

### Task 3: The five banks

**Files:** create `packages/interview/src/banks/{projects.ts,skills.ts,education.ts,opinions.ts,life.ts}`; register them in `BANKS` (`bank.ts`); test in `packages/interview/test/banks.test.ts`.

**Steps:**
- [ ] Write the failing tests:
  - **Registration:** `BANKS` has `core-v1` plus the five ids.
  - **Ids:** every question id is unique within its bank and starts with its section id. Each repeating section has `copies: 3` and a label.
  - **Feeds:** every question has at least one feed.
  - **Wording:** spot-check exact wording, e.g. the `skills.depth` hint text, and `projects.role`'s privacy hint.
  - **Round trip:** each bank's template parses back with no answers.
- [ ] Implement the five banks with the approved wording. Commit "Add five detailed question banks".

### Task 4: CLI `tell` and item-aware import; docs

**Files:** create `apps/cli/src/commands/tell.ts`; modify `commands/{interview.ts,index.ts}` and `main.ts` (USAGE); tests in `apps/cli/test/more-ways-in.test.ts`; `README.md`.

**USAGE:**
```
  tell "<text>" | --file F [--occurred ISO]      tell the standin something directly (goes through compaction and review)
  interview template [--bank B] [--out F | --stdout]   banks: core-v1, projects-v1, skills-v1, education-v1, opinions-v1, life-v1
```
- **`interview import`** uses `answersToObservations`. Its report rows are per key, with the `questionId` field renamed to `key`, and the JSON output follows. The `blank` count stays per question.

**Steps:**
- [ ] Write the failing tests:
  - **`tell`:** `tell "I ran my first marathon in 2024."` creates a manual, self-authored observation with a `tell:` sourceRef. Compacting with a scripted model yields a proposed memory.
  - **Review Focus 5:** `tell ""`, `tell` with empty stdin, and `tell` with Chinese text each exit 1 with a clear message and write nothing.
  - **Projects round trip:** `interview template --bank projects-v1 --out F`, fill two projects, `import` → 2 item observations plus `next.build`. Re-importing gives all unchanged.
  - **Review Focus 3:** editing one project's answer and re-importing adds exactly 1.
  - **Unknown banks:** `--bank nope` lists all six banks.
- [ ] Implement. README: in "Start with an interview", add the five banks and `standin tell`. Run `pnpm typecheck && pnpm test && pnpm guard`, all green. Do a manual smoke test with a temp `STANDIN_HOME`. Commit "Add standin tell and import detailed banks item by item".

### Task 5: Finish

- [ ] Self-review the branch diff against the spec and the Review Focus.
- [ ] Push `more-ways-in` and open a PR titled "More ways in: detailed question banks and standin tell". The body covers what changed and the test plan, and ends with the Claude Code line. Merging needs Mingxi's OK.
