import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedLLM, type GenerateObjectRequest } from "@standin/llm";
import { openStore, type Store } from "@standin/store";
import { MemorySink, Tracer } from "@standin/trace";
import { ProbeSession, type SessionDeps } from "../src/index.ts";

export class FakeClock {
  constructor(public current = new Date("2026-10-01T12:00:00.000Z")) {}
  now() {
    return new Date(this.current);
  }
  tick(seconds = 1) {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}

/** Models that expand any node into four parts, write numbered probes, and pass answers of 4+ words. */
export function models() {
  const topic = (p: string) => /^Topic: ([^(\n]+)/m.exec(p)?.[1]?.trim() ?? "x";
  const handler = (req: GenerateObjectRequest<unknown>) => {
    if (req.purpose === "expand")
      return { components: ["one", "two", "three", "four"].map((n, i) => ({ name: `${topic(req.prompt)} ${n}`, definition: ".", level: i + 1 })), prerequisites: [] };
    if (req.purpose === "quiz") {
      const count = Number(/^Write (\d+) probe/m.exec(req.prompt)?.[1] ?? "1");
      return { probes: Array.from({ length: count }, (_, i) => ({ question: `About ${topic(req.prompt)}, question ${i + 1}?` })) };
    }
    if (req.purpose === "grade") {
      const answer = /^Answer: (.*)$/m.exec(req.prompt)?.[1] ?? "";
      return answer.split(/\s+/).length >= 4 ? { grade: "pass", reason: "ok" } : { grade: "fail", reason: "too short" };
    }
    if (req.purpose === "seed") return { field: { name: "F", definition: "." }, core: [] };
    return { merges: [], placements: [] };
  };
  return { map: new ScriptedLLM(handler), quiz: new ScriptedLLM(handler), grade: new ScriptedLLM(handler) };
}

/** An rng that returns the queued values first, then 0.99 (holdout "none", no spot-check). */
export function queued(values: number[] = []): () => number {
  const q = [...values];
  return () => q.shift() ?? 0.99;
}

export function world(o: { rng?: () => number; size?: number; failing?: boolean } = {}) {
  const clock = new FakeClock();
  const store = openStore({ path: join(mkdtempSync(join(tmpdir(), "standin-session-")), "db"), clock });
  const sink = new MemorySink();
  const tracer = new Tracer({ sinks: [sink], clock });
  const m = models();
  const broken = new ScriptedLLM(() => {
    throw new Error("down");
  });
  const deps = (): SessionDeps => ({
    store,
    map: o.failing ? broken : m.map,
    quiz: o.failing ? broken : m.quiz,
    grade: o.failing ? broken : m.grade,
    tracer,
    rng: o.rng ?? queued(),
    personaName: "Lin Qiao",
    size: o.size,
  });
  const obs = store.addObservation({ sourceKind: "interview", sourceRef: "i", authorRole: "self", text: "seed", occurredAt: "2026-09-01T00:00:00.000Z" });
  const approve = (kind: "competence" | "negative" | "fact", statement: string, attrs: object, topics: string[] = []) => {
    const mem = store.insertMemory({ kind, statement, tier: 1, isCurrentState: false, attrs } as never, {
      sourceObservationIds: [obs.id],
      entityIds: topics.map((t) => store.ensureTopic(t).id),
      actor: "compaction",
    });
    store.approve(mem.id);
    return mem;
  };
  const claim = (topic: string, depth: number) => approve("competence", `I know ${topic}.`, { domain: topic, depth }, [topic]);
  return { store, clock, sink, tracer, m, deps, approve, claim, start: () => ProbeSession.start(deps()) };
}

export const topicId = (store: Store, name: string) => store.listTopics().find((t) => t.name === name)!.id;
