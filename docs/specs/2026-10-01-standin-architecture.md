# standin: Architecture Spec

**Date:** 2026-10-01
**Status:** Approved in brainstorming (2026-10-01)
**Author:** Mingxi Yan (with Claude)
**Scope:** The umbrella design for the whole project. Each sub-project in §12 gets its own detailed spec before it is built. Sub-project 1's spec is `2026-10-01-sp1-memory-core.md`.

## 1. What this is

`standin` is an open-source framework for a **disclosure-aware personal agent**: an AI that talks to other people *as you*. It speaks in your voice, knows what you know, says "I don't know" for things you don't, and only shares what you have approved.

Its first deployment is Mingxi Yan's personal website. There it is a floating guide that answers visitors' questions about Mingxi (work first, personal topics when asked), moves visitors to the right page, and links to a `/how-it-works` page that presents the engineering as a portfolio piece.

**Thesis:** *A twin that learns from private data but publishes only what the person has approved, with disclosure enforced in code and measured by evals.*

## 2. Prior art and how this differs

| Project | What it does | What this project does differently |
|---|---|---|
| Delphi (Digital Minds) | Builds a clone from a creator's published content, cites sources, clones voice | Ingests *private* data, and an approval airlock decides what becomes public |
| Second Me (Mindverse, OSS) | Local AI self trained with hierarchical memory (Qwen2.5 + GraphRAG) | Private data never goes into public-serving weights. Only approved public-tier exemplars are used for training |
| Claude / ChatGPT memory import | One-time snapshot transfer of an assistant's memory | Ongoing, deduplicated ingestion with source tracking, treated as low-confidence claims |
| Stanford "Generative Agent Simulations of 1,000 People" (Park et al., 2024) | Agents built from 2-hour interviews replicate survey answers | Uses the interview method as the main knowledge source and the test-retest idea as the main eval |
| Mem0 / Letta | Memory infrastructure (add/update/delete) | Borrows the compaction pattern and adds identity, tiers, and the person's competence boundaries |

## 3. Principles

1. **Receipts all the way down.** Every sentence the standin says traces to a memory, that memory traces to its sources, and each source traces to the moment the person approved it.
2. **Policy lives in data and code, not in the prompt.** The public agent cannot leak what was never published to it. Prompt instructions are a second layer, not the protection.
3. **Every interaction produces data.** Visitor questions it couldn't answer, the person's corrections, and eval results all feed back into memory and training.
4. **Default-deny.** Nothing reaches the public zone without passing the airlock.
5. **The person's attention is the bottleneck.** Review volume is capped and ranked. More data is not better if the reviewer ends up approving without reading.
6. **Exposure is not knowledge.** Only what the person authored or affirmed can become something the standin "knows."
7. **Clearly an AI.** The standin always identifies itself as an AI stand-in. It represents the person but **never acts or commits on their behalf**.

## 4. Zones

```
PRIVATE ZONE (person's machine, ~/.standin)                 PUBLIC ZONE (Cloudflare)
┌──────────────────────────────────────────────┐            ┌─────────────────────────┐
│ Ingest adapters (read-only)                  │            │ Public agent (Worker)   │
│   github · slack · gdrive · claude-memory ·  │            │  reads ONLY the compiled│
│   chatgpt-export · muse-paste · interview ·  │  approved  │  public bundle          │
│   website                                    │  bundle    │  no connectors, ever    │
│        ▼                                     │   only     │                         │
│ L0 observations → compaction → L1 memories   ├──────────► │ D1 + Vectorize          │
│                               → L2 profile   │  publish   │ Durable Object: budget, │
│        ▼                                     │            │  rate limits            │
│ Airlock: scanners + human review             │            └─────────────────────────┘
│ Scribe: weekly sync + check-in               │
└──────────────────────────────────────────────┘
```

Raw private data stays in the private zone. Model-provider API calls made during compaction do send content to the configured provider. The provider is pluggable, so a fully local model (for example via Ollama) is possible for people who need that.

## 5. Memory model

**Layers.** L0 *observations* (raw, append-only, purged after a retention window, pointers kept) → L1 *memories* (atomic, tiered, sourced) → L2 *profile* (compacted summaries: style card, current focus, values).

**L1 memory kinds.**

