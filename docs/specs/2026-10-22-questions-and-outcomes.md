# WT-3: Questions About Your Life, and Opt-in Outcomes

**Status:** design approved in conversation (decisions 81–83). **Builds on** world-tree §6.1 and §7, and the review page (decisions 76–78).

## 1. Questions

Knowledge is learned through concept cards. The other five trees (Work, Background, People, Views, Life) grow from facts, and facts leave gaps: "two cats, but no names", "a project with no outcome". The standin asks about those gaps. It never guesses the answer.

- **Where they come from.** A refresh step after homing (purpose `question`, the `map` model) looks at nodes in the five trees that hold approved facts, and proposes short questions to the person, one per node at most, about what a standin would need to talk as them.
- **What is never asked.** Anything in a sensitive category (health, religion, sexuality, gender identity, politics, ethnicity or race, immigration status, finances, criminal history, trade-union membership), and contact details, addresses or credentials. Prompt rules, plus the same deterministic check as hypotheses.
- **Never facts.** An open question is never shown to visitors, never used by the speaker, never treated as a fact.
- **Limits.** At most **3** new questions per refresh and **10** open at once; at most **1** open question per node; a node whose question was dismissed gets no new ones.

## 2. Asking (decisions 81, 82)

- **Every 5th card** (decision 82). After every 4 knowledge cards, the next card is an open question if there is one. When the knowledge cards run out, open questions come before the approval queue. A reload shows the same question.
- **Answering is like the introduction** (decision 81). The question card has a box. "Read it" turns the answer into statements, each with the exact words it rests on, checked in code, and the person confirms, edits or removes them on the same card. Confirmed statements are stored as facts at once, homed on the question's node, with the answer kept as their source (source kind `answer`, its reference the question). The question is then answered.
- **Not now** skips it for this session. **Don't ask this** dismisses it for good.
- **`standin questions`** lists open questions; `--sheet` prints them as a Markdown interview sheet, grouped by node, to answer offline and bring back with `standin interview import`.

## 3. Outcomes, opt in (decision 83)

As world-tree §7, with these settled:

- **`sharing.outcomes`** in the config is off by default. **`standin outcomes export [--out F]`** refuses until it is on, and says how to turn it on.
- **The record**, one per settled guess: `{ evidenceKind, rawScore, hops, startDepth, hypothesizedDepth, outcome }`. `hops` is the length of the guess's path; `startDepth` is the level the path starts from (the person's stated or lit level there, or null); `outcome` is `confirmed` or `refuted`. No names, topics, ids or times. It is written to a local file (default `standin-outcomes.json`) for the person to look at; nothing is sent.
- **`standin outcomes priors <file>`** loads a default-reliability file `{ "<kind>:<rawScore>": { "a": n, "b": n } }`; each cell is scaled down so `a + b` is at most `hypotheses.priorCap` (**10**). `--clear` removes it.

## 4. Decisions log

| # | Decision | Choice | Rejected |
|---|---|---|---|
| 81 | Answering a question | Like the introduction: read into quote-checked statements, confirmed on the card, saved at once | Through the extraction pipeline and approval queue |
| 82 | Where questions appear | Every 5th card; before the queue when knowledge runs out | After knowledge, before new areas; only at the end |
| 83 | Outcome export | Off by default; export refuses until `sharing.outcomes` is on; local file only | Export without consent; sending anywhere |

## 5. Numbers

| Number | Value |
|---|---|
| New questions per refresh | 3 |
| Open questions | 10 |
| Open questions per node | 1 |
| Question cadence | every 5th card |
| Prior weight per cell | `a + b` ≤ 10 |
