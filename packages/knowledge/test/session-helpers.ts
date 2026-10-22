import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedLLM, type GenerateObjectRequest } from "@standin/llm";
import { openStore, type Store } from "@standin/store";
import { MemorySink, Tracer } from "@standin/trace";
import { CardSession, skipIntro, type CardSessionDeps } from "../src/index.ts";

export class FakeClock {
  constructor(public current = new Date("2026-10-01T12:00:00.000Z")) {}
  now() {
    return new Date(this.current);
  }
  tick(seconds = 1) {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}

/** Models that expand any node into four parts at levels 1–4, and place or home nothing. */
export function models() {
  const topic = (p: string) => /^Topic: ([^(\n]+)/m.exec(p)?.[1]?.trim() ?? "x";
  const handler = (req: GenerateObjectRequest<unknown>) => {
    if (req.purpose === "expand")
      return { components: ["one", "two", "three", "four"].map((n, i) => ({ name: `${topic(req.prompt)} ${n}`, definition: ".", level: i + 1, examples: ["a", "b", "c"].map((e) => `${n} ${e}`) })), prerequisites: [] };
    if (req.purpose === "seed") return { concepts: [{ name: "F", definition: ".", depth: 3, reason: "your introduction says so", partOf: null, evidence: [{ fact: 1, type: "job" }] }] };
    if (req.purpose === "intro")
      return { statements: (/<source>\n([\s\S]*)\n<\/source>/.exec(req.prompt)?.[1] ?? "").split(/(?<=\.)\s+/).map((s) => ({ statement: s, quote: s, kind: "occupation" })) };
    if (req.purpose === "home") return { homes: [] };
    if (req.purpose === "anchor") return { anchors: [] };
    if (req.purpose === "question") return { questions: [] };
    return { merges: [], placements: [] };
  };
  return { map: new ScriptedLLM(handler) };
}

/** A temp instance; it has skipped the introduction unless `intro` is set. */
export function world(o: { failing?: boolean; intro?: boolean } = {}) {
  const clock = new FakeClock();
  const store = openStore({ path: join(mkdtempSync(join(tmpdir(), "standin-session-")), "db"), clock });
  if (!o.intro) skipIntro(store);
  const sink = new MemorySink();
  const tracer = new Tracer({ sinks: [sink], clock });
  const m = models();
  const broken = new ScriptedLLM(() => {
    throw new Error("down");
  });
  const deps = (): CardSessionDeps => ({ store, map: o.failing ? broken : m.map, tracer, personaName: "Lin Qiao" });
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
  /** A Knowledge node, placed under the Knowledge root. */
  const node = (name: string) => {
    const n = store.ensureTopic(name);
    store.addEdge({ from: n.id, to: store.root("knowledge").id, kind: "part_of", source: "placement" });
    return n;
  };
  const claim = (topic: string, depth: number) => {
    node(topic);
    return approve("competence", `I know ${topic}.`, { domain: topic, depth }, [topic]);
  };
  const guess = (topic: string, depth: number, raw: "low" | "medium" | "high" = "medium") => {
    const n = node(topic);
    return store.insertHypothesis({ nodeId: n.id, depth, rawScore: raw, kind: "background", path: [n.id], reason: "core" });
  };
  return { store, clock, sink, tracer, m, deps, approve, node, claim, guess, start: () => CardSession.start(deps()) };
}

export const topicId = (store: Store, name: string) => store.listTopics().find((t) => t.name === name)!.id;
