# Model Routing and Tracing (Private Zone): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution: Claude implements inline (the user's standing choice: no Codex, no subagents).

**Goal:** Every model call goes through a role-based router and leaves an OpenTelemetry-shaped trace. Cost, usage, and run trees become visible through `standin usage`, `standin traces`, and `standin trace`. Traces can optionally be exported over OTLP.

**Architecture:** Two new packages:

- `@standin/trace`: a dependency-free tracer. It uses AsyncLocalStorage for context and ships memory and OTLP/JSON sinks.
- `@standin/models`: the role table resolution, pricing, a traced model wrapper, and a `createModels` factory.

The role table and the `models`/`tracing` config live in `@standin/schema`, so config validation can enforce zones. The store gains span tables, a SQLite sink, and queries. Providers in `@standin/llm` report usage and classify their errors.

**Tech Stack:** Node 24, TypeScript (strict), zod v4, vitest, `node:sqlite`, `node:async_hooks`, `@anthropic-ai/sdk`.

**Spec:** `docs/specs/2026-10-03-model-routing.md` (parent: `docs/specs/2026-10-01-standin-architecture.md`).

## Global Constraints

- **Scope:** private zone only. The D1 sink, the public trace policy, and the widget notice belong to SP4. Escalation belongs to stage 2.
- **Roles:**

  | Role | Tier | Zone |
  |---|---|---|
  | `extract` | large | private |
  | `reconcile` | small | private |
  | `screen` | small | private |
  | `answer` | small | public |
  | `checkin` | medium | private |
  | `quiz` | medium | private |
  | `attack` | medium | private |
  | `style` | large | private |
  | `judge` | large | private |

- **Default tiers:** `small` = `claude-haiku-4-5-20251001`, `medium` = `claude-sonnet-5-5`, `large` = `claude-opus-5-5`.
- **Public-zone roles** must not resolve to a model whose `baseURL` host is `localhost`, in `127.0.0.0/8`, `::1`, `10/8`, `172.16/12`, or `192.168/16`, or ends in `.local`.
- **Span ids:** `traceId` is 32 lowercase hex characters and `spanId` is 16, generated with `crypto.getRandomValues`.
- **Root spans** are named `standin.run` and carry the attribute `standin.run.kind`.
- **Model spans** are named `chat {model}` with kind `client`. Attribute names follow the OTel GenAI semantic conventions (verified in Task 6) plus `standin.role`, `standin.tier`, `standin.cost_usd`, `standin.cache_read_tokens`, `standin.cache_write_tokens`, `standin.batch`, `standin.batch_id`, and `standin.outcome`.
- **Outcomes:** `ok | invalid | refusal | truncated | api_error | unreachable`. `LLMError.kind` uses the same set minus `ok`.
- **Text separation:** prompts and outputs go to `span_content`, never into span attributes. `consolidate` purges `span_content` older than `retentionDays`.
- **OTLP export** is best-effort, waits at most 5 s per run, and excludes `span_content` unless `tracing.otlp.exportContent` is `true`.
- **Prices:** ship defaults only for models whose prices were checked against Anthropic's pricing page during Task 6. An unknown price gives a null cost.
- **Commits:** Mingxi is the author. Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **The `small` tier set to a local Ollama model while `answer` is public.** Config validation fails with a message that names `models.roles.answer` as the fix. It must not fail with an opaque zod error. Tested in Task 5.
2. **OTLP collector unreachable or hanging.** The run still completes and its exit code is unaffected. One warning goes to stderr, and the export gives up within about 5 s. Tested in Task 3 (sink) and Task 8 (CLI).
3. **Spans opened in overlapping async work** (`Promise.all`, interleaved awaits). Each span attaches to the parent that was active where it started, and two concurrent runs never share a trace. Tested in Task 2.
4. **`standin consolidate` purging old trace text.** `standin usage` totals and `standin trace` trees are unchanged afterwards; only the content is gone. Tested in Task 4.
5. **A response from a different model than requested** (server-side fallback) **or a model with no known price.** The span records the response model and costs the call at that model's price. An unknown price gives `cost_usd = null`, and usage totals report the known cost plus the count of unpriced calls instead of silently treating them as $0. Tested in Task 6 and Task 4.

