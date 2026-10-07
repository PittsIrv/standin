# Model routing and tracing: right-sized models, observable runs

Status: decisions approved in conversation on 2026-10-03 and 2026-10-04 (all logged in §9). The whole document is awaiting written-spec review.
Builds on: [architecture spec](2026-10-01-standin-architecture.md) and PR #3 (per-stage models, OpenAI-compatible provider, batch compaction).

## 1. Goal

standin should be a showcase of agent infrastructure. Two capabilities support that:

1. **Right-sized models.** Each task uses the cheapest thing that does the job well. The order of preference is code, then a cache, then a small model, then a medium model, then a large model.
2. **Observable runs.** Every compaction run, visitor turn, and eval run produces a trace. A trace is a tree of steps: model calls, tool calls, retrieval, and policy checks. Traces follow the OpenTelemetry data model and the GenAI semantic conventions. Cost reports, the public "show your work" panel, eval debugging, and the stage-2 routing chart are all views over these traces.

The work happens in two stages:

- **Stage 1 (this spec):** a fixed model per task, one router, a tracer, and usage reports.
- **Stage 2 (after the SP3 eval harness):** escalation from small to large models. Its thresholds are set by evals. Its cost-vs-quality chart goes on `/how-it-works`.

Constraints:

- The public agent's $20/month cap stays a hard limit.
- Disclosure safety never depends on model size. Policy is enforced in tools and data (architecture §3, principle 2), which is why small models are safe in the public path.
- Traces must not become a second copy of private data that outlives the retention rules (§6).

## 2. Approach

**Routing.** Task roles map to tiers, and tiers map to models. The code declares named roles, each with a default tier and a zone. Config maps each tier to a concrete model and may override any role.

Rejected alternatives:

- **A model field per call site.** Config sprawls, and there is no shared notion of difficulty for stage 2 to build on.
- **An external gateway** (LiteLLM, AI Gateway). It cannot escalate on standin-specific signals, it adds a moving part to both zones, and the routing becomes someone else's product. AI Gateway may still sit underneath the public zone as transport.

**Tracing.** A small tracer of our own emits OpenTelemetry-shaped data: W3C trace and span ids, a parent/child tree, and `gen_ai.*` attribute names. Outputs are pluggable: SQLite, D1, and optionally OTLP/HTTP JSON for Langfuse, Phoenix, or Jaeger. The same code runs in Node and in Cloudflare Workers, and it has no OpenTelemetry dependency.

Rejected alternatives:

- **The official OTel SDK.** It needs two runtime setups (the Node SDK plus a Workers adapter) and heavy dependencies for what is mostly writing rows.
- **Implementing `@opentelemetry/api`.** This would be the most standard option, but it means more surface than we need now. It stays possible later, because only the tracer module would change.
- **A vendor SDK such as Langfuse.** This adds a service dependency to self-hosting. OTLP export already reaches those tools.

## 3. Roles

Default tiers: `small` = `claude-haiku-4-5-20251001`, `medium` = `claude-sonnet-5-5`, `large` = `claude-opus-5-5`.

| Role | Subsystem | Frequency | Tier | Zone | Rationale |
|---|---|---|---|---|---|
| `extract` | compaction | per observation | large | private | The hardest task. Its errors become review work, and review time is the bottleneck. |
| `reconcile` | compaction | per candidate with neighbors | small | private | A short four-way classification. |
| `screen` | airlock | per proposed memory | small | private | Runs after the regex scanners. It only flags; the person decides. Its prompt is biased toward recall. |
| `answer` | runtime | per visitor turn | small | public | Fits the $20 cap. Disclosure is enforced in tools. Stage 2 escalates it. |
| `checkin` | scribe | weekly | medium | private | Writes follow-up interview questions from unanswered questions and stale memories. |
| `quiz` | voice | rare | medium | private | Generates self-quiz questions. |
| `attack` | evals | rare | medium | private | Generates break-me attempts. |
| `style` | voice | rare | large | private | Rewrites the style card. |
| `judge` | evals | offline, batched | large | private | The grader must be stronger than the model it grades. |

These cases never call a model:

- navigation intents (deterministic tools)
- citation checks (every cited memory id must be in the set the tools returned)
- exact-duplicate observations (content hash)
- reconciling a candidate with no neighbors (already the case)
- repeated visitor questions, which are answered from a semantic cache (SP4)

