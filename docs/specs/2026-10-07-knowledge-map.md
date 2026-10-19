# SP2a: Knowledge map (a lit tree) and local review page

Status: approved 2026-10-19 (decisions in §13). Revised 2026-10-18 after a decision-by-decision review, then made English-only. The implementation plan will be rewritten to match.
Builds on: [architecture spec](2026-10-01-standin-architecture.md) §5 (memory model) and §7 (competence-gated knowledge), and the [model-routing spec](2026-10-03-model-routing.md) (roles, traces).

## 1. Goal

The standin represents the person **as they present themselves**, the way a résumé does. It is not a measurement of what they can really do. Within that, it should know the shape of what the person knows, and say "I don't know" everywhere else, even when the underlying model knows the answer.

This spec builds that as a **lit tree**:

- **The structure is general knowledge.** Each topic is defined by its components ("distributed systems" → consensus, replication, partitioning, fault tolerance). Nodes start **dark**.
- **The person's claims light it.** A claim lights a node and its branch at the claimed depth. A background claim ("CS student at CMU") lights the core of what that background implies.
- **Probes dig deeper.** They check claims for gaps, confirm inferred foundations, and discover lit areas the person never claimed. Gaps are noted, and the person decides what each one means.
- **An answering rule** turns how brightly a node is lit into what the standin may say.
- **A calibration score** measures how well the map predicts the person's own ratings on held-out probes.
- **`standin review`** is a local web page for probes, gap decisions, and lighting approvals. SP2b (scanners, the `screen` role, publishing) builds on the same page.

Why claims come first, and probes still matter:

- **The standin speaks for the person,** so their own account of themselves is the authority.
- **The base model knows almost everything,** so the default is still deny. Dark nodes are declined, and only lit nodes are answered.
- **Gaps inside a claim are worth knowing,** so the standin doesn't fluently explain the very thing the person said they don't know.

## 2. The tree

### 2.1 Nodes and definitions

- A node is a topic: an entity of kind `topic`, with a one-line **definition**. Alternative names merge as aliases.
- **Edges**, of two kinds:

  | Edge | Meaning | Example |
  |---|---|---|
  | `part_of` | component → whole | consensus → distributed systems |
  | `requires` | advanced → foundation | RLHF requires probability |

- Cycles are rejected in both kinds.

### 2.2 Expansion

- **On demand.** A node is expanded into its components when probing first reaches it, or when background seeding needs it (§2.3).
- **The `map` role** (large tier, private zone) returns, for a node:
  - 4–8 components, each with a one-line definition;
  - the node's prerequisites.
- **Stored and reused.** An expansion is never regenerated, so model variability can't reshuffle the tree.
- **Merging.** The `map` role also merges duplicates ("RL" = "reinforcement learning"), including a topic from the person's data and the same topic from an expansion.

### 2.3 Background seeding

- **A background claim** is an approved memory about the person's education or role, e.g. "I'm a CS student at CMU". The `map` role turns it into the core topics that background implies.
- **Lighting.** The core topics are lit at depth **2** (working knowledge). Electives stay dark until the person claims them or probes light them.
- **Review.** Seeded lighting is a proposal, like any other lighting (§3.5).

### 2.4 Structure is automatic

- Expansions, prerequisites and merges join the tree without review. They are textbook structure, not claims about the person.
- On the review page, the person can rename, move or delete any node or edge at any time. A deleted node is not re-added by a later expansion.

## 3. Lighting

### 3.1 Depth scale

| Depth | Meaning |
|---|---|
| 0 | doesn't know (a recorded gap) |
| 1 | aware of it |
| 2 | working knowledge |
| 3 | strong |
| 4 | expert |

A dark node has no depth: it is not on record.

### 3.2 What lights a node

