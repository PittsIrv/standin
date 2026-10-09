import { describe, expect, it } from "vitest";
import { OtlpHttpSink, toOtlpJson, Tracer, type SpanContent, type SpanData } from "../src/index.ts";

const root: SpanData = {
  traceId: "0af7651916cd43dd8448eb211c80319c",
  spanId: "b7ad6b7169203331",
  parentSpanId: null,
  name: "standin.run",
  kind: "internal",
  startTime: "2026-10-07T12:00:00.000Z",
  endTime: "2026-10-07T12:00:01.500Z",
  attributes: { "standin.run.kind": "compaction" },
  events: [],
  status: { code: "unset" },
};
const chat: SpanData = {
  ...root,
  spanId: "00f067aa0ba902b7",
  parentSpanId: "b7ad6b7169203331",
  name: "chat claude-opus-5-5",
  kind: "client",
  startTime: "2026-10-07T12:00:00.250Z",
  endTime: "2026-10-07T12:00:01.000Z",
  attributes: { "gen_ai.usage.input_tokens": 1200, "standin.cost_usd": 0.0123, "standin.batch": false, "tags": ["a", "b"] },
  events: [{ name: "retry", time: "2026-10-07T12:00:00.500Z", attributes: { attempt: 2 } }],
  status: { code: "error", message: "refused" },
};
const content: SpanContent = { system: "Extract.", prompt: "I moved to Pittsburgh.", output: { city: "Pittsburgh" }, note: "x" };

describe("toOtlpJson", () => {
  const spans = [
    { span: chat, content },
    { span: root, content: null },
  ];

  it("maps spans to OTLP/JSON", () => {
    const json = toOtlpJson(spans, { serviceName: "standin", serviceVersion: "0.1.0", includeContent: false }) as any;
    const rs = json.resourceSpans[0];
    expect(rs.resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "standin" } },
      { key: "service.version", value: { stringValue: "0.1.0" } },
    ]);
    expect(rs.scopeSpans[0].scope).toEqual({ name: "standin", version: "0.1.0" });
    const [c, r] = rs.scopeSpans[0].spans;
    expect(r).toEqual({
      traceId: root.traceId,
      spanId: root.spanId,
      name: "standin.run",
      kind: 1,
      startTimeUnixNano: "1791374400000000000",
      endTimeUnixNano: "1791374401500000000",
      attributes: [{ key: "standin.run.kind", value: { stringValue: "compaction" } }],
      events: [],
      status: {},
    });
    expect(c.parentSpanId).toBe(root.spanId);
    expect(c.kind).toBe(3);
    expect(c.attributes).toEqual([
      { key: "gen_ai.usage.input_tokens", value: { intValue: "1200" } },
      { key: "standin.cost_usd", value: { doubleValue: 0.0123 } },
      { key: "standin.batch", value: { boolValue: false } },
      { key: "tags", value: { arrayValue: { values: [{ stringValue: "a" }, { stringValue: "b" }] } } },
    ]);
    expect(c.events).toEqual([
      { name: "retry", timeUnixNano: "1791374400500000000", attributes: [{ key: "attempt", value: { intValue: "2" } }] },
    ]);
    expect(c.status).toEqual({ code: 2, message: "refused" });
  });

  it("adds content only when asked", () => {
    const keysOf = (includeContent: boolean) =>
      ((toOtlpJson(spans, { serviceName: "s", serviceVersion: "v", includeContent }) as any).resourceSpans[0].scopeSpans[0].spans[0].attributes as {
        key: string;
        value: { stringValue?: string };
      }[]);
    expect(keysOf(false).map((a) => a.key)).not.toContain("gen_ai.input.messages");
    const withContent = keysOf(true);
    const get = (k: string) => withContent.find((a) => a.key === k)?.value.stringValue;
    expect(get("gen_ai.system_instructions")).toBe(JSON.stringify("Extract."));
    expect(get("gen_ai.input.messages")).toBe(JSON.stringify("I moved to Pittsburgh."));
    expect(get("gen_ai.output.messages")).toBe(JSON.stringify({ city: "Pittsburgh" }));
    expect(get("standin.content.note")).toBe(JSON.stringify("x"));
  });

  it("maps ok status to code 1", () => {
    const ok = toOtlpJson([{ span: { ...root, status: { code: "ok" } }, content: null }], { serviceName: "s", serviceVersion: "v", includeContent: false }) as any;
    expect(ok.resourceSpans[0].scopeSpans[0].spans[0].status).toEqual({ code: 1 });
  });
});

describe("OtlpHttpSink", () => {
  function fakeFetch(respond: () => Response | Promise<Response>) {
    const posts: { url: string; headers: Record<string, string>; body: any }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      posts.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
      return respond();
    }) as unknown as typeof globalThis.fetch;
    return { fetch, posts };
  }

  it("posts the whole trace once, when its root ends", async () => {
    const { fetch, posts } = fakeFetch(() => new Response("{}", { status: 200 }));
    const sink = new OtlpHttpSink({ endpoint: "http://collector:4318/v1/traces", headers: { "x-api-key": "k" }, includeContent: false, fetch });
    const tracer = new Tracer({ sinks: [sink] });
    await tracer.run("compaction", {}, async () => {
      await tracer.span("a", {}, async () => {});
      await tracer.span("b", {}, async () => {});
      expect(posts).toHaveLength(0);
    });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("http://collector:4318/v1/traces");
    expect(posts[0]!.headers).toMatchObject({ "content-type": "application/json", "x-api-key": "k" });
    expect(posts[0]!.body.resourceSpans[0].scopeSpans[0].spans.map((s: { name: string }) => s.name)).toEqual(["a", "b", "standin.run"]);
  });

  it("reports export failures without failing the run", async () => {
    for (const respond of [() => new Response("nope", { status: 503 }), () => Promise.reject(new TypeError("fetch failed"))]) {
      const { fetch } = fakeFetch(respond);
      const errors: unknown[] = [];
      const tracer = new Tracer({ sinks: [new OtlpHttpSink({ endpoint: "http://x/v1/traces", includeContent: false, fetch })], onSinkError: (e) => errors.push(e) });
      await expect(tracer.run("compaction", {}, async () => "ok")).resolves.toBe("ok");
      expect(errors).toHaveLength(1);
      expect(String((errors[0] as Error).message)).toMatch(/503|fetch failed/);
    }
  });

  it("aborts a hanging export after its timeout so the process can exit", async () => {
    const fetch = ((_url: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("export aborted"))))) as unknown as typeof globalThis.fetch;
    const sink = new OtlpHttpSink({ endpoint: "http://blackhole/v1/traces", includeContent: false, fetch, timeoutMs: 30 });
    const started = Date.now();
    await expect(sink.onEnd({ ...root }, null)).rejects.toThrow("export aborted");
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
