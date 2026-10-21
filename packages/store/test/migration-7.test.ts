import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/migrations.ts";
import { openStore } from "../src/index.ts";

const T0 = "2026-09-01T00:00:00.000Z";
const T1 = "2026-09-02T00:00:00.000Z";

describe("migration 7", () => {
  it("makes every entity a node under six roots, keeps one home per node, and gives memories a home", () => {
    const path = join(mkdtempSync(join(tmpdir(), "standin-mig7-")), "standin.db");
    const db = new DatabaseSync(path);
    migrate(db, 6);
    const entity = db.prepare("INSERT INTO entities (id, kind, name, aliases) VALUES (?, ?, ?, '[]')");
    const topic = db.prepare("INSERT INTO topics (entity_id) VALUES (?)");
    const edge = db.prepare("INSERT INTO topic_edges (id, from_topic, to_topic, kind, source, created_at) VALUES (?, ?, ?, 'part_of', 'placement', ?)");
    for (const [id, name] of [
      ["ent_00000000000a", "A"],
      ["ent_00000000000b", "B"],
      ["ent_00000000000c", "C"],
    ] as const) {
      entity.run(id, "topic", name);
      topic.run(id);
    }
    entity.run("ent_0000000000d1", "project", "Kite");
    edge.run("edg_000000000001", "ent_00000000000a", "ent_00000000000b", T0);
    edge.run("edg_000000000002", "ent_00000000000a", "ent_00000000000c", T1);
    const memory = db.prepare(
      `INSERT INTO memories (id, kind, statement, tier, status, is_current_state, affirmed, recorded_at, last_corroborated_at, attrs)
       VALUES (?, 'fact', ?, 1, 'approved', 0, 1, ?, ?, '{}')`,
    );
    memory.run("mem_000000000001", "About A and B.", T0, T0);
    memory.run("mem_000000000002", "About nothing.", T0, T0);
    const link = db.prepare("INSERT INTO memory_entities (memory_id, entity_id) VALUES (?, ?)");
    link.run("mem_000000000001", "ent_00000000000b");
    link.run("mem_000000000001", "ent_00000000000a");
    db.close();

    const store = openStore({ path });
    const roots = store.roots();
    expect(roots.map((r) => [r.rootKey, r.name, r.label])).toEqual([
      ["knowledge", "Knowledge", "other"],
      ["work", "Work", "other"],
      ["background", "Background", "other"],
      ["people", "People", "other"],
      ["views", "Views", "other"],
      ["life", "Life", "other"],
    ]);
    const ids = new Set(store.listTopics({ includeRoots: true }).map((t) => t.id));
    for (const e of store.listEntities()) expect(ids.has(e.id)).toBe(true);
    expect(store.listEntities().map((e) => e.name)).not.toContain("Knowledge");

    const partOf = store.listEdges("part_of").map((e) => [e.from, e.to]);
    expect(partOf.filter(([from]) => from === "ent_00000000000a")).toEqual([["ent_00000000000a", "ent_00000000000b"]]);
    expect(store.listEdges("related").map((e) => [e.from, e.to])).toEqual([["ent_00000000000a", "ent_00000000000c"]]);
    expect(partOf).toContainEqual(["ent_00000000000b", store.root("knowledge").id]);
    expect(partOf.filter(([from]) => from === "ent_0000000000d1")).toEqual([]);
    expect(store.getTopic("ent_0000000000d1").label).toBe("project");

    expect(store.getMemory("mem_000000000001").homeNodeId).toBe("ent_00000000000a");
    expect(store.getMemory("mem_000000000002").homeNodeId).toBeNull();
  });
});
