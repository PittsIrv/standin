# The World Tree

**Status:** design, awaiting approval
**Replaces parts of:** [knowledge map](2026-10-07-knowledge-map.md):
- §2: the tree covers the person's whole world, not only topics;
- §3.2: the inference rows (background seeding, upward, prerequisite) become hypotheses;
- §4.3, §4.5, §4.6: probing comes from hypotheses;
- §10: hypothesis nodes and calibration move from "Phase 2" to now, in a simple form.

Everything not named here stands as written, including:
- claims;
- claim checks and gaps;
- keep or lower;
- spot-checks and held-out probes;
- boundaries;
- the answering rule for lit nodes;
- calibration scores.

## 1. Intent

standin speaks as a person, so it needs a model of that person's world: what they know, what they've done, who and what is in their life, and what they think. The model must be:

- **Simple to explain.** It is one tree:
  - **lit** where we know;
  - **dark** where the person doesn't know;
  - **probable** where we predict;
  - **absent** where nobody has explored yet.
- **Grown from evidence, not designed in advance.** A node exists because the person said something, or a probe revealed something.
- **Self-improving where it can be measured.** Predictions about knowledge are checked by probes, and the checks make the next predictions better.
- **Safe by construction.** It never states a guess about the person's life. Privacy does not depend on any one filter.