---

### Task 0: Branch setup

- [ ] Work on branch `model-providers` (PR #3), already rebased onto `main` (which has the spec commits). If Mingxi approves merging PR #2 first, rebase onto the new `main` and resolve the conflicts in `apps/cli/src/main.ts` (USAGE), `README.md`, and `apps/cli/test/e2e.test.ts`. Then interview import also gets an `import` run in Task 8.
- [ ] `pnpm install && pnpm typecheck && pnpm test` is green before any change.

### Task 1: `@standin/llm`: usage reporting and error kinds

**Files:** modify `packages/llm/src/{types.ts,anthropic.ts,openai-compatible.ts,scripted.ts,json.ts,index.ts}`; tests in `packages/llm/test/providers.test.ts` and `test/scripted.test.ts`.

**Produces:**
```ts
export type LLMErrorKind = "invalid" | "refusal" | "truncated" | "api_error" | "unreachable";
export class LLMError extends Error { readonly kind: LLMErrorKind; constructor(kind: LLMErrorKind, message: string, options?: { cause?: unknown }) }
export interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
export interface Generation<T> { output: T; usage: Usage; responseModel: string }
/** A concrete model endpoint. Callers that don't need usage keep using LLM.generateObject. */
export interface ModelProvider extends LLM {
  readonly provider: "anthropic" | "openai-compatible" | "scripted";
  readonly model: string;
  generate<T>(req: GenerateObjectRequest<T>): Promise<Generation<T>>;
}
export type BatchOutcome<T> =
  | { ok: true; value: T; usage: Usage; responseModel: string }
  | { ok: false; error: string; kind: LLMErrorKind; usage: Usage | null };
```
- `AnthropicLLM`, `OpenAICompatibleLLM`, and `ScriptedLLM` implement `ModelProvider`. `generateObject` becomes `(await this.generate(req)).output`.
- `createLLM` returns a `ModelProvider`.

**Steps:**

- [ ] Write the failing tests:
  - **Anthropic.** A fake `beta.messages.parse` returns `usage: {input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0}` and `model: "claude-opus-5"`. `generate` returns that usage and `responseModel: "claude-opus-5"`.
  - **Anthropic batch.** Results carry usage and `responseModel` per result.
  - **Error kinds.** A refusal stop gives kind `refusal`. `max_tokens` gives `truncated`. A null `parsed_output` gives `invalid`. An `APIError` gives `api_error`.
  - **OpenAI-compatible.** The response `usage: {prompt_tokens, completion_tokens}` maps to `inputTokens`/`outputTokens` with cache tokens 0. With a repair retry, usage is the sum of both calls. A missing `usage` gives zeros. A 404 gives `api_error`, a fetch failure gives `unreachable`, `finish_reason: "length"` gives `truncated`, and a reply invalid twice gives `invalid`.
  - **Prompt caching (spec §4).** Anthropic requests send `system` as one text block with `cache_control: {type: "ephemeral"}`, in both live and batch requests. The API simply doesn't cache prompts below its minimum length, so this is always safe.
  - **Scripted.** The constructor option `usage?: Partial<Usage>` (default all zeros) is returned by `generate`. `responseModel` is `"scripted"`.
  - **parseJsonOutput.** Throws `LLMError` with kind `invalid`.
- [ ] Run `pnpm vitest run packages/llm` and expect failures (`generate` is undefined).
- [ ] Implement:
  - Add `kind` to every `LLMError` construction site.
  - Anthropic maps `response.usage` (treating null and undefined as 0) and `response.model`.
  - OpenAI-compatible accumulates usage across the repair attempt.
  - `wrapApiError` produces kind `api_error`.
- [ ] Tests pass and `pnpm typecheck` is clean. Commit "Report token usage and classify errors in model providers".

### Task 2: `@standin/trace`: tracer core

**Files:** create `packages/trace/{package.json,src/index.ts,src/ids.ts,src/span.ts,src/tracer.ts,src/memory-sink.ts}`; test `packages/trace/test/tracer.test.ts`. Add the package to `tsconfig.json` and `vitest.config.ts` (both already glob `packages/*`).

**Produces:**
```ts
export type AttrValue = string | number | boolean | string[];
export interface SpanEvent { name: string; time: string; attributes: Record<string, AttrValue> }
export interface SpanData {
  traceId: string; spanId: string; parentSpanId: string | null;
  name: string; kind: "internal" | "client";
  startTime: string; endTime: string;           // ISO-8601 UTC, ms precision
  attributes: Record<string, AttrValue>;
  events: SpanEvent[];
  status: { code: "unset" | "ok" | "error"; message?: string };
}
export type SpanContent = Record<string, unknown>;
export interface SpanSink {
  /** Called once per span when it ends. May be async; the tracer awaits root-span sinks (bounded). */
  onEnd(span: SpanData, content: SpanContent | null): void | Promise<void>;
}
export interface Span {
  readonly traceId: string; readonly spanId: string;
  setAttribute(key: string, value: AttrValue | null | undefined): void;   // null/undefined: no-op
  setAttributes(attrs: Record<string, AttrValue | null | undefined>): void;
  addEvent(name: string, attributes?: Record<string, AttrValue>): void;
  setContent(content: SpanContent): void;   // merged; stored apart from attributes
  setStatus(code: "ok" | "error", message?: string): void;
}
export interface SpanOptions { kind?: "internal" | "client"; attributes?: Record<string, AttrValue | null | undefined>; startTime?: Date }
export interface TracerOptions {
  sinks: SpanSink[];
  clock?: { now(): Date };
  /** Sink failures never fail a run; they are reported here (default: console.error). */
  onSinkError?: (err: unknown, sink: SpanSink) => void;
  /** Max wait for async sinks when a root span ends. Default 5000 ms. */
  flushTimeoutMs?: number;
}
export class Tracer {
  constructor(opts: TracerOptions);
  /** Root span "standin.run" with attribute standin.run.kind; always starts a new trace, even if a span is active. */
  run<T>(kind: string, attributes: Record<string, AttrValue | null | undefined>, fn: (span: Span) => Promise<T>): Promise<T>;
  /** Child of the active span (or a new root if none). Ends the span when fn settles; a thrown error sets status error and is rethrown. */
  span<T>(name: string, opts: SpanOptions, fn: (span: Span) => Promise<T>): Promise<T>;
  active(): Span | null;
}
export const noopTracer: Tracer;   // a Tracer with no sinks
export class MemorySink implements SpanSink { readonly spans: { span: SpanData; content: SpanContent | null }[] }
export function newTraceId(): string;   // 32 hex characters
export function newSpanId(): string;    // 16 hex characters
```

**Steps:**

- [ ] Write the failing tests (`MemorySink`, fixed clock):
  - Ids match `/^[0-9a-f]{32}$/` and `/^[0-9a-f]{16}$/` and are never all zeros.
  - `run("compaction", …)` with two nested `span` calls gives three spans with one traceId. The children's `parentSpanId` points at the right parent across `await`.
  - Concurrency: `Promise.all([tracer.span("a"), tracer.span("b")])` inside one run gives two spans whose parent is the run, not each other. Two concurrent `run` calls give two distinct traceIds with no cross-linking.
  - `fn` throws, so `status.code` is `"error"` with the message, and the error is rethrown.
  - `setContent` data appears in the sink's `content` and not in `attributes`. A span without content delivers `null`.
  - `setAttribute(k, undefined)` is a no-op.
  - A sink that throws or rejects calls `onSinkError`, and `run` still resolves with fn's value.
  - A sink that never resolves: `run` resolves after about `flushTimeoutMs` (use 50 ms in the test) and reports the timeout via `onSinkError`.
  - `active()` is `null` outside any span.
- [ ] Run and see the failures.
- [ ] Implement with `AsyncLocalStorage<SpanImpl>` from `node:async_hooks`.
  - When a span ends, call each sink's `onEnd` inside try/catch.
  - Collect promises returned by sinks for any span of the trace. When the root ends, `await Promise.race([Promise.allSettled(pending), timeout])`.
- [ ] Tests pass. Commit "Add an OpenTelemetry-shaped tracer".

### Task 3: OTLP/HTTP JSON export

**Files:** create `packages/trace/src/otlp.ts`; test `packages/trace/test/otlp.test.ts`.

**Produces:**
```ts
export function toOtlpJson(spans: { span: SpanData; content: SpanContent | null }[], opts: { serviceName: string; serviceVersion: string; includeContent: boolean }): object;
export class OtlpHttpSink implements SpanSink {
  constructor(opts: { endpoint: string; headers?: Record<string, string>; includeContent: boolean; serviceName?: string; fetch?: typeof fetch });
  // Buffers spans by traceId; posts the whole trace when its root span (parentSpanId === null) ends.
}
```

**OTLP mapping:**

- Top level: `{resourceSpans:[{resource:{attributes:[service.name, service.version]}, scopeSpans:[{scope:{name:"standin", version}, spans:[…]}]}]}`.
- Each span: `traceId`/`spanId`/`parentSpanId` as hex strings. `kind` is 1 (internal) or 3 (client). `startTimeUnixNano`/`endTimeUnixNano` are decimal strings (ms × 1e6).
- `attributes` are `[{key, value:{stringValue|intValue(string)|doubleValue|boolValue|arrayValue}}]`. Integers become `intValue` and non-integers `doubleValue`.
- `status`: unset is `{}`, ok is `{code:1}`, error is `{code:2, message}`.
- With `includeContent`, content goes into span attributes `gen_ai.input.messages`, `gen_ai.output.messages`, and `gen_ai.system_instructions`, as JSON strings, when present (keys `prompt`, `output`, `system`). Other content keys go under `standin.content.<key>`.

**Steps:**

- [ ] Write the failing tests:
  - A two-span trace maps to the exact OTLP structure above, including int-vs-double encoding and a `parentSpanId` omitted for the root.
  - Content is excluded by default and included with `includeContent: true`.
  - `OtlpHttpSink` posts once, when the root ends, with header `content-type: application/json` and the configured headers.
  - The sink does not post for child spans alone.
  - A non-2xx response or a fetch rejection rejects the promise returned from `onEnd`. The tracer reports it and the run still succeeds (assert through a Tracer with `onSinkError`).
- [ ] Implement. Tests pass. Commit "Export traces as OTLP/HTTP JSON".

### Task 4: `@standin/store`: span tables, SQLite sink, and queries

**Files:** modify `packages/store/src/{migrations.ts,store.ts,consolidate.ts,index.ts}` and `packages/store/package.json` (depend on `@standin/trace`); create `packages/store/src/spans.ts`; test `packages/store/test/spans.test.ts`; update `test/consolidate.test.ts`.

**Migration 3:**
```sql
CREATE TABLE spans (
  span_id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, parent_span_id TEXT,
  name TEXT NOT NULL, kind TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL,
  status TEXT NOT NULL, status_message TEXT, attributes TEXT NOT NULL, events TEXT NOT NULL
);
CREATE INDEX spans_trace ON spans (trace_id);
CREATE INDEX spans_roots ON spans (start_time) WHERE parent_span_id IS NULL;
CREATE TABLE span_content (
  span_id TEXT PRIMARY KEY REFERENCES spans(span_id), recorded_at TEXT NOT NULL, content TEXT NOT NULL
);
```

**Produces:**
```ts
store.spanSink(): SpanSink;   // synchronous INSERTs; content row only when content !== null
store.usage(opts: { since?: string; by: "role" | "model" }): UsageRow[];
export interface UsageRow { key: string; calls: number; failed: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number; unpricedCalls: number }
store.listRuns(opts: { since?: string; kind?: string; limit?: number }): RunSummary[];
export interface RunSummary { traceId: string; kind: string; startTime: string; durationMs: number; status: "unset" | "ok" | "error"; modelCalls: number; costUsd: number; unpricedCalls: number }
store.getTrace(traceIdOrPrefix: string): { span: SpanData; content: SpanContent | null }[];   // ordered by start_time, span_id; AmbiguousIdError / NotFoundError for prefixes
store.lastTraceId(): string | null;
// ConsolidationReport gains: purgedSpanContent: number
```
- Model-call spans are those whose attributes contain `standin.role`.
- `key` for `by: "model"` is `gen_ai.response.model`, falling back to `gen_ai.request.model`.
- `costUsd` sums non-null `standin.cost_usd`. `unpricedCalls` counts null or missing costs.

**Steps:**

- [ ] Write the failing tests. Feed spans through a `Tracer` with `store.spanSink()`.
  - Rows round-trip: attributes, events, and status survive. Content lives only in `span_content`.
  - `usage({by:"role"})` totals over three model spans (two priced, one unpriced) gives the right sums and `unpricedCalls: 1`. Spans with `standin.outcome != "ok"` count in `failed`.
  - `listRuns` returns one summary per root, newest first. `--kind` filters. Duration and cost aggregate over descendants.
  - `getTrace` works with a full id and with an 8-character prefix. An ambiguous prefix throws `AmbiguousIdError` listing the matches.
  - **Retention.** Advance the clock past `retentionDays`, then `consolidate`: `purgedSpanContent` equals the old content rows. `usage` and `getTrace` structure are unchanged, and the content is `null`.
- [ ] Implement. Tests pass. Commit "Store traces in SQLite with usage and run queries".

### Task 5: `@standin/schema`: roles, `models` and `tracing` config, zone validation

**Files:** create `packages/schema/src/roles.ts`; modify `packages/schema/src/config.ts` and `index.ts`; tests in `packages/schema/test/schema.test.ts`.

**Produces:**
```ts
export type ModelTier = "small" | "medium" | "large";
export const ROLES = {
  extract:   { tier: "large",  zone: "private", purpose: "Extract atomic memories from one observation" },
  reconcile: { tier: "small",  zone: "private", purpose: "Classify a candidate against similar memories" },
  screen:    { tier: "small",  zone: "private", purpose: "Flag possibly sensitive memories for review" },
  answer:    { tier: "small",  zone: "public",  purpose: "Answer a visitor turn" },
  checkin:   { tier: "medium", zone: "private", purpose: "Write follow-up interview questions" },
  quiz:      { tier: "medium", zone: "private", purpose: "Generate self-quiz questions" },
  attack:    { tier: "medium", zone: "private", purpose: "Generate break-me attempts" },
  style:     { tier: "large",  zone: "private", purpose: "Rewrite the style card" },
  judge:     { tier: "large",  zone: "private", purpose: "Grade eval answers" },
} as const satisfies Record<string, { tier: ModelTier; zone: "private" | "public"; purpose: string }>;
export type Role = keyof typeof ROLES;
export const DEFAULT_TIER_MODELS: Record<ModelTier, string>;
export function isPrivateAddress(baseURL: string): boolean;
export function resolveModelRef(config: Config, role: Role): ModelRef;   // roles[role] ?? tiers[ROLES[role].tier]
// Config: remove compaction.model/reconcileModel; add
//   models: { tiers: { small, medium, large: ModelRef (prefault defaults) }, roles: Partial<Record<Role, ModelRef>>, prices: Record<string, Price> }
//   tracing: { otlp?: { endpoint: url, headersEnv?: string, exportContent: boolean (default false) } }
// Price = { inputPerMTok: number >= 0, outputPerMTok: number >= 0, cacheReadPerMTok?: number, cacheWritePerMTok?: number }
```
The memory `Tier` (1–4) already exists, so the model tier is named `ModelTier`.

**Steps:**

- [ ] Write the failing tests:
  - Every role has a tier in `DEFAULT_TIER_MODELS`, a zone, and a non-empty purpose.
  - `parseConfig({persona:{name:"X"}})` fills `models.tiers` with the three defaults, `roles: {}`, `prices: {}`, and `tracing: {}`.
  - `resolveModelRef` resolves a role override before the tier.
  - `isPrivateAddress` is true for `http://localhost:11434/v1`, `http://127.0.0.1`, `http://[::1]:8000`, `http://10.0.0.5`, `http://172.20.1.1`, `http://192.168.1.2`, and `http://box.local`. It is false for `https://api.together.xyz/v1` and `http://172.32.0.1`.
  - **Review Focus 1.** `models.tiers.small` set to a localhost model fails with a message containing `models.roles.answer` and the address. The same config plus `roles.answer: "claude-haiku-4-5-20251001"` parses.
  - An unknown role key in `models.roles` is rejected.
  - `tracing.otlp.endpoint` must be a URL. `headersEnv` follows the env-var-name regex.
- [ ] Implement. Validation uses `superRefine` on the `models` object and iterates the roles with zone `public`.
- [ ] Remove `compaction.model`/`reconcileModel` and update the PR #3 schema tests. `pnpm typecheck` will show the CLI break; that is fixed in Task 8.
- [ ] Tests pass (schema package). Commit "Move model choice to roles and tiers with zone validation".

### Task 6: `@standin/models`: pricing, traced provider, factory

**Files:** create `packages/models/{package.json,src/index.ts,src/pricing.ts,src/traced.ts,src/models.ts}`; tests `packages/models/test/{pricing,traced,models}.test.ts`.

**Produces:**
```ts
export const DEFAULT_PRICES: Record<string, Price>;   // verified entries only, each with a source comment and date
export const CACHE_READ_MULTIPLIER = 0.1; export const CACHE_WRITE_MULTIPLIER = 1.25; export const BATCH_MULTIPLIER = 0.5;   // verify against the pricing page; adjust if it says otherwise
export function priceFor(model: string, overrides: Record<string, Price>): Price | null;   // overrides > defaults; also tries the model id without a -YYYYMMDD suffix
export function costUsd(usage: Usage, price: Price | null, opts: { batch: boolean }): number | null;
export class TracedModel implements BatchLLM {
  constructor(provider: ModelProvider, opts: { role: Role; tier: ModelTier | "override"; tracer: Tracer; prices: Record<string, Price> });
  generateObject<T>(req: GenerateObjectRequest<T>): Promise<T>;   // span "chat {model}", kind client
  // BatchLLM methods delegate when the provider supports batches (otherwise submitBatch throws LLMError "api_error").
  // batchResults(batchId, schema, meta?: { submittedAt?: string }) records one span per outcome (standin.batch = true,
  //   standin.batch_id, startTime = submittedAt) as children of the active span, then returns the outcomes.
}
export interface Models { for(role: Role): TracedModel }
export function createModels(opts: {
  config: Config; env: Record<string, string | undefined>; tracer: Tracer;
  /** Test/demo hook: supply the provider for a role instead of building it from config. */
  providerFor?: (role: Role, ref: ModelRef) => ModelProvider;
}): Models;   // providers built lazily and cached per distinct ModelRef
```
`BatchLLM.batchResults` in `@standin/llm` gains the optional third parameter `meta?: { submittedAt?: string }`, which providers ignore.

**Span attributes for `chat {model}`.** Verify the names against the current OTel GenAI semantic-conventions page before coding; if any name changed, use the current one and note it in the commit message.

- `gen_ai.operation.name = "chat"`
- `gen_ai.provider.name` (`anthropic`, `openai`-compatible as `openai`, `scripted`)
- `gen_ai.request.model`, `gen_ai.response.model`
- `gen_ai.request.max_tokens`
- `gen_ai.output.type = "json"`
- `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`
- `standin.role`, `standin.tier`, `standin.purpose` (`req.purpose`)
- `standin.cost_usd` (omitted when null)
- `standin.cache_read_tokens`, `standin.cache_write_tokens`
- `standin.batch`, `standin.outcome`
- On error: `error.type` = the `LLMError` kind.
- Content: `{ system: req.system, prompt: req.prompt, output }`, and on failure `{ system, prompt, error: message }`.

**Steps:**

- [ ] Fetch Anthropic's pricing page and the OTel GenAI span conventions page. Record the verified per-MTok prices for the three default-tier models, plus the cache and batch multipliers, in `pricing.ts` with the date. Any model whose price isn't on the page gets no entry.
- [ ] Write the failing tests:
  - **Cost math.** 1M input and 1M output tokens at a test price `{2, 10}` cost 12. Cache-read tokens are priced at 0.1× input and cache-write at 1.25× (or the verified values). Batch halves the total. A `null` price gives `null`. `priceFor("claude-haiku-4-5-20251001")` falls back to `claude-haiku-4-5` if only that key exists. Overrides win.
  - **TracedModel success.** With a scripted provider reporting usage, `responseModel` differs from the request model (Review Focus 5). The span name uses the request model. `gen_ai.response.model` is the response model, and the cost uses the response model's price. Content is stored. `outcome = ok`.
  - **TracedModel failure.** The provider throws an `LLMError` with kind `refusal`. The span has status error, `standin.outcome = "refusal"`, and content with `error`. The error is rethrown unchanged.
  - **Batch results.** `submittedAt` becomes the span `startTime`. One span per outcome. Failed outcomes get their kind.
  - **createModels.** `for("reconcile")` uses the small tier, and a role override wins. Calling `for` twice for roles with the same ref builds the provider once. A missing `apiKeyEnv` throws only when the role is first used, not at construction.
- [ ] Implement. Tests pass. Commit "Add role-based model router with traced, priced calls".

### Task 7: Compaction: roles and spans

**Files:** modify `packages/compaction/src/{compact.ts,batch.ts}` and `packages/compaction/package.json` (depend on `@standin/trace`); tests in `packages/compaction/test/{compact,batch}.test.ts`.

**Produces:**
- `CompactOptions` and `CompactBatchOptions` gain `tracer?: Tracer` (default `noopTracer`). `llm`/`reconcileLLM` are unchanged (callers pass `models.for("extract")` and `models.for("reconcile")`).
- `compact()` wraps its work in `tracer.run("compaction", { "standin.compaction.mode": "live" }, …)`. The root gets `standin.compaction.processed`/`.failed`/`.created` at the end.
- Each observation runs inside `tracer.span("compaction.observation", { attributes: { "standin.observation.id", "standin.observation.source": sourceKind } })`. The store transaction runs inside `tracer.span("store.apply", …)`.
- `compactBatch` uses mode `"batch-submit"` or `"batch-collect"`. Collection passes `{ submittedAt: open.submittedAt }` to `batchResults`.

**Steps:**

- [ ] Write the failing tests:
  - Use a `MemorySink` tracer and a scripted LLM wrapped in `TracedModel` (role `extract`/`reconcile`).
  - Compacting two observations gives one trace: root → 2 × `compaction.observation` → (`chat scripted`, `store.apply`). Reconcile spans appear under the observation that triggered them.
  - A failing observation's span has status error. The root has `standin.compaction.failed = 1`.
  - Batch collect: extraction spans carry `standin.batch = true` and start at the batch's `submittedAt`.
  - Without a tracer, behavior is unchanged: the existing tests pass untouched.
- [ ] Implement. Tests pass. Commit "Trace compaction runs".

### Task 8: CLI: wiring, `usage`, `traces`, `trace`; docs

**Files:** create `apps/cli/src/runtime.ts` and `apps/cli/src/commands/{usage,traces}.ts` (`trace` lives in `traces.ts`); modify `apps/cli/src/commands/{compact.ts,index.ts,consolidate.ts}`, `apps/cli/src/main.ts` (USAGE), `apps/cli/package.json`, `README.md`, and `apps/cli/test/e2e.test.ts`.

**Produces:**
```ts
// runtime.ts
export function instanceTracer(ctx: CommandContext, store: Store, config: Config): Tracer;
//   sinks: store.spanSink() plus OtlpHttpSink when config.tracing.otlp is set
//   (headers from env[headersEnv], parsed as "k=v,k2=v2"); onSinkError writes one "warning: trace export failed: …" line to stderr
export function instanceModels(ctx: CommandContext, config: Config, tracer: Tracer, opts: { demo: boolean }): Models;
//   demo: providerFor returns one shared demoLLM() for every role
export function renderTraceTree(spans: { span: SpanData; content: SpanContent | null }[]): string;
//   one line per span, indented by depth: name · duration · model · in/out tokens · $cost · ✗ on error
```

**Commands:**

- `standin usage [--since ISO] [--by role|model] [--json]`: a table with columns key, calls, failed, in, out, cache read, cost, unpriced. Then a total line, and the note "N calls have no known price" when N > 0.
- `standin traces [--since ISO] [--kind K] [--limit N] [--json]`: one line per run.
- `standin trace <id|prefix> | --last [--content] [--json]`: the tree. `--content` prints each span's stored content under it.

**Steps:**

- [ ] Write the failing e2e tests:
  - `init --demo`, then `compact --demo-llm`, then `traces` lists one `compaction` run.
  - `trace --last` shows `standin.run`, `compaction.observation`, `chat`, and `store.apply` lines.
  - `usage --by role` shows rows for `extract` and `reconcile` with call counts that match the compaction (demo usage is zero tokens and `$0` because the scripted price is unknown, so `unpriced` is the call count).
  - `--json` variants parse.
  - `trace nope` exits 1 with "not found".
  - **OTLP (Review Focus 2).** Set `tracing.otlp.endpoint` to `http://127.0.0.1:9/v1/traces` in config.json. `compact --demo-llm` exits 0, and stderr has exactly one `warning: trace export failed` line.
  - `consolidate --json` includes `purgedSpanContent`.
- [ ] Implement:
  - `compact` uses `instanceModels(…).for("extract"/"reconcile")` and `instanceTracer`.
  - Remove PR #3's `models()` helper.
  - Keep `--batch` and the error "needs a provider with a batch API".
- [ ] README: replace the "Choosing models" section with roles and tiers (the role table, the config example from the spec, the zone rule) and add an "Observability" section: `usage`/`traces`/`trace`, OTLP export to Langfuse/Phoenix/Jaeger, and the content-export default.
- [ ] Run `pnpm typecheck && pnpm test && pnpm guard`. Then a manual smoke test against a temp `STANDIN_HOME`: `init --demo`, `compact --demo-llm`, `trace --last`, `usage`. Commit "Add usage and trace commands; route compaction through roles".

### Task 9: Finish

- [ ] Self-review the branch diff against the spec (§3–§7) and the Review Focus. Fix anything that drifted.
- [ ] Optional live check, only if credentials exist:
  ```bash
  STANDIN_LIVE=1 pnpm test
  ```
  Also re-run the local Ollama live test.
- [ ] Push `model-providers`. Update the PR #3 title and body to "Models and tracing: per-role routing, OpenAI-compatible provider, batch compaction, OTel-shaped traces". The body lists what changed and the test plan, and ends with the Claude Code line.
