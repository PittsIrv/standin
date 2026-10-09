# SP2a: Knowledge map and local review page

Status: decisions approved in conversation on 2026-10-07 (logged in §11). Awaiting written-spec review.
Builds on: [architecture spec](2026-10-01-standin-architecture.md) §5 (memory model) and §7 (competence-gated knowledge), and the [model-routing spec](2026-10-03-model-routing.md) (roles, traces).

## 1. Goal

The standin should know what the person knows, to the depth they know it, and say "I don't know" everywhere else, even when the underlying model knows the answer. This spec turns "what the person knows" from a guess into a **measured, reviewable map**:

- **Topics** organized two ways: a tree (broad → narrow) and prerequisite links (advanced → foundations).
- **A depth (0–4) per topic**, combined cautiously from evidence, self-report, and probes, with every change proposed to the person.
- **Probes**: short questions the person rates quickly, with occasional spot-checks a judge grades.
- **An answering rule** that turns depth into what the standin may say.
- **A calibration score**: how often the standin's "I'd answer / I'd decline" matches the person's own ratings on held-out probes.
- **`standin review`**: a local web page for probes, memory approvals, and depth changes. SP2b (scanners, the `screen` role, publishing) builds on the same page.

Why all three signals are needed:

- **Background overstates.** A degree doesn't mean every subfield, and being in a channel isn't understanding it.
- **Self-report is biased.** People under-claim what feels easy and over-claim what they once skimmed. Nobody can list everything they don't know.
- **The base model knows almost everything.** So the default is deny: the standin uses general knowledge only where there is evidence the person would know it.

## 2. Topics

A topic is an entity of kind `topic`. English and Chinese names merge as aliases through the existing alias mechanism. Topics are connected by two kinds of edges with opposite meanings:

| Edge | Meaning | Example | What depth does along it |
|---|---|---|---|
| `parent` (specialization) | narrow → broad | RLHF → reinforcement learning → ML | Flows **up**, discounted (§3.4). Never flows down: knowing ML says nothing about CUDA kernels. |
| `requires` (prerequisite) | advanced → foundation | RLHF requires reinforcement learning and probability; game-theory-optimal poker requires game theory | **Predicts** the foundations (§3.5). |

- Topics come from compaction: each competence memory names a topic.
- A new role, **`map`** (medium tier, private zone), proposes three kinds of change: merges ("RL" = "reinforcement learning" = "强化学习"), parent links, and prerequisite links. Each proposal goes to the review queue. Nothing joins the map unreviewed.
- Cycles are rejected in both edge types.

## 3. Depth

### 3.1 Scale

| Depth | Meaning |
|---|---|
| 0 | doesn't know (a recorded gap) |
| 1 | aware of it |
| 2 | working knowledge |
| 3 | strong |
| 4 | expert |

### 3.2 What a depth estimate carries

Each topic's estimate records:

- **`depth`**: 0–4.
- **`basis`**: the strongest support it has. In order: `probed`, then `evidence`, then `predicted`, then `claimed`.
- **`confidence`**: `high` (probed or evidence), `medium` (predicted from an established topic), or `low` (claimed, or predicted from a claim).
- **`reasons`**: human-readable lines, e.g. "missed 3 of 4 spot-checks at difficulty 3".

### 3.3 Combining the signals

The signals are applied in this order:

1. **Claimed.** The self-reported depth from the interview or a check-in, capped at **2** until something corroborates it.
2. **Evidence floor.** One project or piece of writing the person authored in the topic (or a descendant topic) sets a floor of 2. Three or more, or in-depth writing, set a floor of 3.
3. **Probes.** These replace the estimate within what they cover. The probed depth is the highest difficulty `d` where both of these hold:
   - at least 70% of ratings at level `d` or above are "know it";
   - at least 70% of spot-checks at those levels pass, if there were any.

   Depth 4 also requires at least two passed spot-checks at difficulty 4.

   Probes can pull an estimate **below** the claim or the evidence floor. In that case the reason line says so, and the person decides in review.