Prior art this builds on (see the knowledge-map spec's related work for more):
- **Overlay and open learner models.** Knowledge is a lit subset of a domain map, and the person can see and edit it.
- **Knowledge space theory.** Prerequisites, and probing at the fringe of what is known.
- **Personal knowledge graphs.** A person's own entities, including minor ones.
- **HippoRAG-style retrieval.** Seed nodes from the question, then spread to neighbours.

## 2. Goals, non-goals, anti-goals

**Goals**
- One kind of node, six fixed roots, and growth below them from evidence.
- Hypothesis nodes for knowledge, with calibrated probabilities that improve from probe outcomes.
- Guesses about the person's life turn into questions to ask them, never into statements.
- An opt-in way to share text-free outcome records, and to load default reliabilities learned from many people.

**Non-goals (for now)**
- A graph database. The tree is small, so SQLite tables loaded into memory are enough.
- Typed relationships ("owns", "sister of"). Relations live in the text of facts.
- Training any model on personal text, or a service that pools outcomes. The pooling service is its own sub-project.
- The speaker and full retrieval. Those are SP4. This spec defines what they consume.

**Anti-goals: failure even if it works**
- The standin says something about the person's life that the person never said.
- A guess about health, religion, sexuality, politics, ethnicity or another sensitive category exists anywhere in the store.
- The tree reshuffles itself between runs. Changes are incremental.
- The learning loop makes predictions worse, and nobody notices.

## Tunable numbers

`SPLIT_AT` (12), `DROP_BELOW` (0.3 after 10 outcomes), `SPEAK_AT` (0.8), `AWAKEN_BUDGET` (20), the prior cap (10 pseudo-counts), and the Brier window (20 outcomes) are starting values.
- They ship as named constants in config.
- SP3 adds an eval that sweeps them, and they are revisited with data.

## 3. The tree

### 3.1 Roots

Six fixed roots. They never change, and everything else grows under them.

| Root | Holds | Main sources |
|---|---|---|
| Knowledge | What the person knows, lit by depth | claims, probes, hypotheses |
| Work | Projects, roles, organizations, things built | projects bank |
| Background | Education, origin, path; seeds hypotheses in Knowledge | education bank |
| People | People in the person's life, by role | anything that mentions them |
| Views | Opinions, values, how they think | opinions bank |
| Life | Pets, places, hobbies, routines | life bank |

### 3.2 Nodes and links

- **One kind of node.** Each node has:
  - a name and aliases;
  - an optional definition;
  - an optional label (`topic | project | org | place | person | work | pet | other`). The label is informational only and changes no behaviour.

  Today's entity kinds become labels.
- **Three kinds of link:**
  - **home** (`part_of`): every node except a root has exactly one home parent. This is the tree.
  - **related:** cross-links, for when something appears in several places. For example, an advisor lives under People and is related to a Research project. Related links are undirected, and never carry lighting or boundaries.
  - **requires:** a prerequisite, between Knowledge nodes only.
- **Facts live in nodes.** Every memory (fact, competence, stance or negative) has exactly one **home node**, the most specific node it is about. It may also link to other nodes, as memories do today.

### 3.3 Growth

All growth is automatic. It is visible and editable on the review page.

- **Placement.** When a memory is approved, the `map` role gives it a home node. It either finds the node or creates it under the right parent. A new node gets a home parent the same way.
- **Splitting, by identity.** When facts in a node refer to a part by name, or treat it as its own thing ("Miso is the shy one"), the part becomes a child node. Facts about only that part move to it, and shared facts stay with the parent.
- **Splitting, by volume.** When a node holds more than **`SPLIT_AT` facts** (starting value **12**) that cluster into distinct sub-subjects, the `map` role proposes children and moves the facts. A node with fewer facts never splits by volume.
- **Merging** is the reverse, as today. The survivor keeps the other's names as aliases.
- **Knowledge expansion stays.** The `map` role can still break a Knowledge node into its textbook parts (knowledge-map §2.2). But expanded parts are **frontier nodes**:
  - they are hidden from the tree view and the speaker;
  - they become visible once a probe, a claim or a hypothesis touches them.

  Only Knowledge nodes expand, since the other roots have no textbook structure.
- **Never re-added.** A node or link the person deleted is never re-added by any automatic step (knowledge-map §2.4).

### 3.4 Node states

| State | Meaning | Where it comes from |
|---|---|---|
| **Lit** at depth `d` | Known. For Knowledge: depth `d`. For other roots: approved facts exist | claims, probes, gap notes, and approved facts; inheritance down the branch with gaps carving exceptions (unchanged) |
| **Dark** | Known not to | a claim or probe at 0, or a gap |
| **Probable** | Predicted, with a calibrated probability | a hypothesis (§4); Knowledge only |
| **Absent / frontier** | Not explored | no node, or a hidden frontier node |

Background seeding, upward inference and prerequisite inference no longer light nodes directly. They become kinds of hypothesis evidence (§4.2).

## 4. Hypotheses: predicting what the person knows

### 4.1 The predictor

- **A new role, `hypothesize`** (large tier, private zone). It reads:
  - the lit and dark parts of the tree, with their evidence;
  - the newly approved memories;
  - the current reliability of each evidence kind (§5).

  It proposes hypotheses: "probably knows X at depth `d`".
- **When it runs.** It runs inside `standin map refresh`, which also runs at review-session start. It is incremental: it proposes changes to existing hypotheses and never regenerates them.
- **Knowledge only.** It never proposes depth, facts or opinions for the other roots.

### 4.2 A hypothesis

- **Fields:**
  - node;
  - depth (1–4);
  - raw score (`low | medium | high`);
  - evidence kind;
  - evidence path, a list of node ids;
  - a one-line reason;
  - status (`open | confirmed | refuted | withdrawn`).
- **Evidence kinds:**

  | Kind | Example |
  |---|---|
  | `background` | "CS student at CMU → algorithms at 2" (replaces seeding) |
  | `part` | "probed PPO at 4 → reinforcement learning at 3" (replaces upward inference) |
  | `prerequisite` | "RLHF at 4 → probability at 3" (replaces prerequisite inference) |
  | `work` | "built a Go engine in Rust → Rust at 2" |
  | `other` | anything else, with a reason |

- **Guards against guesses building on guesses:**
  - The path must start at a **lit or dark** node, never at another hypothesis.
  - At most **2 hops** from that start.
  - It may not contradict a lit or dark node. Probed and claimed nodes are authoritative.
  - **No sensitive categories** (§6.2), even inside Knowledge. For example, it never guesses knowledge that would imply a health condition or a religion.

### 4.3 Outcomes

A probe on a hypothesis node, at the hypothesized depth, settles it:

- **Confirmed:** a rating of `know` or `roughly`, unless a spot-check on that response failed.
- **Refuted:** a `no_idea` rating, or a failed spot-check.
- **No outcome:** `wouldnt_say`. The boundary applies, and the hypothesis is withdrawn.

A confirmed hypothesis lights the node with basis `probed`. A refuted one lights nothing. The node stays unlit, and the next refresh may propose a lower depth there. A refutation is not a claim miss, so the person isn't asked to judge it. *(Builder's call.)* Depth 4 still needs two passed spot-checks (knowledge-map decision 37).

