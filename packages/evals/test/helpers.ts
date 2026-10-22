import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RootKey, Tier } from "@standin/schema";
import { LIMITS, type TurnDeps } from "@standin/speak";
import { openStore, type Store } from "@standin/store";
import { Tracer } from "@standin/trace";
import type { LLM } from "@standin/llm";

export const tempDir = () => mkdtempSync(join(tmpdir(), "standin-evals-"));
export const store = () => openStore({ path: join(tempDir(), "db") });

export function node(s: Store, name: string, under: RootKey | string, label: "pet" | "project" | "topic" | "person" | "org" = "topic") {
  const n = s.ensureNode(name, label);
  s.addEdge({ from: n.id, to: under.includes("_") ? under : s.root(under as RootKey).id, kind: "part_of", source: "placement" });
  return n;
}

export function fact(s: Store, nodeId: string, statement: string, opts: { tier?: Tier; kind?: "fact" | "negative" | "stance" } = {}) {
  const o = s.addObservation({ sourceKind: "manual", sourceRef: "t", authorRole: "self", text: statement, occurredAt: "2026-09-01T00:00:00.000Z" });
  const kind = opts.kind ?? "fact";
  const m = s.insertMemory({ kind, statement, tier: opts.tier ?? 1, isCurrentState: false, attrs: kind === "stance" ? { topic: "t", strength: 3 } : {} } as never, {
    sourceObservationIds: [o.id],
    entityIds: [nodeId],
    actor: "compaction",
    homeNodeId: nodeId,
  });
  s.approve(m.id);
  return m;
}

/** Lin Qiao, as the repo's demo cases expect her. */
export function linStore(): Store {
  const s = store();
  const school = node(s, "Riverside Institute of Technology", "background", "org");
  fact(s, school.id, "I study at Riverside Institute of Technology.");
  const games = node(s, "Game AI", "work", "project");
  fact(s, games.id, "I build AIs for board games.");
  const travel = node(s, "Travel", "life");
  fact(s, travel.id, "I've never been to Japan.", { kind: "negative" });
  fact(s, s.root("life").id, "My student visa expires in 2027.", { tier: 4 });
  const family = node(s, "Family", "people");
  s.setTopic(family.id, { boundaryTier: 3 });
  fact(s, node(s, "Mom", family.id, "person").id, "My mom lives in Ohio.");
  node(s, "Quantum computing", "knowledge");
  return s;
}

export const turnDeps = (s: Store, model: LLM): TurnDeps => ({ store: s, answer: model, check: model, tracer: new Tracer({ sinks: [] }), personaName: "Lin", speakAt: 0.8, limits: LIMITS });