| Source | Lights | Basis |
|---|---|---|
| **Claim:** an approved competence memory from the person's own words | The node at the claimed depth, with no cap | `claimed` |
| **Inheritance:** a claimed node's branch | Every descendant at the claimed depth, except recorded gaps (§4.4) | `claimed` |
| **Background seeding** (§2.3) | Core topics at 2 | `predicted` |
| **Upward inference:** a lit child | Parent at `min(child − 1, 3)`, taking the maximum over its children | `predicted` |
| **Prerequisite inference:** a lit node `T` at depth `d` | Each prerequisite at `min(d − 1, 3)`, losing one level per hop | `predicted` |
| **Probes:** foundations and discovery (§4.5, §4.6) | The level the probes found | `probed` |
| **Gap note** (§4.4) | A component inside a claimed branch, at the level the person is fine up to | `probed` |

- **Claims count as established.** Inference from a claim works the same as inference from probes.
- **Precedence.**
  - A probed level is never overridden by inference.
  - Otherwise the highest of the claim and the inferred values wins.
  - Inference can raise a node above the person's own claim, as a proposal, e.g. "you claimed ML at 1, but RLHF at 4 implies 2". This catches under-claiming, and the person decides.

### 3.3 Not modeled in SP2a

- **Forgetting.** No time-based re-checks.
- **Learning updates.** There is no "I learned X" entry. The tree changes only through the normal pipeline (interviews and check-ins become claims) and through probing.
- **Authored work as evidence.** Projects and writing are decided in SP2b, with real scanned data.

### 3.4 Boundaries ("wouldn't say")

- **A boundary is not a gap.** "Wouldn't say" means "I know, but I don't discuss it".
- **Applied at once.** Rating a probe "wouldn't say" puts a **tier-3 boundary** (deflect) on that node right away. The person can undo it in review.
- **Covers the branch.** A boundary on "health" also covers its subtopics.
- **Why no review first.** Every other change is proposed because a mistake could share something. This one can only withhold.

### 3.5 Proposals and review

- **Lighting changes need review.** Every change to how a node is lit is proposed as a competence memory that supersedes the approved one. Approved lighting is what the runtime uses.
- **What is exempt.** Gap notes the person confirmed themselves (§4.4), and boundaries (§3.4).
- **Rejections.**
  - A rejected proposal (same node, same depth) is never proposed again.
  - A different depth, or new evidence (a new claim or a probe result), can propose again.
- **Wording.** Proposals are written in the person's voice, using these templates (`{t}` is the topic):

  | Depth | Statement |
  |---|---|
  | 0 | {t} isn't something I know. |
  | 1 | I've heard of {t} but haven't used it. |
  | 2 | I've used {t} and can get things done with it. |
  | 3 | I know {t} well. |
  | 4 | {t} is one of my deep areas. |
  | gap note | I'm fine with {sub} up to {level}, but not deeper. |

## 4. Probes

### 4.1 Probe and response

- **A probe** has:
  - a node;
  - a question;
  - a difficulty (1–4);
  - a holdout set: `none`, `fixed`, or `rotating` (§4.8);
  - for a claim check, the claimed node it checks.
- **A response** has:
  - the standin's prediction for the node, recorded when the probe is shown and before the rating (§4.8);
  - a rating: `know`, `roughly`, `no_idea`, or `wouldnt_say`;
  - optionally, a spot-check answer (one line) with its grade (`pass`/`fail`, plus a reason);
  - the time it was answered.

### 4.2 Writing probes

- **Who writes them.** The `quiz` role (medium) writes probes for a node at a given difficulty.
- **Language.** English only, following the [memory-core simplification](2026-10-18-memory-core-simplify.md).
- **Content.** Probes test understanding, not trivia: "could someone at this level explain or do X", never dates or names.
- **Reuse.** Probes are stored and reused. A probe is never shown twice.

### 4.3 Sessions

- **Length.** The first session is **40** probes, and later sessions **10**. `standin review --probes N` overrides this.
- **Strict priority:**
  1. **Claim checks** (§4.4), until every claim has been checked or kept;
  2. **Foundations** (§4.5);
  3. **Discovery** (§4.6).

### 4.4 Claim checks and gaps

**A claim check:**
- 3 probes at the claimed level, each on a **different component** of the claimed node. The node is expanded first if needed.
- A claim passes with no confirmed gap. It is then checked: never re-checked in SP2a, and its branch stays lit by inheritance.

