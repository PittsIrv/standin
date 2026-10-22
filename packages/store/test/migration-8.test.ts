import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/migrations.ts";
import { openStore } from "../src/index.ts";

const T0 = "2026-09-01T00:00:00.000Z";

describe("migration 8", () => {
  it("turns approved inferred lighting into open hypotheses and withdraws pending inferred proposals", () => {
    const path = join(mkdtempSync(join(tmpdir(), "standin-mig8-")), "standin.db");
    const db = new DatabaseSync(path);
    migrate(db, 7);
    db.prepare("INSERT INTO entities (id, kind, name, aliases) VALUES ('ent_00000000000a', 'topic', 'Algorithms', '[]')").run();
    db.prepare("INSERT INTO topics (entity_id) VALUES ('ent_00000000000a')").run();
    const memory = db.prepare(
      `INSERT INTO memories (id, kind, statement, tier, status, is_current_state, affirmed, recorded_at, last_corroborated_at, attrs)
       VALUES (?, 'competence', ?, 1, ?, 0, 1, ?, ?, ?)`,
    );
    memory.run("mem_000000000001", "I've used Algorithms.", "approved", T0, T0, JSON.stringify({ domain: "Algorithms", depth: 2, basis: "predicted", reasons: ["core of your background: I'm a CS student"] }));
    memory.run("mem_000000000002", "I know Algorithms well.", "proposed", T0, T0, JSON.stringify({ domain: "Algorithms", depth: 3, basis: "predicted", reasons: ["Sorting is at 4 and is part of it"] }));
    for (const id of ["mem_000000000001", "mem_000000000002"]) db.prepare("INSERT INTO memory_entities (memory_id, entity_id) VALUES (?, 'ent_00000000000a')").run(id);
    db.close();

    const store = openStore({ path });
    expect(store.listHypotheses().map((h) => [h.nodeId, h.depth, h.kind, h.rawScore, h.status, h.path])).toEqual([
      ["ent_00000000000a", 2, "background", "medium", "open", ["ent_00000000000a"]],
    ]);
    expect(store.getMemory("mem_000000000001").status).toBe("retracted");
    expect(store.getMemory("mem_000000000002").status).toBe("rejected");
    expect(store.memoryEvents("mem_000000000001").at(-1)).toMatchObject({ actor: "map", note: "replaced by a hypothesis" });
  });
});
