# Concept Cards

**Status:** design, approved in conversation (decisions 56–68)

**Replaces** probing by quiz. This covers:
- knowledge-map §4.1–§4.8 (probes, claim checks, misses, follow-ups, spot-checks, held-out sets);
- knowledge-map §6 (calibration);
- world-tree §4.3 and §5.2–§5.3 (outcomes, probe choice, the Brier safeguard).

Everything else in those specs stands: the world tree, lighting, guesses and their guards, reliability counts, boundaries, the answering rule, and the review page and forest.

## 1. Why

The standin represents the person as they want to be represented (knowledge-map decision 1). Quizzes made them prove what they know: slow, tiring, and beside the point. Instead, the person *tells* the standin about concepts, one click each. The tree tells them where to go deeper.

There is no honesty check, by design. The person's word is what the standin uses.

## 2. The card

A card shows one Knowledge concept: its name, its one-line definition, **what it includes**, and its place in the tree. "Includes" lists the concept's examples; a concept without stored examples (an older split, or a node placed from a memory) lists up to 5 of its parts instead. A guess also shows why it was guessed. The answer is one click or key:

| Key | Answer | Lights the concept and its branch at |
|---|---|---|
| `4` | Expert | 4 |
| `3` | Know well | 3 |
| `2` | Used it | 2 |
| `1` | Heard of it | 1 |
| `0` | No | 0 (dark) |
| `w` | Wouldn't say | a tier-3 boundary on the branch (unchanged from §3.5) |
| `s` | That's enough here | no parts of this concept are asked about |

- **The answer is the person's own word.** It lights the node directly, with basis `stated` (shown as "you said 3"). A later answer on the same node replaces an earlier one.
- **The prediction comes first.** Before the card is shown, the standin's prediction for the node is recorded: its answer mode, and for a guessed node its probability.

## 3. Going deeper

- **Expert and No settle the branch.** No part of it is asked about.
- **Know well, Used it and Heard of it** ask about the concept's parts, but only parts whose own **level** is at most the answer plus one. For example, "Heard of it" on RL asks about rewards, policies and exploration, and never about async RL.
- **When to stop.** Nothing below the concept is asked about when:
  - fewer than **2** parts qualify; or
  - the person pressed "That's enough here".

  In either case the answer stays on the node. Parts nobody asked about stay hidden on the frontier and inherit the node's level.
- **Recursion.** Each part answered at a middle level goes deeper the same way.
- **Claims.** A claim at a middle level (1–3) starts the same walk over its parts. The claimed concept itself is never asked again.

## 4. Order and length

A session shows, first match wins:

1. a **keep or lower** card (§5) that is due;
2. the **guesses**, least sure first (`|P − 0.5|`, then name);
3. **parts** waiting from §3, depth-first, so a concept's parts come before moving on;
4. **new areas**: top-level Knowledge nodes, and seeded fields, that have no answer, claim or guess;
5. the review queue;
6. done.

A session runs until nothing is left. The person can finish at any time.

## 5. Keep or lower

When the person rates a part of a claimed concept *below* the claim, they get one card once that claim's qualifying parts are all answered:
- **Keep:** the claim stands. The lower parts are already carved out, because their own answers win over inheritance.
- **Lower:** the claim drops to the lowest level given to a part (as before), as the person's own decision.

It is asked once per claim. A later lower answer under the same claim asks again.

## 6. Splits

The quality of the cards is the quality of the splits.

- **On demand, once.** The `map` role splits a concept the first time §3 needs its parts. The split is stored, reused and never regenerated.
- **Strict shape.** A split has:
  - **3–7 parts** that don't overlap and together cover the concept;
  - each part with a one-line definition, a **level** (1 basic to 4 expert), and **3–5 examples**: the concrete things it covers;
  - prerequisites where they matter.
- **Names say what, not how hard.** A part is named by its content ("Network flow and matching"), never by its difficulty or as a bucket ("Advanced algorithms", "Algorithm fundamentals", "Other topics"). The level carries difficulty.
- **Checked in code.** The checks are the part count, duplicate names, missing or out-of-range levels, a part equal to (or an alias of) its parent, a name with a level or bucket word (advanced, basic, fundamentals, foundations, introduction, elementary, intermediate, beginner, other, miscellaneous, general), and fewer than 3 distinct examples (beyond 5 are cut). A split that fails gets one retry, then is used as far as it is valid.
- **The person's edits win.** Renames, moves, deletions and added children in the forest editor are never undone by a split.
- **Later, as their own sub-projects:** anchoring top levels on standard taxonomies (ACM CCS, CS2023, MSC), and a shared, privacy-free concept library.