4. **Monotonic difficulty.** A "know it" or a passed spot-check at difficulty `d` counts as support at every lower level. Passing a hard probe implies the easier ones.

### 3.4 Upward flow (specialization)

A parent's floor is `min(child depth − 1, 3)`, taking the maximum over its children, with `basis: predicted`. Being an expert in RLHF implies at least strong (3) in reinforcement learning, and at least working knowledge (2) of ML.

### 3.5 Prerequisite prediction (foundations)

When an advanced topic `T` has depth `d`, each topic `P` that `T` requires gets a predicted floor:

| `T`'s basis | Floor for each prerequisite `P` | Confidence |
|---|---|---|
| `probed` or `evidence` (established) | `min(d − 1, 3)` | medium |
| `claimed` | `min(claimed depth − 1, 2)` | low |

For example, an established expert in RLHF is predicted strong (3) in reinforcement learning and probability without being asked. Someone who only *claims* expert RLHF is predicted working knowledge (2) in those foundations until the claim is backed.

Prediction applies transitively along `requires` edges, losing one level per hop. A predicted floor never overrides a probed result.

### 3.6 Proposals, not writes

When an estimate differs from the approved competence memory, the map **proposes** an update: a new competence memory that supersedes the old one, carrying the estimate's reasons. It enters the review queue like any other memory. Approved depth is what the runtime uses. Version history and as-of queries come for free from the memory store.

### 3.7 "Wouldn't say"

The rating "wouldn't say" is **not** a knowledge signal and never lowers depth. Instead, the queue suggests setting that topic's tier to 3 (deflect). Declining to answer is a boundary, not a gap.

## 4. Probes

### 4.1 Probe and response

- **A probe** has a topic, a question, a difficulty (1–4), a language, and a flag marking it as held out.
- **A response** has:
  - a rating: `know`, `roughly`, `no_idea`, or `wouldnt_say`;
  - optionally, a spot-check answer (one line) with the judge's grade (`pass` or `fail`, plus a reason);
  - the time it was answered.

### 4.2 Writing probes

- The `quiz` role (medium) writes probes for a topic at all four difficulties, in the language the person uses for that topic.
- Probes test understanding, not trivia. The prompt asks for "would someone at this level be able to explain or do X", not for dates or names.
- Probes are stored and reused across sessions.

### 4.3 Choosing probes (adaptive)

**Volume:** the first round is 60 probes, then 10 per weekly check-in.

**Order within a topic**, like a placement test:

1. Start at the current estimate's level, or at level 3 when there is no estimate.
2. Step up after a "know it", down after a "no idea".
3. Stop when the level is pinned, i.e. adjacent levels disagree.

**Priority across topics**, highest first:

1. Topics with low confidence: claimed, or predicted from a claim.
2. Topics where the signals disagree.
3. Predicted prerequisites, confirmed with a single probe at the predicted level.
4. The frontier: topics adjacent to strong topics.

### 4.4 Spot-checks

- About one in five `know` or `roughly` ratings asks for a one-line answer.
- The `judge` role (large) grades spot-checks through the batch API. Nobody waits on the grade.
- Spot-check answers in the person's words also become voice samples (exemplars) and eval cases with known answers. Both go through the normal review queue.

### 4.5 Held out for calibration

Twenty percent of probes are **held out**:

- They never feed depth.
- They are the calibration set: the standin's `answerMode` (§5) for the probe's topic is compared with the person's rating.
- The **calibration score** is the share of held-out probes where "would answer" (explain, or brief and hedged) matches `know` / `roughly`, and "would decline" matches `no_idea`. `wouldnt_say` is excluded.
- It is reported by `standin eval` (SP3) and on `/how-it-works`, next to the self-quiz test-retest score.

## 5. Answering rule

`answerMode(estimate)` is shared core code, so evals can test it now. The SP4 runtime uses it through the `competence(topic)` tool.