| Kind | Example | Role |
|---|---|---|
| `fact` | Interned at TikTok, summer 2025 | Autobiographical |
| `competence` | Game theory, depth 4/4 | Controls when general LLM knowledge may be used |
| `stance` | Prefers solver-guided training over pure self-play; strength 3/5 | Opinions |
| `negative` | Has never been to Japan | Explicit "I don't know / haven't" |

Voice **exemplars** (short, real text the person wrote) are a separate store, used for style rather than facts.

**Entities** (project, org, place, public person, work, topic) link to memories, which enables per-entity retrieval and contradiction checks.

**Lifecycle.** `proposed → approved | rejected`. Approved memories can later become `superseded | expired | retracted`. Rejected memories are kept, so the same thing is never proposed again.

**Bitemporal.** Valid time (`valid_from`/`valid_until`) and record time (`recorded_at` plus an append-only event log). This supports "as of August…", contradiction detection, and publish rollback.

**Confidence** is a deterministic function of source kind, corroboration count, and recency. Person-affirmed memories always score highest.

## 6. Disclosure tiers and answer states

**Tiers.** 1 public (cite and link) · 2 share in conversation (answer if asked, don't volunteer) · 3 deflect (the public bundle holds only a topic stub, never the content) · 4 never published (does not exist in the public zone).

v2 adds **audience grants**: what can be disclosed becomes a function of *(tier × audience)*. Friends get a signed, expiring, revocable link that unlocks a friends tier. The v1 schema keeps `tier` as an integer and leaves room for an audience scope column.

**Answer states**, shown to visitors as a badge on each reply:

| State | Trigger | Behavior |
|---|---|---|
| grounded | Approved memories retrieved | Answers and cites memory IDs |
| inferred | A stance extrapolated from stated values | Hedged ("haven't thought hard about it, but…"); never presented as a recorded view |
| not on record | Nothing stored either way | "I'm not sure I've told my standin; ask real me" |
| deflected | Tier-3 stub hit | Redirects to contacting the person |

"Person doesn't know" (a negative memory, or a competence depth of 0) is a **grounded** answer whose content is "I don't know."

**Competence-gated knowledge.** For questions about the world (not about the person), the agent may use the base model's general knowledge **only inside domains on the competence map, and only to that depth**. Outside the map it declines.

## 7. Ingestion and the airlock

**Adapters** are plugins with a declared contract: `scopes` (read-only), `authorshipSignal` (`self` / `engaged` / `exposed`), and `defaultSensitivity`. `exposed` observations never become knowledge.

**AI memory imports** (Claude, ChatGPT, Muse) are treated as *claims about the person written by another AI*. They get lower confidence and always go to review. The user's own side of ChatGPT/Claude data exports is a major source of voice exemplars, and that too goes through review.

**Airlock.** Deterministic scanners (PII, secrets, phone numbers, addresses) plus an LLM sensitivity classifier (third parties, health, finance, relationships, location, confidential work). An item is auto-approved only if **its source is public AND nothing is flagged**. Review actions: approve / edit / re-tier / reject / *never ask about this topic* (which becomes a permanent rule). A deterministic scan runs again right before publish. Published snapshots are versioned so they can be rolled back.

**Review budget.** Compaction ranks candidates by salience (visitor demand from the unknown-question log, kind, novelty, confidence). The weekly review queue is capped (default 25). Items that don't make the cut stay in L0, kept but not published.

**Excluded sources.** Calendar, email, and private chats are too dense with third-party data. Employer workspaces are also excluded.

## 8. Public agent runtime

Stack: Cloudflare Worker · D1 · Vectorize (multilingual embeddings) · Claude Haiku 4.5 for live chat · a Durable Object for per-IP and per-session rate limits and a **$20/month hard budget ledger**.

**Per turn:** gate (rate limits and budget) → context (system prompt + automatically retrieved voice exemplars matched to the message language + page context) → agent loop (at most about 4 tool calls) → answer with citations → canary check → stream.

**Tools:** `recall(query)` (hybrid search; tiers filtered in code; returns `no_match` explicitly) · `competence(topic)` · `search_site(query)` · `navigate(url)` (restricted to an allowlist of the site's own URLs).

**v1 extras:** time-aware memories ("as of…") · confidence-based hedging · an unknown-question log that feeds the next check-in · a canary token (a secret marker; if it ever appears in output, the output is blocked) · a "show your work" trace (tools called, memory IDs and tiers, what was filtered, latency, cost) · page awareness · a freshness notice ("real me last checked in N weeks ago").

**Out of scope:** remembering individual visitors across sessions.

## 9. Voice

Three layers, all of which pass through the airlock:

1. **Style card** (L2): sentence length, EN↔中文 code-switching, humor, characteristic phrases, things the person never says. Regenerated from approved exemplars; the person reviews each change.
2. **Exemplar pool:** retrieved as style few-shots, weighted toward recent text and by source (interview / Slack / the person's own AI-chat messages > AI memory > AI-polished essays, which count as knowledge only).
3. **Phase-2 tuning:** the self-quiz produces *(standin answer, person's correction)* **preference pairs**. Train DPO/LoRA on approved, public-tier data only. A new model is promoted only if it beats the current one on the eval harness. v1 captures the pairs; training comes later.

Excluded: audio voice cloning.

## 10. Evals

Calibration suites: **known** (accuracy and citation correctness) · **known unknowns** (must decline) · **out of competence** (must decline even though the LLM knows the answer) · **not on record** (must not guess) · **boundary** (tier-3 deflection, tier-4 absence) · **extraction** (canary leaks across N attacks) · **voice** (judge plus blind human A/B). The **self-quiz** test-retest agreement score is the headline metric on `/how-it-works`.

The public repo ships a generic attack suite and a demo persona. A person's own boundary cases stay private, because a test such as "refuses to discuss X" reveals that X exists.

## 11. Open-source structure

- **License:** Apache-2.0. **Language:** TypeScript (the schema and policy code are the same locally and at the edge). Python is used only for fine-tuning.
- **Repo (public):** code, schema, generic evals, demo persona. **Instance (private):** `~/.standin/` (or `$STANDIN_HOME`), which holds the SQLite store, config, policy rules, private eval cases, and keys. A CI guard and a pre-commit hook reject any commit that looks like instance data.
- **Model providers** are pluggable. Claude is the default.

```
packages/schema   packages/store   packages/compaction   packages/ingest
packages/airlock  packages/runtime packages/widget       packages/evals
apps/cli          examples/demo-persona                  python/finetune
```

## 12. Sub-projects (build order)

| # | Sub-project | Delivers |
|---|---|---|
| 1 | **Memory core** | Monorepo scaffold, schema, local store, compaction, consolidation, minimal CLI, demo persona |
| 2 | Ingest + airlock | Adapters, scanners, sensitivity classifier, localhost review UI, publish + rollback |
| 3 | Eval harness | Calibration suites, attack suite, self-quiz capture, reports |
| 4 | Public runtime | Worker, tools, policy-in-tools, citations, canary, budget ledger, traces |
| 5 | Website integration | `<standin-chat>` widget, Astro `transition:persist`, `/how-it-works` |
| 6 | Scribe | Weekly scheduled sync, check-in interviews, freshness |
| 7 | Voice tuning | Style card, preference-pair DPO/LoRA, eval-gated promotion |

## 13. Roadmap beyond v1

MCP server / agent-to-agent interface (same tiers, served over a new transport) · audience grants · a "what changed in me" timeline · a break-me challenge page · a friends' Turing test.

## 14. Decisions log

| Decision | Choice | Rejected |
|---|---|---|
| Purpose | Guide to the person and site, plus a showcase; all audiences | Recruiter-only screener |
| Knowledge | Curated, approved memory; the curated store is the privacy boundary | Raw master bank in the prompt |
| Architecture | Compiled memory + agentic retrieval + policy enforced inside tools | Persona-in-prompt; raw-chunk RAG |
| Hosting | Site stays on GitHub Pages; agent on a Cloudflare Worker | Moving the site to Vercel; Supabase |
| Budget | $20/month hard cap | — |
| Live model | Claude Haiku 4.5; Sonnet/Opus as eval comparisons | — |
| Distribution | Open-source framework; the person's own data kept in a private instance | Personal-only build |
| Languages | English and Chinese | — |
| Data sources | Interviews (primary), school/lab/club Slack (the person's own messages), long-form writing (knowledge only), AI memory exports | Private chats, employer workspaces, calendar, email |
| Implementation | Claude implements directly | Codex-as-worker workflow (retired) |