Held-out probes (knowledge-map §4.8) settle a hypothesis only once released, and fixed held-out probes never do. Their outcomes feed scoring, never learning.

## 5. Calibration and learning

### 5.1 Reliability counts

The model's raw score is not a probability. Model self-confidence is overconfident (Kadavath et al., 2022). A small statistical layer turns it into one:

- **The cells.** A count is kept per **cell** = (evidence kind × raw score). That is 5 × 3 = 15 cells.
- **The probability.** `P(hypothesis holds) = (confirmed + a) / (confirmed + refuted + a + b)`, the mean of a Beta distribution.
  - `a` and `b` come from the prior: `a = b = 1` by default, or from a loaded default-reliability file (§7).
  - Only usable outcomes count: non-held-out probes, plus rotating probes after release.
- **Computed, not stored.** Counts are recomputed from hypotheses and responses on read, like lighting.

### 5.2 How it learns

```
approved memories ─► hypothesize ─► open hypotheses (raw score, kind)
        ▲                                  │ calibrated P from cell counts
        │                                  ▼
  next refresh ◄── outcome ◄── probe the most uncertain first
```

- **Probe choice.** After claim checks, sessions probe open hypotheses in order of `|P − 0.5|`, smallest first.
  - **Weighting.** Weighted by how often the topic matters for answering. That is weight 1 until SP4 has answer logs.
  - **Replaces** foundations (§4.5) and the discovery walk (§4.6).
- **How depth grows.** A confirmed hypothesis at `d` lets the next refresh propose `d + 1` at the same node, or neighbours. The loop does the walking.
- **Feeding back.** The predictor sees per-cell reliabilities in its prompt. It stops proposing a cell whose `P` is below **`DROP_BELOW`** (starting value **0.3**) after at least **10** outcomes.

### 5.3 Checking that learning helps

- **What is scored.** Each held-out outcome on a hypothesis node is scored twice, with the Brier score:
  - against the calibrated `P` at the time it was shown (stored with the prediction, as today);
  - against the prior-only `P`.
- **The safeguard.** If calibrated `P` scores worse than prior-only `P` over the last **20** scored outcomes, the system falls back to prior-only probabilities until that changes.
- **Where it's shown.** `standin map --private` shows both scores. This is the "stops changing anything if it isn't getting better" rule.

## 6. The person's world beyond knowledge

### 6.1 Guesses become questions

- **Questions, not statements.** The `map` role, during placement and splitting, may notice a gap worth asking about. For example: "two cats, but no names", or "a project with no outcome". It records each as a **question** on that node.
- **Where they go.** Questions show up as an optional card on the review page, and in a generated interview sheet. Each is answered (becoming an observation, then a memory through the normal pipeline), dismissed, or left.
- **Never used as facts.** A question is never shown to visitors, never used by the speaker, and never treated as a fact.

### 6.2 Sensitive categories

- **The categories:** health, religion, sexuality, gender identity, politics and party affiliation, ethnicity or race, immigration status, finances, criminal history, and trade-union membership.
- **What the system never does.** It never forms a hypothesis or a question about these.
- **What the person can still do.** They can tell standin about them. Such facts are stored like any other, under their own disclosure tier.
- **Enforcement:**
  - prompt rules for `hypothesize` and `map`;
  - a deterministic check that rejects any hypothesis or question whose node or text matches a category list;
  - a test set of tricky cases.