**Zones.** Public-zone roles run on the Worker. Config validation rejects any public-role model whose `baseURL` is a loopback or private address: localhost, 127.0.0.0/8, ::1, 10/8, 172.16/12, 192.168/16, or `*.local`. Private-zone roles may use any model, including Ollama.

The role table lives in code, so adding a role is a reviewed change. `Role` is a string-literal union derived from that table.

## 4. Call path and config

```
code → models.for(role) → resolve: roles[role] ?? tiers[ROLES[role].tier] ?? default
                        → span "chat {model}" (child of the active span)
                        → provider.generate(req) → { output, usage, responseModel }
                        → span attributes: usage, cost, outcome → return output
```

Callers keep the existing `LLM.generateObject(req) → T` interface. The traced wrapper calls the provider's usage-reporting method and records the span.

Config (`$STANDIN_HOME/config.json`). Each value is a model reference as defined in PR #3: a bare Anthropic id or `{provider, model, baseURL, apiKeyEnv, structuredOutput}`.

```jsonc
"models": {
  "tiers": { "small": "claude-haiku-4-5-20251001", "medium": "claude-sonnet-5-5", "large": "claude-opus-5-5" },
  "roles": { "reconcile": { "provider": "openai-compatible", "baseURL": "http://localhost:11434/v1", "model": "qwen3:8b" } },
  "prices": { "qwen3:8b": { "inputPerMTok": 0, "outputPerMTok": 0 } }
},
"tracing": {
  "otlp": { "endpoint": "http://localhost:4318/v1/traces", "exportContent": false }   // optional
}
```

PR #3's `compaction.model` and `compaction.reconcileModel` move into `models` before PR #3 merges, so no released config uses the old shape.

**Pricing.** Default prices ship only for models whose prices were checked against Anthropic's pricing page at implementation time. Config `models.prices` overrides them. For an unknown price, the cost is null and the tokens are still recorded. Cache reads, cache writes, and the batch discount are priced separately.

**Provider-level savings.** Prompt caching applies to system prompts long enough to qualify. Batch mode stays a per-call option.

## 5. Traces

**Span model.** Each span records:

- `traceId` (32 hex characters) and `spanId` (16 hex characters)
- `parentSpanId`
- `name` and `kind` (`internal` or `client`)
- start and end times
- attributes
- `status`: `ok`, or `error` with a message
- events

**Run kinds.** Each run has one root span, named `standin.run` and carrying the attribute `standin.run.kind`:

| Kind | Contents |
|---|---|
| `compaction` | one child per observation, then model calls and store writes |
| `import` | interview or ingest imports |
| `turn` | one visitor turn (SP4) |
| `eval` | one eval case (SP3) |

**Model-call spans.** The span is named `chat {model}`. It carries the GenAI semantic-convention attributes (operation name, provider, request and response model, input and output tokens, and `gen_ai.usage.cache_read.input_tokens` / `gen_ai.usage.cache_write.input_tokens`; per the Anthropic conventions, input tokens include cached tokens) plus:

- `standin.role`
- `standin.tier`
- `standin.cost_usd`
- `standin.batch`
- `standin.outcome`: `ok`, `invalid`, `refusal`, `truncated`, `api_error`, or `unreachable`

`LLMError` gains a `kind` field so the outcome is classified at the source.

**Tool spans** (SP4) are named `execute_tool {name}` and carry the tool name, the ids of the memories returned, and the policy decision.

**Context propagation.** `AsyncLocalStorage` (Node, and Workers with `nodejs_compat`) holds the active span. Functions do not take a span parameter.

**Text content.** Prompts, outputs, and tool inputs and outputs are stored apart from the span rows, in a separate `span_content` table. Retention and export can then treat text differently from structure (§6).

**Sinks.**

| Sink | Behavior |
|---|---|
| SQLite (private) | Writes when a span ends. |
| D1 (public, SP4) | Writes when a span ends. |
| Memory | Used in tests. |
| OTLP/HTTP JSON | Exports when a run ends. Best-effort: a failure is reported but never fails the run. Text is excluded unless `exportContent: true`. |

**Batch calls.** Spans for batched extraction are written at collection time. They carry `standin.batch = true` and `standin.batch_id`, and they start at submission time.

**Views and CLI.**

