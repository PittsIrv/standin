# Model routing: right-sized models per task

Status: design approved in conversation 2026-10-03 (sections 1–2). Section 5, error handling and testing, has not been reviewed yet.
Builds on: [architecture spec](2026-10-01-standin-architecture.md) and PR #3 (per-stage models, OpenAI-compatible provider, batch compaction).

## 1. Goal

Keep the whole agent system cheap without making it worse. Each task uses the cheapest thing that does the job well: code, then a cache, then a small model, then a medium one, then a large one.

The work comes in two stages (decision C):

- **Stage 1 (this spec):** a fixed model assignment per task, a router that every call goes through, and a usage ledger.
- **Stage 2 (after the SP3 eval harness):** escalation from a small model to a larger one when the small one is unsure or its output is invalid. Its thresholds are set by evals. The resulting cost-vs-quality comparison goes on `/how-it-works` as part of the showcase.

Constraints:

- The public agent's $20/month cap stays a hard limit.
- Disclosure safety must never depend on model size. Policy is enforced in tools and data (architecture §3, principle 2), which is what makes small models safe in the public path.

## 2. Approach

Approach 2 was chosen: **task roles → tiers → models.**

- The code declares named roles. Each role has a default tier and a zone.
- Config maps each tier to a concrete model and can override any single role.

Rejected alternatives:

- **A model field per call site.** Config sprawls, and there is no shared notion of difficulty for stage 2 to build on.
- **An external gateway** such as LiteLLM or Cloudflare AI Gateway doing the routing. It cannot escalate on signals only standin knows, like grounding or citations, and it adds a moving part to both zones. In the public zone, AI Gateway may still be used as plain transport for caching and logs.

## 3. Roles

Default tiers: `small` = `claude-haiku-4-5-20251001`, `medium` = `claude-sonnet-5-5`, `large` = `claude-opus-5-5`.

| Role | Subsystem | Frequency | Tier | Zone | Rationale |
|---|---|---|---|---|---|
| `extract` | compaction | per observation | large | private | The hardest task. Errors become review work, and review time is the bottleneck |
| `reconcile` | compaction | per candidate with neighbors | small | private | A short four-way classification |
| `screen` | airlock | per proposed memory | small | private | Runs after the regex scanners. It only flags; the person decides. The prompt favors recall |
| `answer` | runtime | per visitor turn | small | public | Fits the $20 cap. Disclosure is enforced in tools. Stage 2 escalates it |
| `checkin` | scribe | weekly | medium | private | Writes follow-up interview questions from the unknown-question log and stale memories |
| `quiz` | voice | rare | medium | private | Generates self-quiz questions |
| `attack` | evals | rare | medium | private | Generates break-me attempts |
| `style` | voice | rare | large | private | Rewrites the style card |
| `judge` | evals | offline, batched | large | private | The grader must be stronger than the model it grades |

These never call a model:

- **Navigation intents:** handled by deterministic tools.
- **Citation checks:** every cited memory id must be in the set the tools returned.
- **Exact-duplicate observations:** caught by the content hash.
- **Reconciling a candidate that has no neighbors:** recorded as `new` without a call. This already holds.
- **Repeated visitor questions:** answered from a semantic cache using Workers AI embeddings. This is built in SP4.

**Zones.** A role's zone limits which models it can use. Public-zone roles run on the Cloudflare Worker, so config validation rejects any model whose `baseURL` is a loopback or private address (localhost, 127.0.0.0/8, ::1, 10/8, 172.16/12, 192.168/16, `*.local`). Private-zone roles may use anything, including Ollama.

The role table lives in code, not config. Adding a role is a reviewed change.

## 4. Call path, config, and ledger

```
code → models.for(role) → resolve(role): roles[role] override ?? tiers[ROLES[role].tier]
                        → provider call → ledger row → result
```

Config (`$STANDIN_HOME/config.json`). Each value is a model reference as defined in PR #3: either a bare Anthropic id or `{provider, model, baseURL, apiKeyEnv, structuredOutput}`.

```jsonc
"models": {
  "tiers": { "small": "claude-haiku-4-5-20251001", "medium": "claude-sonnet-5-5", "large": "claude-opus-5-5" },
  "roles": { "reconcile": { "provider": "openai-compatible", "baseURL": "http://localhost:11434/v1", "model": "qwen3:8b" } },
  "prices": { "qwen3:8b": { "inputPerMTok": 0, "outputPerMTok": 0 } }
}
```

PR #3's `compaction.model` and `compaction.reconcileModel` move into `models` before PR #3 merges, so no released config uses the old shape.

**Usage reporting.** Providers report usage with each result: input, output, cache-read, and cache-write tokens. The Anthropic adapter reads these from the API response. The OpenAI-compatible adapter reads `usage` when the server sends it.

**Ledger.** One row per model call:

| Field | Notes |
|---|---|
| `role`, `tier`, `provider`, `model` | |
| `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` | |
| `cost_usd` | Null when the price is unknown |
| `latency_ms` | |
| `batch` | true for calls answered through the batch API |
| `outcome` | `ok`, `invalid`, `refusal`, `truncated`, `api_error`, or `unreachable` |
| `at` | |

Where the rows go:

- **Private zone:** a SQLite table in the instance store. For batch extraction, rows are written when results are collected, priced at the batch rate.
- **Public zone (SP4):** the same row shape, written through a sink interface into the Durable Object budget ledger.

**Prices.** Defaults ship for known models. Config `models.prices` overrides them, since prices change. For an unknown model the row keeps its token counts and leaves `cost_usd` empty. Cache reads and writes are priced at their own multipliers.

**CLI.** `standin usage [--since ISO] [--by role|model] [--json]` shows calls, tokens, and cost.

**Provider-level savings:**

- Prompt caching on system prompts long enough to qualify.
- Batch mode remains a per-call option, which compaction already uses.

## 5. Error handling and testing (not yet reviewed)

Errors:

- **Unknown role:** caught at compile time, because `Role` is a string-literal union taken from the role table.
- **Tier missing from config:** the default for that tier is used.
- **Public role resolving to a local or private model:** a config error naming the role and the address.
- **Provider failure:** surfaces as `LLMError`, as it does today, and the ledger row records the outcome kind.
- **Private-zone ledger write failure:** reported on stderr; the model result is still returned. Usage reporting must not block compaction.
- **Public-zone ledger write failure (SP4):** fails closed. With no ledger there is no call, because the budget can't be enforced.

Tests:

- Every role has a tier, a zone, and a purpose. Every default tier resolves.
- Resolution order: role override, then tier mapping, then default.
- Public-zone validation, with each private address range covered.
- Ledger rows from a scripted provider that reports fake usage, including failed calls and batch rows.
- Cost math: per-MTok prices, cache multipliers, the batch discount, and a null cost for unknown models.
- `standin usage` end to end on the demo persona.

## 6. Stage 2 sketch (not built now)

Each role gets an optional escalation policy: `{ escalateTo: tier, on: ["invalid", "refusal", "unsure"] }`.

- **"Unsure"** is role-specific. For `answer`, it means the reply cites no approved memory for a question the router classed as about the person. For `screen`, it means a borderline confidence score.
- **Thresholds** are tuned on the SP3 eval suites.
- **Showcase:** a cost-per-correct-answer chart on `/how-it-works` comparing all-large, all-small, and the cascade.

## 7. Out of scope

- Escalation (stage 2).
- A spending cap in the private zone; it only reports.
- The semantic cache (SP4).
- A learned router.