### 6.3 Speaking: the boundary SP4 must respect

- **Lit nodes** answer by the knowledge-map answering rule (§5).
- **Probable nodes** answer at most `brief`, with the "inferred" badge, and only if `P ≥ SPEAK_AT` (starting value **0.8**). Otherwise they decline.
- **Other roots** speak only from approved facts, within each fact's disclosure tier and any branch boundary.
- **The backstop.** The `screen` role checks every outgoing reply. The main protection is upstream: only allowed content ever enters the speaker's context.

### 6.4 Awakening (the retrieval interface SP4 builds on)

`awaken(question) → context` runs in four steps:

1. **Route** to 0–3 seed nodes. Keyword candidates come from names and aliases, and the model picks; zero seeds means decline.
2. **Spread**, on a budget, from each seed:
   - its ancestors, for inheritance and boundaries;
   - lit and probable children;
   - related links;
   - and up to **`AWAKEN_BUDGET`** memories in total (starting value **20**).
3. **Filter before the context is built:**
   - approved memories only;
   - tier and boundary rules;
   - hypotheses only at or above `SPEAK_AT`.
4. **Return** the filtered context with each item's node, state and source.

Personalized PageRank (HippoRAG) is the planned upgrade for step 2, if SP3 evals show fixed-hop spreading misses context.

## 7. Learning across people (opt-in)

- **Consent.** The config setting `sharing.outcomes` is **off** by default.
- **The record is text-free.** Each settled hypothesis becomes:

  `{ evidenceKind, rawScore, hops, startDepth, hypothesizedDepth, outcome }`

  It has no node names, no topic names and no times, so nothing in it identifies a person or a topic.
- **`standin outcomes export [--out F]`** writes the records as JSON for the person to inspect and share themselves. Nothing is sent automatically.
- **`standin outcomes priors <file>`** loads a default-reliability file: Beta `(a, b)` per cell.
  - **Its weight is capped** at **10** pseudo-counts per cell, so the person's own outcomes soon dominate.
  - **Changing priors.** A loaded file can be removed with `--clear`.
- **Pooling is out of scope.** Aggregating everyone's records into a default file is a separate sub-project, with its own consent and privacy design.

## 8. Data model

