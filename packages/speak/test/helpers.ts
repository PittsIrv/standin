import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RootKey, Tier } from "@standin/schema";
import { openStore, type Store } from "@standin/store";

export const store = () => openStore({ path: join(mkdtempSync(join(tmpdir(), "standin-speak-")), "db") });

/** A node under a parent (a root key or a node id). */
export function node(s: Store, name: string, under: RootKey | string, label: "pet" | "project" | "topic" | "person" | "org" = "topic") {
  const n = s.ensureNode(name, label);
  const parent = under.includes("_") ? under : s.root(under as RootKey).id;
  s.addEdge({ from: n.id, to: parent, kind: "part_of", source: "placement" });
  return n;
}

/** A memory homed on a node; approved unless said otherwise. */
export function fact(s: Store, nodeId: string, statement: string, opts: { tier?: Tier; approve?: boolean; kind?: "fact" | "stance" | "negative" } = {}) {
  const o = s.addObservation({ sourceKind: "manual", sourceRef: "t", authorRole: "self", text: statement, occurredAt: "2026-09-01T00:00:00.000Z" });
  const kind = opts.kind ?? "fact";
  const attrs = kind === "stance" ? { topic: "t", strength: 3 } : {};
  const m = s.insertMemory({ kind, statement, tier: opts.tier ?? 1, isCurrentState: false, attrs } as never, {
    sourceObservationIds: [o.id],
    entityIds: [nodeId],
    actor: "compaction",
    homeNodeId: nodeId,
  });
  if (opts.approve !== false) s.approve(m.id);
  return m;
}