## 6a. The introduction

The standin asks well only once it knows where to look. So before the first card, it asks for a short introduction.

- **When.** The session opens with the introduction when nothing tells the standin about the person's background yet: no approved background fact and no seeded field. "Skip for now" goes straight to the cards. "Add to your introduction" stays on the Session tab, any time.
- **One box.** "Introduce yourself in a few sentences: what you study or work on, and what you've done before." Up to 4,000 characters.
- **Read, then confirm.** The `map` role reads the text into short statements (up to 12): education, roles, current work, things built, skills and interests. Sensitive categories are never read out, and statements that touch one are dropped in code. The person sees the statements on the same screen, edits or removes any, and approves them with "Looks right". Nothing is stored before that: the text then becomes an observation, and each statement an approved background fact.
- **Into the tree as guesses.** Each confirmed statement seeds a field (or nothing, for a statement with no field of knowledge, such as having two cats) and the concepts it implies. Every one is a **guess**, never lighting: the first cards confirm them, one click each. The model picks each guess's **depth (1–4)** from what the statement says (current research → 3, a past course → 2, mentioned in passing → 1), with a one-line reason shown on the card. Evidence kind is `background` for education and `work` for work, so reliability counts calibrate each separately.
- **Direction.** New areas (§4 step 4) start with seeded fields, then the rest by name.

## 7. Learning and scoring: predict, then learn

- **A guess's outcome.** It is confirmed when the answer's level is at or above the guessed depth, and refuted below it. "Wouldn't say" withdraws it.
- **Reliability counts** (world-tree §5.1) are unchanged, but count every card answer. There are no held-out sets.
- **Scoring.** Every answer is scored against the prediction recorded before it was shown, then learned from (prequential evaluation).
  - **Map score:** the standin's answer mode ("would answer" = brief or explain) against the person's level (≥ 2).
  - **Guess Brier score:** the stored calibrated probability against the prior-only one. The safeguard (world-tree §5.3) uses this, over the last `brierWindow` guess answers.

## 8. Removed

- quizzes, and the `quiz` role;
- spot-checks, and the `grade` role;
- held-out sets and their release;
- misses and judging them;
- follow-ups, and claim checks by quiz;
- fixed session sizes.

Old probe rows stay readable, but nothing new is written in their style.

## 9. Decisions log

Continues from world-tree decision 55.

| # | Decision | Choice | Rejected |
|---|---|---|---|
| 56 | How probing works | Concept cards: the person rates a concept, and the tree decides where to go deeper | Quizzes with spot-checks |
| 57 | Honesty | None: the standin represents the person as they want | Spot-checks and grading |
| 58 | Card answers | Expert / Know well / Used it / Heard of it / No, plus Wouldn't say | Mastered / Partly / No; Know / Partly / No |
| 59 | Going deeper | Expert and No settle the branch. Middle answers ask parts up to one level above. Stop under 2 qualifying parts or on "That's enough here". Unasked parts stay on the frontier | A Partly button that always splits |
| 60 | Scoring | Predict, then learn, on every answer | Fixed and rotating held-out sets |
| 61 | Card order | Keep or lower, guesses (least sure first), parts, new areas; claims never re-asked | A top-down survey; only where the person chooses |
| 62 | Session length | Until nothing is left | A fixed size |
| 63 | Keep or lower | Kept, for parts rated below a claim; lower = the lowest part level | Dropping it |
| 64 | Splits | The model on demand, in a strict shape checked in code, cached, with the person's edits winning | Taxonomy anchors now; a shared library now |
| 65 | Concrete parts | 3–5 examples per part, shown as "Includes"; names by content, with level and bucket words refused in code | Examples only; listing the sibling parts |
| 66 | Background first | A short introduction before the first card when no background is known; skippable, extendable later | Background only through the approval queue |
| 67 | What the introduction becomes | Confirmed statements → background facts → guesses that the first cards confirm | Claims at a level read from wording; direction only |
| 68 | Introduction trust and depth | Statements confirmed on the same screen; the model picks each guess's depth 1–4, with a reason | Automatic approval; the approval queue; always depth 2 |