| Approved depth | Mode | What the standin does | Badge |
|---|---|---|---|
| 3–4 | `explain` | Explains using general knowledge, at the person's level, in their voice | inferred |
| 2 | `brief` | Short answer that states its confidence ("I've used it, not deeply") | inferred |
| 0–1, or no topic matched | `decline` | Declines in the person's words, then points to the nearest topic they do know | not on record |

Rules that apply in every mode:

- Facts about the person come only from approved memories, with citations (`grounded`).
- Depth predicted with **low** confidence counts as one level lower when choosing the mode.

## 6. The `standin review` page

**Server**
- `node:http`, plain TypeScript and HTML, no front-end framework and no build step.
- It serves one page and a small JSON API backed by the store.

**Cards**
- probes, with a text box that expands for spot-checks;
- proposed memories, including depth changes with their reasons;
- proposed map edits: merges, parent links, prerequisite links.

The memory review queue (weekly cap, ranking by importance) is the same one the CLI shows.

**Keys**
- `1`–`4` rate a probe.
- `a` / `r` approve or reject.
- `e` edits a statement before approving.

**Security**
- Binds to `127.0.0.1` by default.
- Every request needs a random session token. The token is printed in the URL, and requests without it are rejected, so other pages in the browser can't call the API.
- `--lan` binds to the local network for phone access and prints a QR code containing the token. It is opt-in, because the page shows private data.
- No data leaves the machine except the model calls made by the `quiz`, `map`, and `judge` roles.

**Tracing**: each review session is a trace of kind `review`. Grading and probe writing appear as model-call spans.

## 7. Data model changes

- A migration adds three tables:
  - `topic_edges (from_topic, to_topic, kind: parent|requires, status, created_at)`, with proposed and approved edges;
  - `probes`;
  - `probe_responses`.
- Competence memories reference a topic entity, so `attrs.domain` resolves to a topic id at compaction time.
- A depth estimate is computed, not stored. It is a pure function of the competence memories, map edges, and probe responses. Only the resulting proposals are stored, as memories.

## 8. Errors and testing

**Errors**
- **No topic matched** for a question: `decline` (deny by default).
- **Judge or `quiz` model failure:** the probe or grade stays pending and is retried next session. It never blocks rating.
- **A cycle in the edges:** the proposal is rejected with the cycle path.
- **Page without its token:** 403.

**Tests**
- Depth rules, table-driven:
  - the claim cap;
  - evidence floors;
  - the probe level, including monotonic difficulty;
  - the depth-4 spot-check requirement;
  - probes overriding claims.
- Upward flow and prerequisite prediction: established vs claimed, transitive with decay, never overriding probes.
- Probe selection: adaptive steps, priority order, held-out share.
- Calibration score on the demo persona with scripted ratings.
- `answerMode`, including low-confidence demotion.
- Page:
  - tokenless requests rejected;
  - bound to localhost only unless `--lan`;
  - rate, approve, and reject end to end against a temp instance.

## 9. Phase 2: a learned knowledge predictor

The rules in §3 work from day one with no data, and every change carries a readable reason. They also generate labeled data: each probe response is an example of "this person, this item → know / roughly / no idea". Phase 2 trains a predictor on that data and swaps it in **only if it beats the rules** on the held-out probes.

**Target.** `P(rating ∈ {know, roughly})` for a probe. `wouldnt_say` is excluded.

**Features.**
- The probe text, as an embedding.
- Its stated difficulty, plus a difficulty predicted from the text.
- Its topic's depth signals: claim, evidence floor, probe history.
- Graph features: depths of ancestors, descendants, and prerequisites.

**Models**, kept small and interpretable because there is one person and a few hundred items:
1. **Bayesian IRT.** An ability per topic, with hierarchical priors that flow along `parent` and `requires` edges; item difficulty from text.
2. **Logistic regression** on the same features.

**Baselines.**
- The §3 rules.
- An LLM shown the approved map and asked to predict the rating (the "digital twin" approach).

**Evaluation**, on the held-out probes (§4.5), never on training probes:
- AUC
- Brier score
- Expected calibration error, with a reliability diagram