- `standin usage [--since ISO] [--by role|model] [--json]`: calls, tokens, and cost, computed as a query over model-call spans.
- `standin traces [--since ISO] [--kind K]`: lists runs.
- `standin trace <id | --last>`: renders the span tree in the terminal with durations, models, tokens, and cost. A web trace view belongs to the SP2 localhost review UI.

## 6. Data retention and privacy

**Private zone.**

- Span structure is kept, because cost history needs it.
- `span_content` is purged by `standin consolidate` on the same `retentionDays` schedule as raw observation text (default 90 days). No trace text outlives its source.

**Public zone.** This is decided now and built in SP4.

- **Always kept:** structure only (tools used, published memory ids, cost, outcome). No visitor text, and no IP address in traces.
- **Unanswered or deflected questions:** only the question itself is kept. The scanners strip emails, phone numbers, and names. The question goes to the person's review inbox and expires after 30 days unless the person keeps it. The person decides whether it becomes a check-in question or an eval case.
- **Attack attempts:** only the flagged message is kept, for the break-me suite.
- **Whole conversations:** kept only when the visitor presses "send this conversation to Mingxi", which is also the handoff to the real person.
- The widget states the policy in one line.
- The public "show your work" panel is built only from public material: tool steps, published memory ids, and the answer. It never shows the prompt.
- **Export:** OTLP export never includes text unless `exportContent: true` is set.

## 7. Errors and testing

**Errors.**

| Situation | Behavior |
|---|---|
| Unknown role | Compile-time error. |
| Tier missing from config | Falls back to the default model for that tier. |
| Public role resolving to a local or private model | Config error naming the role and the address. |
| Provider failure | Raises `LLMError` with a `kind`. The span records the outcome and an error status. |
| Private-zone span write failure | Reported on stderr. The model result is still returned. |
| Public-zone span write failure (SP4) | Fails closed. Without a written span there is no budget accounting, so the model call does not happen. |
| OTLP export failure | Reported. Never fails the run. |

**Tests.**

- The role table: every role has a tier, a zone, and a purpose.
- Resolution order: role override, then tier, then default.
- Public-zone validation, covering every private address range.
- Tracer behavior:
  - parent/child nesting across `await`
  - concurrent runs don't cross-link
  - error status on a thrown exception
  - ids are well-formed
- Model-call spans from a scripted provider that reports fake usage. Covers failures by kind and batch spans.
- Cost math: per-MTok rates, cache multipliers, the batch discount, and a null cost for an unknown price.
- Retention: `consolidate` purges old `span_content` and keeps span rows.
- An OTLP JSON payload checked against the OTLP schema shape. Text appears only when `exportContent` is set.
- End to end: `standin compact --demo-llm`, then `standin trace --last` and `standin usage`.

## 8. Stage 2 sketch (not built now)

Each role gets an optional escalation policy: `{ escalateTo: tier, on: ["invalid", "refusal", "unsure"] }`.

"Unsure" is defined per role:

- `answer`: the answer cites no approved memory for a question that is about the person.
- `screen`: a borderline score.

Thresholds come from the SP3 suites. The showcase is a cost-per-correct-answer chart comparing all-large, all-small, and the cascade, computed from traces.

## 9. Decisions log

| # | Decision | Choice | Rejected |
|---|---|---|---|
| 0 | Staging | Fixed assignment now; escalation after evals | Escalation without measurement |
| 1 | Routing mechanism | Roles → tiers → models in our own router | Per-call-site fields; external gateway |
| 2 | Observability | OpenTelemetry-shaped traces; usage is a view over them | Flat usage ledger; vendor SDK |
| 3 | Tracer implementation | Own small tracer that emits OTel-shaped data, with SQLite, D1, and OTLP sinks | Official OTel SDK; implementing `@opentelemetry/api` |
| 4 | Trace text | Stored apart from structure. Private text follows the 90-day retention. Public text is minimal (scrubbed unanswered questions, attack flags, visitor-sent conversations). Export excludes text by default. | No text at all; full conversations for N days |

## 10. Out of scope

- escalation (stage 2)
- a spending cap in the private zone (stage 1 only reports usage)
- the semantic cache (SP4)
- a learned router
- a web trace viewer (SP2 UI)
- the public sinks and widget notice, which are specified here and built in SP4