- **`topics` becomes `nodes`.**
  - **Columns:** root, label, definition, frontier flag, boundary tier, and deleted.
  - **Ids:** existing entity ids are kept.
  - **Migration:**
    - topics go under Knowledge;
    - projects, orgs and works go under Work;
    - persons go under People;
    - places go under Life.

    Then `map refresh` re-places what doesn't fit.
  - **Existing inferred lighting** (`basis: predicted`) moves over as follows. *(Builder's call.)*
    - Approved inferred lighting becomes open hypotheses: kind taken from its reasons, raw score `medium`.
    - Open proposals of inferred lighting are withdrawn.
- **`topic_edges`** gains the kind `related`.
- **`memories`** gains `home_node_id`. The migration fills it from the existing entity links, taking the most specific.
- **New tables:**
  - `hypotheses`: the fields in §4.2, plus `settled_by_response_id`;
  - `questions`: node, text, and status (`open | answered | dismissed`).
- **Config:** `sharing.outcomes` (boolean); the loaded priors file is stored in the instance.
- **No new state for lighting or calibration.** Both are computed on read.

## 9. What changes in existing code

- **Lighting.** `computeLighting` drops the seeding, upward and prerequisite rules. Lit and dark come from claims, probes, gaps and inheritance, and probable comes from open hypotheses.
- **Probing.** `nextTarget` priority becomes: follow-ups → claim checks → hypothesis probes, by uncertainty. Foundations and discovery are removed. Depth-4 spot-checks stay.
- **Proposals.** Lighting proposals for inferred depth go away, since hypotheses replace them. Claims and lowered claims are unchanged.
- **Compaction** asks `map` for a home node, using the existing placement prompt, extended to all roots.
- **The SP2a-2b review page.** The Tree tab shows roots, states and questions. Cards gain a question card. Everything else in its plan stands.

## 10. Delivery

1. **WT-1: the world tree.** Nodes and roots, home nodes for memories, related links, splitting and merging, frontier nodes, the migration, and the tree view.
2. **WT-2: hypotheses and learning.** The `hypothesize` role, the evidence guards, the sensitive-category check, reliability counts, hypothesis-driven probing, the Brier safeguard, and removal of the replaced rules.
3. **WT-3: questions and opt-in outcomes.** Questions on nodes, the export and priors commands.
4. **SP2a-2b: the review page,** with its plan revised for WT-1–3.

## 11. Testing

- **Growth:**
  - placement under each root;
  - a split by identity moves the right facts;
  - a split by volume only above `SPLIT_AT`;
  - merges;
  - deleted nodes never return;
  - frontier nodes are hidden.
- **Hypotheses:**
  - the guards: no hypothesis-on-hypothesis, 2 hops, no contradiction of lit or dark nodes;
  - sensitive-category rejection, on a fixed tricky-case set;
  - incremental refresh doesn't reshuffle.
- **Learning:**
  - Beta counts from outcomes;
  - held-out outcomes excluded until release, and fixed ones forever;
  - `DROP_BELOW`;
  - the Brier fallback, with scripted outcomes.
- **Outcomes:**
  - export has no strings beyond the allowed enums;
  - priors are capped at 10;
  - `--clear` works.
- **Questions:** never in `awaken` output, and answering one creates an observation.

## 12. Decisions log

Continues from knowledge-map decision 40.

| # | Decision | Choice | Rejected |
|---|---|---|---|
| 41 | The model of a person | One world tree: one kind of node under fixed roots, grown from evidence; lit, dark, probable, absent | A graph of separate entity kinds; a tree for knowledge only |
| 42 | Storage | SQLite tables, the graph loaded into memory | A graph database |
| 43 | Granularity | Start coarse; split when a part gains identity or a node gathers many facts; merge in reverse | A fine-grained taxonomy designed up front |
| 44 | Links | Home parent, related, requires; relations as text in facts | Typed relationship edges |
| 45 | Placement | Automatic, editable later; privacy carried on each fact, with branch boundaries as an extra layer | Reviewing every placement |
| 46 | "Probably knows" | Hypothesis nodes from a model, verified by probes | Dropping inference; fixed inference rules |
| 47 | Two models | A knowledge predictor that learns from probes; a speaker that conditions on context and predicts nothing | A speaker that also predicts knowledge |
| 48 | Calibration | A separate statistical layer: Beta counts per evidence kind and raw score | The model's own confidence; an LLM judge of confidence |
| 49 | Learning across people | Opt-in, text-free outcome records; a capped default-reliability file | Training on personal text; no sharing |
| 50 | What probing tests | Open hypotheses, most uncertain first, after claim checks | Foundations and a discovery walk |
| 51 | Beyond knowledge | Guesses become questions to ask, never statements; sensitive categories never guessed; the output gate is a backstop | Knowledge only; predicting everything behind an output gate |
| 52 | Using probable nodes | Spoken without approval, at most `brief` with the "inferred" badge, only if `P ≥ 0.8` | Only after approval; never spoken |
| 53 | Confirmed hypotheses | Light directly with basis `probed`; the person's rating is the evidence | A lighting proposal to review |
| 54 | Numbers | Starting values as named constants, tuned by an SP3 sweep | Setting each by discussion before building |
| 55 | Seeing the tree | A node-link forest on the review page: lit glows by depth, probable is dashed with fill by probability, dark is gray, frontier behind a toggle; a side panel shows a node's facts and evidence and edits it, and dragging moves a node | A radial forest; an indented outline |