**Swap-in rule.** The predictor replaces the rules for the `answerMode` threshold only if it beats them on Brier score and does not do worse at catching "no idea" items (recall on declines).

**When.** After about 200 non-held-out responses. Until then, Phase 1 stores everything Phase 2 needs. The probe text, difficulty, topic, rating, spot-check grade, and timestamp are already in the data model. No extra logging is required.

**Probe choice.** Once the predictor exists, it also picks probes. Each weekly batch favors the items it is least sure about (active learning), so ten probes teach it as much as possible.

**Showcase.** A `/how-it-works` chart compares the rules, the learned model, and the LLM baseline on the person's own held-out probes, with the reliability diagram.

### Related work

The problem sits between four areas. We did not find work that models **one real person's knowledge boundary** from a few of their answers plus language-model priors, in order to decide what an agent speaking as them may say. That gap is the framing for `/how-it-works`, to be re-checked before publishing.

| Area | Work | What it models | What standin borrows |
|---|---|---|---|
| Psychometrics | Item response theory (Rasch; Lord); computerized adaptive testing | P(correct) from ability and item difficulty | Adaptive probing (§4.3); the Phase-2 IRT model |
| Knowledge tracing | Bayesian KT (Corbett & Anderson 1995); Deep KT (Piech et al. 2015); cognitive diagnosis (NeuralCD, Wang et al. 2020); LLM-based KT: LKT, NTKT ([arXiv 2511.02599](https://arxiv.org/abs/2511.02599)); LLM difficulty prediction, DCL4KT+LLM ([arXiv 2312.11890](https://arxiv.org/abs/2312.11890)) | A learner's mastery over time; text helps cold-start items | Text-based item features for a learner with few answers |
| Digital twins | Park et al. 2024 (1,000-people interviews); Twin-2K-500 (Toubia et al., *Marketing Science* 2025, [arXiv 2505.17479](https://arxiv.org/abs/2505.17479)) | One person's held-out answers predicted from their interview, mostly attitudes and behavior | The LLM baseline; the test-retest comparison |
| Model self-knowledge and role-play | P(IK), Kadavath et al. 2022 ([arXiv 2207.05221](https://arxiv.org/abs/2207.05221)); TimeChara, Ahn et al., ACL Findings 2024 ([arXiv 2405.18027](https://arxiv.org/abs/2405.18027)) | Whether a model knows an answer; role-play characters showing knowledge they shouldn't have | The same question asked of a person; "character hallucination" as the failure mode the calibration score measures |

## 10. Out of scope

- Scanners, the `screen` role, publishing, rollback: SP2b.
- The runtime `competence` tool and badges in the public widget: SP4.
- Full eval suites beyond the calibration score: SP3.
- Building the Phase-2 predictor (§9). Phase 1 only has to store the data it needs, which it already does.

## 11. Decisions log

| # | Decision | Choice | Rejected |
|---|---|---|---|
| 1 | Probe cadence | Light first round (about 60), then about 10 per weekly check-in | One-off only; no probing |
| 2 | Probe answer | Rate each probe, spot-check about one in five with a judged one-line answer | Ratings only; answering every probe |
| 3 | Answering rule | Depth-gated: explain / brief / decline; personal facts only from memories | Memories only; general knowledge everywhere |
| 4 | Combining signals | Cautious: claims capped at 2 until corroborated, evidence floors, probes adjust both ways, depth 4 needs spot-checks, every change proposed | Highest signal wins; manual only |
| 5 | Topic structure | A topic tree grown from the person's data, with merges reviewed | Free text; a fixed external taxonomy |
| 6 | Where probes happen | A local web page shared with memory review | Terminal; Markdown sheet |
| 7 | Advanced implies foundations | Prerequisite links predict foundations; within a topic, passing a hard level implies the easier ones (adaptive probing) | Probing every level and every foundation separately |
| 8 | Learned predictor | Phase 2: a small Bayesian IRT or logistic model on probe responses; swapped in only if it beats the rules on held-out probes | Training before data exists; a deep model on one person's data |