**Misses**, which the person judges:
- **What counts as a miss:** a `no_idea` rating, or a `know` whose spot-check failed. `roughly` is fine.
- **The person decides.** Each miss is shown with the question: "Is this a gap?"
  - **Not a gap:** nothing changes.
  - **A gap:** one follow-up probe, one level lower, on the same component. That produces a **gap note**: "fine with {component} up to {level}, but not deeper". The component's lighting becomes that level.

**After a gap note, the person chooses for the claim:**
- **Keep it:** the branch stays lit at the claimed depth, except the noted gaps, and probing stops going deeper there.
- **Lower it:** the claim drops to one below the lowest confirmed gap level, and counts as checked.

**Gap statuses:** `open` (awaiting keep or lower), `kept`, or `lowered`. A later learning sub-project plugs into these.

### 4.5 Foundations

Each inferred prerequisite (§3.2) gets **one probe at its predicted level**:
- `know` confirms the inference, and the node becomes `probed`;
- a miss is shown to the person, as in §4.4.

### 4.6 Discovery

- **Where.** Dark nodes next to lit nodes at depth 3 or more: components, siblings and prerequisites.
- **How it climbs.** A placement walk from difficulty **2**: step up on `know`, stop on a miss.
- **What it proposes.** The highest level reached, as lighting.
- **Depth 4** also needs **2** passed spot-checks at difficulty 4.

### 4.7 Spot-checks

- **When.** About **1 in 3** `know` or `roughly` ratings asks for a one-line answer.
- **Grading.** A new role, **`grade`** (medium, private zone), grades through the batch API when the provider has one. Nobody waits on it.
  - A failed grade becomes a miss (§4.4), shown at the next session.
  - `judge` (large) stays reserved for SP3 eval grading.
- **Voice samples.** Spot-check answers in the person's words also become exemplars, through the normal review queue. Held-out probes follow §4.8.

### 4.8 Held out for calibration

A held-out probe is a test item. The system must not learn from it before it is scored. Each probe is assigned a set at random when it is written, and is never reassigned.

| Set | Share | Feeds the map, exemplars, or Phase-2 training? |
|---|---|---|
| `fixed` | about 10%, with no cap on the set's size | Never |
| `rotating` | about 20% | Only after it is scored and released |
| `none` | the rest | Yes, immediately |

- **The prediction is recorded first.** When a probe is shown, the standin's `answerMode` for its node is stored on the response before the rating is accepted. Scoring uses that stored prediction.
- **Release.** A rotating probe is released at the end of the session in which it was answered, or at the start of the next session if the last one crashed.
- **Held-out misses:**
  - A miss on a rotating probe is shown for judging only after release.
  - A miss on a fixed probe is never shown, since judging it would feed the test item into the map.
  - Their spot-check answers become exemplars only after release, and never for fixed probes.
- **Comparing versions.** Because the fixed set keeps growing, system versions are compared by re-scoring them on the same items.

## 5. Answering rule

`answerMode(node)` is shared core code, so evals can test it now. The SP4 runtime uses it through the `competence(topic)` tool.

| Lit depth | Mode | What the standin does | Badge |
|---|---|---|---|
| 3–4 | `explain` | Explains using general knowledge, at the person's level, in their voice | inferred |
| 2 | `brief` | A short answer that states its confidence ("I've used it, not deeply") | inferred |
| 0–1, dark, or no node matched | `decline` | Declines in the person's words, then points to the nearest lit topic | not on record |

- **Which node.** A question maps to its node. If that node isn't in the tree, the nearest ancestor that is decides, through inheritance.
- **Gaps.** Inside a kept claim, a noted gap answers at the gap's level. The rest of the branch answers at the claimed depth.
- **Boundaries.** A tier-3 boundary on the node or an ancestor deflects regardless of depth. The SP4 runtime enforces it.
- **Facts.** Facts about the person come only from approved memories, with citations (`grounded`).

## 6. Calibration

Two scores, computed on held-out probes from the stored predictions. In both, "would answer" (`explain`/`brief`) agrees with `know`/`roughly`, and `decline` agrees with `no_idea`. `wouldnt_say` is excluded.

