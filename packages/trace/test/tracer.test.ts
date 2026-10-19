import { describe, expect, it } from "vitest";
import { MemorySink, newSpanId, newTraceId, Tracer, type SpanSink } from "../src/index.ts";

const clock = { now: () => new Date("2026-10-07T12:00:00.000Z") };
const tick = () => new Promise((r) => setTimeout(r, 1));

function setup(extra: SpanSink[] = [], opts: { flushTimeoutMs?: number } = {}) {
  const sink = new MemorySink();
  const errors: unknown[] = [];
  const tracer = new Tracer({ sinks: [sink, ...extra], clock, onSinkError: (e) => errors.push(e), ...opts });
  const byName = (name: string) => sink.spans.find((s) => s.span.name === name)!.span;
  return { tracer, sink, errors, byName };
}

describe("ids", () => {
  it("are W3C-shaped and never all zeros", () => {
    for (let i = 0; i < 50; i++) {
      expect(newTraceId()).toMatch(/^[0-9a-f]{32}$/);
      expect(newSpanId()).toMatch(/^[0-9a-f]{16}$/);
      expect(newTraceId()).not.toMatch(/^0+$/);
    }
  });
});

describe("Tracer", () => {
  it("nests spans across awaits under one trace", async () => {
    const { tracer, sink, byName } = setup();
    const result = await tracer.run("compaction", { "standin.compaction.mode": "live" }, async () => {
      await tracer.span("outer", {}, async () => {
        await tick();
        await tracer.span("inner", { kind: "client" }, async () => tick());
      });
      return 42;
    });
    expect(result).toBe(42);
    expect(sink.spans).toHaveLength(3);
    const root = byName("standin.run");
    expect(root.parentSpanId).toBeNull();
    expect(root.attributes).toEqual({ "standin.run.kind": "compaction", "standin.compaction.mode": "live" });
    expect(byName("outer").parentSpanId).toBe(root.spanId);
    expect(byName("inner").parentSpanId).toBe(byName("outer").spanId);
    expect(byName("inner").kind).toBe("client");
    expect(new Set(sink.spans.map((s) => s.span.traceId)).size).toBe(1);
  });

  it("parents concurrent siblings to the span active where they started", async () => {
    const { tracer, sink, byName } = setup();
    await tracer.run("compaction", {}, async () => {
      await Promise.all([
        tracer.span("a", {}, async () => {
          await tick();
          await tracer.span("a.child", {}, tick);
        }),
        tracer.span("b", {}, tick),
      ]);
    });
    const root = byName("standin.run");
    expect(byName("a").parentSpanId).toBe(root.spanId);
    expect(byName("b").parentSpanId).toBe(root.spanId);
    expect(byName("a.child").parentSpanId).toBe(byName("a").spanId);
    expect(sink.spans).toHaveLength(4);
  });

  it("keeps concurrent runs in separate traces, even when started inside a span", async () => {
    const { tracer, sink } = setup();
    await Promise.all([
      tracer.run("eval", {}, async () => tracer.span("x", {}, tick)),
      tracer.run("eval", {}, async () => tracer.run("compaction", {}, async () => tracer.span("y", {}, tick))),
    ]);
    const roots = sink.spans.filter((s) => s.span.parentSpanId === null);
    expect(roots).toHaveLength(3);
    expect(new Set(roots.map((r) => r.span.traceId)).size).toBe(3);
    const x = sink.spans.find((s) => s.span.name === "x")!.span;
    const y = sink.spans.find((s) => s.span.name === "y")!.span;
    expect(x.traceId).not.toBe(y.traceId);
  });

  it("records thrown errors as error status and rethrows", async () => {
    const { tracer, byName } = setup();
    await expect(
      tracer.run("compaction", {}, async () => {
        await tracer.span("boom", {}, async () => {
          throw new Error("model exploded");
        });
      }),
    ).rejects.toThrow("model exploded");
    expect(byName("boom").status).toEqual({ code: "error", message: "model exploded" });
    expect(byName("standin.run").status.code).toBe("error");
  });

  it("stores content apart from attributes, and skips empty attribute values", async () => {
    const { tracer, sink } = setup();
    await tracer.run("compaction", {}, async () => {
      await tracer.span("chat m", { attributes: { a: 1, gone: undefined, nothing: null } }, async (span) => {
        span.setContent({ prompt: "hi" });
        span.setContent({ output: { ok: true } });
        span.setAttribute("b", "x");
        span.setAttribute("c", undefined);
        span.addEvent("retry", { attempt: 2 });
        span.setStatus("ok");
      });
    });
    const chat = sink.spans.find((s) => s.span.name === "chat m")!;
    expect(chat.span.attributes).toEqual({ a: 1, b: "x" });
    expect(chat.content).toEqual({ prompt: "hi", output: { ok: true } });
    expect(chat.span.events).toEqual([{ name: "retry", time: "2026-10-07T12:00:00.000Z", attributes: { attempt: 2 } }]);
    expect(chat.span.status).toEqual({ code: "ok" });
    expect(sink.spans.find((s) => s.span.name === "standin.run")!.content).toBeNull();
  });

  it("honors an explicit start time", async () => {
    const { tracer, byName } = setup();
    await tracer.run("compaction", {}, async () => tracer.span("batched", { startTime: new Date("2026-10-06T00:00:00.000Z") }, tick));
    expect(byName("batched").startTime).toBe("2026-10-06T00:00:00.000Z");
    expect(byName("batched").endTime).toBe("2026-10-07T12:00:00.000Z");
  });

  it("never lets a failing sink fail the run", async () => {
    const throwing: SpanSink = {
      onEnd() {
        throw new Error("disk full");
      },
    };
    const rejecting: SpanSink = { onEnd: async () => Promise.reject(new Error("collector down")) };
    const { tracer, errors } = setup([throwing, rejecting]);
    await expect(tracer.run("compaction", {}, async () => tracer.span("x", {}, async () => "v"))).resolves.toBe("v");
    expect(errors.map((e) => (e as Error).message).sort()).toEqual(["collector down", "collector down", "disk full", "disk full"]);
  });

  it("waits for slow sinks only up to the flush timeout", async () => {
    const hanging: SpanSink = { onEnd: () => new Promise(() => {}) };
    const { tracer, errors } = setup([hanging], { flushTimeoutMs: 50 });
    const started = Date.now();
    await tracer.run("compaction", {}, async () => "done");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(errors.map((e) => String((e as Error).message))).toEqual([expect.stringContaining("timed out")]);
  });

  it("has no active span outside spans", async () => {
    const { tracer } = setup();
    expect(tracer.active()).toBeNull();
    await tracer.run("compaction", {}, async (root) => {
      expect(tracer.active()?.spanId).toBe(root.spanId);
    });
    expect(tracer.active()).toBeNull();
  });

  it("a span with no active parent starts its own trace", async () => {
    const { tracer, sink } = setup();
    await tracer.span("lonely", {}, tick);
    expect(sink.spans[0]!.span.parentSpanId).toBeNull();
  });
});
