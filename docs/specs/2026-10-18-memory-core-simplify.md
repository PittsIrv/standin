# Memory core, simplified: English only, plain rules, measured search

Status: decisions approved in conversation on 2026-10-18 (logged in §8). Awaiting written-spec review.
Amends: [SP1 memory core](2026-10-01-sp1-memory-core.md) and the [architecture spec](2026-10-01-standin-architecture.md) (Languages). Lands as its own PR after PR #3 and before SP2a.

## 1. Goal

Remove every hand-picked weight in the memory core that has no measured effect. Replace each one with a plain rule anyone can explain in a sentence, or with an experiment that picks the value from data. Narrow the scope to English.

**The guiding rule:** don't tune a number that doesn't change a decision. Where a number does change outcomes, measure it before choosing it.

## 2. English only

The standin works in English only for now. People talk differently in different languages, and mixing them muddies the voice patterns the standin learns.

**Removed:**
- language detection (`detectLang`);
- the Chinese interview text, so `CORE_V1` becomes English-only;
- `interview template --lang`;
- `persona.languages`;
- `lang` on observations, memories and exemplars, plus `--lang` flags;
- CJK handling in text similarity.

**Kept as a guard:** `observe` and `interview import` reject text whose letters are mostly non-Latin script, with the error "standin is English-only for now".

**Demo persona:** Lin Qiao's observations become English. End-to-end counts are updated to match.

## 3. Confidence and salience removed

**What was removed:**
- the noisy-OR confidence: 13 source weights, 3 role factors, a floor and a half-life;
- the salience product: 7 weights.

Both only ordered the review queue and showed a number.

**What replaces them:**
- **Sources instead of confidence.** A memory lists its sources, e.g. "interview ×2, slack". AI-memory sources (`claude-memory`, `chatgpt-memory`, `muse-paste`) are marked *unverified*.
- **A plain queue order:** contradictions, then updates, then new. Within each group, more distinct sources first, then oldest first.
- **Logging decisions for later.** Every approve or reject records the item's queue position and group at decision time. Once there are a few hundred decisions, a learned ranker may replace the plain order. It must beat the plain order on decisions held out from its training. The metric is decided when the ranker is built.

## 4. Finding duplicates

**Competence claims match by tree node.** Once SP2a's knowledge map exists, a competence candidate resolves to its topic node:
- same node, same depth: a duplicate, so a source is added;
- different depth: a lighting proposal (SP2a §3.5).

There is no text search and no reconcile call. Until SP2a lands, competence follows the fact path below.

**Facts, stances and negatives keep a retrieval step,** chosen by measurement:
- **A labeled set** (`packages/compaction/eval/dedup.jsonl`): candidate statements, each with the existing memory it should match (duplicate, update or contradiction), or none. It is seeded from the demo persona's known cases plus paraphrase pairs with no shared entity, and grows with real cases later.
- **`standin eval dedup`** reports recall@k (k = 1, 4, 8) and the average number of candidates sent to reconcile, for each method:
  - the current method: Dice ≥ 0.3, or a shared entity;
  - Dice top-k with no threshold, plus shared entities;
  - shared entities only.
- **The default is chosen by the person** after reading the report. There is no automatic selection rule. Embeddings are added as a method only if the report shows lexical methods missing paraphrases that matter.

## 5. Stale "currently…" memories

- **The trigger:** an approved current-state memory with no new mention for **120 days**.
- **Instead of expiring silently,** it gets a **"Still true?"** card in the review queue:
  - keep renews it for another 120 days;
  - no expires it, with the person as the actor.
- `currentStateHalfLifeDays` is removed, since confidence decay is gone.

## 6. Raw text kept until purged

- `consolidate` no longer purges observation text or trace prompt text on a timer.
- **`standin purge --before <date>`** purges both for observations compacted before that date. Hashes and pointers are kept, as before.
- `consolidation.retentionDays` becomes optional. When set, `consolidate` purges on that window as it did before.

## 7. No review cap

- `review.weeklyCap` is removed.
- `standin queue` and the review page show the whole queue in order. The person stops whenever they like.

## 8. Decisions log

| # | Decision | Choice | Rejected |
|---|---|---|---|
| 1 | Confidence and salience | Plain rules now (sources listed; contradictions → updates → new; more sources, then oldest), with queue position and decision logged for a later learned ranker that must beat the rules | Plain rules with no logging; keeping the formulas with weights in config |
| 2 | Language scope | English only for now | English and Chinese |
| 3 | Non-English input | Multilingual support removed from the code; a guard rejects mostly non-Latin text | Skipping non-English observations; translating facts into English |
| 4 | Duplicates | Competence matches by tree node. Facts, stances and negatives: measure retrieval (recall@k), and the person picks the method from the report. | Switching to embeddings now; dropping the threshold unmeasured |
| 5 | Stale current-state memories | Ask "Still true?" after 120 days | Expiring silently; never expiring |
| 6 | Raw text retention | Kept until the person purges | 90 days; deleted right after compaction |
| 7 | Review cap | None; an ordered queue the person stops whenever they like | 25 a week; a per-session cap |
| 8 | Sequencing | Its own PR after PR #3, before SP2a | Folding it into SP2a; doing it after SP2a |