| Score | Computed on | Shown |
|---|---|---|
| **Map score** | Held-out probes outside branches where the person kept a claim | `standin map`, `standin eval` (SP3), and `/how-it-works`. It is the score used for the Phase-2 swap-in (§10.4). |
| **Presented score** | All held-out probes | Privately only: `standin map --private`. The difference from the map score shows how far the presented self goes beyond the person's own ratings. |

Both are reported separately for the `fixed` and `rotating` sets.

## 7. The `standin review` page

**Server**
- `node:http`, plain TypeScript and HTML, with no front-end framework and no build step.
- It serves one page and a small JSON API backed by the store.

**Cards**
- probes, with a text box that expands for spot-checks;
- **possible gaps:** a miss, with "gap / not a gap";
- **keep or lower:** a claim with open gap notes;
- lighting proposals, with their reasons;
- boundaries, with undo;
- the tree: rename, move, or delete a node or edge.

The memory review queue (weekly cap, ranking by importance) is the same one the CLI shows.

**Keys**
- `1`–`4` rate a probe.
- `a` / `r` approve or reject.
- `e` edits a statement before approving.
- `g` / `n` mark a miss as a gap or not.

**Security**
- Binds to `127.0.0.1` by default.
- Every request needs a random session token. The page URL carries it, the API takes it only in a header, and requests without it get 403. So other pages in the browser can't call the API.
- `--lan` binds to the local network for phone access and prints a QR code containing the token. It is opt-in, because the page shows private data.
- No data leaves the machine except the model calls made by the `map`, `quiz`, and `grade` roles.

**Tracing**
- Each review session is a trace of kind `review`.
- Expansion, probe writing and grading appear as model-call spans.

## 8. Data model changes

**A migration adds:**
- **`topics`:** a topic entity's definition, when it was expanded, its boundary tier, and whether the person deleted it;
- **`topic_edges`:** `part_of` and `requires`, plus `deleted` for edges the person removed;
- **`probes`:** node, check-of, holdout and `released_at`;
- **`probe_responses`:** the prediction recorded before the rating, the rating, the spot-check, and the grade;
- **`gaps`:** node, claimed node, level, status (`open | kept | lowered`), and the response that confirmed it.

**Other changes:**
- Competence memories reference a topic entity, so `attrs.domain` resolves to a topic id at compaction time.
- **Competence duplicates match by node.** A competence candidate whose node already has the same depth from a claim is a duplicate (a source is added). A different depth becomes a lighting proposal. There is no text search and no reconcile call ([memory-core simplification](2026-10-18-memory-core-simplify.md) §4).
- Lighting (claims, inheritance, inference) is **computed, not stored**. It is a pure function of approved competence memories, edges, gaps and usable probe responses. Only the resulting proposals are stored, as memories.

## 9. Errors and testing

**Errors**
- **No node matched** for a question: `decline` (deny by default).
- **`map`, `quiz` or `grade` model failure:** the step is skipped with one warning and retried next session. It never blocks rating.
- **A cycle in the edges:** the edge is refused, with the cycle path.
- **Page without its token:** 403.

**Tests**
- **Lighting:**
  - claims with no cap;
  - inheritance down a branch, and gaps carving exceptions;
  - upward and prerequisite inference (claims count as established), transitive with decay;
  - probes never overridden;
  - background seeding at 2.
- **Claim checks:**
  - 3 probes on distinct components;
  - a miss leading to a gap follow-up, then a gap note;
  - keep and lower;
  - a lowered claim at one below the lowest gap.
- **Selection:** strict priority, session sizes, discovery walk, the depth-4 gate.
- **Holdout:**
  - set shares at assignment, and fixed probes never reassigned;
  - held-out responses don't light anything before release;
  - fixed-probe misses never shown, and rotating misses shown only after release;
  - the stored prediction is the one scored.
- **Calibration:** both scores, on the demo persona with scripted ratings.
- **Rejections:** the same proposal is not repeated, and new evidence re-proposes.
- **Boundaries:** applied at once, covering the branch, and undoable.
- **`answerMode`:** each depth, dark nodes, the nearest ancestor, gaps.
- **Page:**
  - tokenless requests rejected;
  - bound to localhost unless `--lan`;
  - rate, judge a gap, keep or lower, approve and reject, end to end against a temp instance.

## 10. Phase 2: a hybrid knowledge model

The lighting rules in §3 work from day one with no data, and every change carries a readable reason. They also generate labeled data: each probe response is an example of "this person, this item → know / roughly / no idea". Phase 2 replaces the inference rules (§3.2: background, upward, prerequisite) with a **hybrid** model, and only if it beats them on the map score (§6). The person's own claims, gap decisions and boundaries are never replaced: they stay the authority. A capable model reasons over a knowledge graph, and a small statistical layer keeps its numbers honest.

```
claims + answered probes + gaps ──► KNOWN nodes (observations only)
                                        │
large model reasons over the graph ─► HYPOTHESIS nodes: depth + raw confidence + reason + evidence path
                                        │
calibration layer (fit on held-out probes) ─► calibrated P(depth ≥ k) per node
                                        │
answerMode + probe selection ◄──────────┘
```

### 10.1 Known and hypothesis nodes

Every topic node carries **two separate numbers**: a depth (how much the person knows) and a probability (how sure we are of that depth).

- **Known nodes** come only from observations: the person's claims, probe ratings, graded spot-checks, and confirmed gaps. Nothing else can create or promote one. In particular, the model can never turn its own hypothesis into a known node.
- **Hypothesis nodes** are written by a new role, **`hypothesize`** (large tier, private zone). It reads the current graph and the new observations and proposes, for each topic it can reason about:
  - a depth;
  - a raw confidence;
  - a one-line reason;
  - the **evidence path** it relies on, e.g. "strong in probability, because RLHF was probed at 4 and RLHF requires probability".

  It may also propose new topics and edges that the probes revealed. These go through the normal review queue, like `map` proposals.
- **Rules against snowballing:**
  - A hypothesis must cite at least one known node.
  - It may reach at most **2 hops** from that node, losing confidence at each hop.
  - Hypotheses never serve as evidence for other hypotheses.
- **Incremental, not rebuilt.** Each weekly run proposes changes to the existing graph instead of regenerating it, so model nondeterminism cannot reshuffle the map. Changes in lighting go to the review queue as in §3.5.

### 10.2 Calibration layer

A language model's stated confidence is usually overconfident, and P(IK)-style self-estimates calibrate poorly on new tasks. So the raw confidence is a **score**, not a probability. The layer turns it into calibrated `P(depth ≥ k)` per node.

The layer starts simple and grows only when the data supports it:

1. **Isotonic or Platt scaling** of the raw confidences, fit on held-out probes.
2. **Graded-response IRT as the calibrator**, once there is enough data:
   - **Ordinal ratings.** `P(rating ≥ k) = σ(θ_topic − b_item − τ_k)`, using all of no idea < roughly < know.
   - **Abilities linked through the graph.** `θ` for each topic is pooled with its parent, and softly constrained by prerequisites (`θ_foundation ≳ θ_advanced − 1`).
   - **Hypotheses as priors.** The hypothesis depth (with its calibrated confidence), the person's claim, and (from SP2b) authored-work evidence set each `θ`'s prior mean, with learned weights. This is explanatory IRT.
   - **Item difficulty from the text.** With one person, ability and item difficulty cannot be separated from responses alone. So `b_item` takes a prior from the stated level plus a model's estimate from the question text, and responses only nudge it.
   - **A self-rating bias term.** Spot-checks are a second, graded measurement of the same ability. The gap between "know it" ratings and graded spot-checks gives one bias parameter per broad area, which corrects self-ratings automatically.
   - **Optional drift.** `θ` may drift slowly week to week, so the map follows learning and forgetting.
   - **Fitting.** A few hundred parameters, fit by MAP with a Laplace approximation, in TypeScript with no Python dependency. Refit after each probe session.

### 10.3 Using the model

- **Answering.** `answerMode` uses the posterior, not a point estimate. For example, `explain` requires `P(depth ≥ 3) > 0.8`; otherwise it steps down a mode.
- **Probes test hypotheses.** Each weekly batch goes to the hypotheses with the highest expected information gain, weighted by how often the topic matters for answering. Probing works like testing claims, not like a quiz.

### 10.4 Evaluation and swap-in

**Target.** `P(rating ∈ {know, roughly})` for a probe. `wouldnt_say` is excluded.

**Systems compared** on the map score's held-out probes (§4.8, §6): the fixed set, and rotating probes before their release, outside kept branches. Never on training probes:
- the §3 inference rules;
- the LLM baseline: a model shown the approved map and asked to predict the rating (the "digital twin" approach);
- the graph alone, with simple calibration (10.2 step 1);
- IRT alone, without hypotheses;
- the full hybrid.

**Metrics.**
- AUC
- Brier score
- expected calibration error, with a reliability diagram

**Ablations of the hybrid:** graph priors, text-based difficulty, the self-rating bias term, and evidence paths.

**Swap-in rule.** A system replaces the rules only if it beats them on Brier score and does not do worse at catching "no idea" items (recall on declines). If a simpler system matches the hybrid, the simpler one wins.

**When.** After about 200 non-held-out responses. Until then, Phase 1 stores everything Phase 2 needs. The probe text, difficulty, topic, rating, spot-check grade, and timestamp are already in the data model. Hypothesis runs are traced like any other run.

**Cost.** One `hypothesize` run per week on the large tier costs cents to about a dollar. It can use the batch API, since nobody waits on it.

**Showcase.** `/how-it-works` shows:
- the comparison chart;
- the reliability diagram;
- the self-rating bias per area ("how well I know what I know");
- a sample hypothesis with its evidence path, and the probe that confirmed or refuted it.

### Related work

The problem sits between four areas. We did not find work that models **one real person's knowledge boundary** from a few of their answers plus language-model priors, in order to decide what an agent speaking as them may say. That gap is the framing for `/how-it-works`, to be re-checked before publishing.

| Area | Work | What it models | What standin borrows |
|---|---|---|---|
| Psychometrics | Item response theory (Rasch; Lord); computerized adaptive testing | P(correct) from ability and item difficulty | Adaptive probing (§4.6); the Phase-2 IRT model |
| Knowledge tracing | Bayesian KT (Corbett & Anderson 1995); Deep KT (Piech et al. 2015); cognitive diagnosis (NeuralCD, Wang et al. 2020); LLM-based KT: LKT, NTKT ([arXiv 2511.02599](https://arxiv.org/abs/2511.02599)); LLM difficulty prediction, DCL4KT+LLM ([arXiv 2312.11890](https://arxiv.org/abs/2312.11890)) | A learner's mastery over time; text helps cold-start items | Text-based item features for a learner with few answers |
| Digital twins | Park et al. 2024 (1,000-people interviews); Twin-2K-500 (Toubia et al., *Marketing Science* 2025, [arXiv 2505.17479](https://arxiv.org/abs/2505.17479)) | One person's held-out answers predicted from their interview, mostly attitudes and behavior | The LLM baseline; the test-retest comparison |
| Model self-knowledge and role-play | P(IK), Kadavath et al. 2022 ([arXiv 2207.05221](https://arxiv.org/abs/2207.05221)); TimeChara, Ahn et al., ACL Findings 2024 ([arXiv 2405.18027](https://arxiv.org/abs/2405.18027)) | Whether a model knows an answer; role-play characters showing knowledge they shouldn't have | The same question asked of a person; "character hallucination" as the failure mode the calibration score measures |

## 11. Out of scope

- **Learning from gaps** (explain a gap, re-check it, raise the claim) and **learning updates** ("I learned X"): a later knowledge-tree learning sub-project, plugging into gap statuses (§4.4).
- **Forgetting:** time-based re-checks and decay.
- **Authored work as evidence:** SP2b, with the scanners. Also SP2b: the `screen` role, publishing, rollback.
- **The runtime `competence` tool**, boundary enforcement in answers, and badges in the public widget: SP4.
- **Full eval suites** beyond the calibration scores, and the `judge` tier: SP3. This includes the open-question test, which compares the person's own answers with the standin's answers to the same questions. It needs the SP4 answer path, has its own question bank, and uses the same fixed-and-rotating holdout.
- **Web search** for expansions or background seeding.
- **Building the Phase-2 hybrid model** (§10). Phase 1 only has to store the data it needs.

## 12. Roles used

| Role | Tier | Zone | Purpose |
|---|---|---|---|
| `map` | large | private | Expand topics into components and prerequisites, merge duplicates, seed from background |
| `quiz` | medium | private | Write knowledge probes for a node at a difficulty |
| `grade` | medium | private | Grade spot-check answers |

## 13. Decisions log

| # | Decision | Choice | Rejected |
|---|---|---|---|
| 1 | Stance | Claim-first: represent the person as they present themselves. Claims set depth with no cap. Probes look for gaps, and the person decides what each gap means. | Measuring true ability, with claims capped until corroborated |
| 2 | Kept claims | The branch is lit at the claimed depth, except noted gaps, which answer at their own level. Probing stops going deeper there. | Fully as claimed, gaps included; a "self-described" label |
| 3 | Inference from claims | Claims count as established: prerequisites at `min(c − 1, 3)`, parents at `min(child − 1, 3)` | Weak inference from claims; no inference |
| 4 | Gap judgment | The person judges each miss | Any single miss; two signals |
| 5 | What is a miss | `no_idea`, or `know` with a failed spot-check | `no_idea` only; also `roughly` |
| 6 | Tree structure | A lit tree: topics defined by their components (general knowledge), dark until lit | A tree grown only from the person's data; subtopics created only at gaps |
| 7 | Definitions | The `map` role's own knowledge, stored and reused | Web search; an external taxonomy |
| 8 | Review scope | Lighting only. Structure is automatic and editable on the page. | Reviewing every expansion; structure near claims |
| 9 | Background seeding | The core curriculum lit at depth 2; electives dark | Aware only (depth 1); model-judged depth |
| 10 | Session priority | Strict: claim checks, then foundations, then discovery | Fixed shares; claims only |
| 11 | Claim check | 3 probes at the claimed level on different components. A confirmed gap gets 1 follow-up one level lower. | A placement walk; one probe |
| 12 | Unclaimed nodes | Foundations: 1 probe at the predicted level. Discovery: walk up from 2, and 4 needs 2 passed spot-checks. | Spot-check every discovery "know"; the person sets the depth |
| 13 | Session size | First 40, then 10; spot-checks 1 in 3; `--probes N` | 60/10 at 1 in 5; 60/15 at 1 in 3 |
| 14 | Holdout | 10% fixed (no cap), 20% rotating; predictions recorded before the rating | Capping the fixed set at 100; 5%/15% |
| 15 | Calibration | A map score (excluding kept branches, public) plus a private presented score | One score over everything; the map score only |
| 16 | Rejections | The same node and depth are never re-proposed; new evidence can re-propose | Snooze for 90 days; rejection keeps the node dark |
| 17 | "Wouldn't say" | A tier-3 boundary applied at once, covering the branch, undoable | Suggest only; skip the probe only |
| 18 | Wording | Casual first-person templates (§3.5) | Plain templates |
| 19 | Tiers | `map` large, `quiz` medium, `grade` medium | `map` medium and `judge` large; all medium |
| 20 | Language | English only (memory-core simplification). This replaces the earlier choice of each topic's own language. | Bilingual probes |
| 21 | Scope | Representation only. Learning, forgetting, evidence and web search come later. | A learning loop in SP2a |
| 22 | Probe answer | Rate each probe; spot-check a share with a graded one-line answer | Ratings only; answering every probe |
| 23 | Answering rule | Depth-gated: explain / brief / decline; facts about the person only from memories | Memories only; general knowledge everywhere |
| 24 | Where probes happen | A local web page shared with memory review | Terminal; Markdown sheet |
| 25 | Phase-2 model | A hybrid of hypothesis nodes and a calibration layer. It replaces the inference rules only if it beats them on the map score, and never replaces the person's claims or gap decisions. | IRT alone; the graph alone with raw confidence; a deep model on one person's data |
| 26 | Open-question test | All in SP3, with its own question bank | Collecting held-out open answers in SP2a |
| 27 | Inference above a claim | Allowed, as a proposal for review | Claims as ceilings; flagging the disagreement only |
