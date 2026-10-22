import { describe, expect, it } from "vitest";
import { obs, tempStore } from "./helpers.ts";

// Built at run time so no key-shaped string sits in the repo.
const TOKEN = "ghp_" + "aB3kQ9zX7mW2pL5vR8tY4nC6aB3kQ9zX7mW2".slice(0, 36);

/** Writes rows the way an instance from before the guard could hold them, bypassing the store's checks. */
function oldData() {
  const { store } = tempStore();
  const o = store.addObservation(obs({ text: "I like Go." }));
  const o2 = store.addObservation(obs({ text: "I also like Rust." }));
  store.db.prepare("UPDATE observations SET text = ? WHERE id = ?").run(`My token is ${TOKEN}, mail lin@example.edu`, o.id);
  store.db.prepare("UPDATE observations SET compacted_at = ? WHERE id = ?").run(store.nowIso(), o.id);
  store.db.prepare("UPDATE observations SET text = ? WHERE id = ?").run(`Not compacted yet: password: Hunter2! and I like Rust.`, o2.id);
  const m = store.insertMemory({ kind: "fact", statement: "I use GitHub.", tier: 1, isCurrentState: false, attrs: {} } as never, { sourceObservationIds: [o.id], entityIds: [], actor: "compaction" });
  store.db.prepare("UPDATE memories SET statement = ?, attrs = ? WHERE id = ?").run(`I use GitHub, token ${TOKEN}.`, JSON.stringify({ quote: `token ${TOKEN}` }), m.id);
  for (const id of ["span_1", "span_2"])
    store.db
      .prepare("INSERT INTO spans (span_id, trace_id, name, kind, start_time, end_time, status, attributes, events) VALUES (?, 't', 'chat', 'client', ?, ?, 'ok', '{}', '[]')")
      .run(id, store.nowIso(), store.nowIso());
  store.db
    .prepare("INSERT INTO span_content (span_id, recorded_at, content) VALUES (?, ?, ?)")
    .run("span_1", store.nowIso(), JSON.stringify({ prompt: `Observation: My token is ${TOKEN}` }));
  store.db.prepare("INSERT INTO span_content (span_id, recorded_at, content) VALUES (?, ?, ?)").run("span_2", store.nowIso(), JSON.stringify({ prompt: "fine" }));
  return { store, o, o2, m };
}

describe("scanning what was stored before the guard (spec §4)", () => {
  it("lists each secret and contact by where it is, never by what it is", () => {
    const { store, o, o2, m } = oldData();
    const found = store.scanStored();
    expect(found.map((f) => [f.where, f.label])).toEqual([
      [`observation ${o.id}`, "GitHub token"],
      [`observation ${o.id}`, "email address"],
      [`observation ${o2.id}`, "password"],
      [`fact ${m.id}`, "GitHub token"],
      [`fact ${m.id} (quote)`, "GitHub token"],
      ["trace span_1", "GitHub token"],
    ]);
    expect(JSON.stringify(found)).not.toContain(TOKEN.slice(4));
  });

  it("purges: compacted raw text and trace text deleted, everything else cut", () => {
    const { store, o, o2, m } = oldData();
    const r = store.purgeStored();
    expect(r).toEqual({ observations: 1, spanContent: 1, rewritten: 3 });
    expect(store.getObservation(o.id).text).toBeNull();
    expect(store.getObservation(o2.id).text).toBe("Not compacted yet: password: [removed] and I like Rust.");
    expect(store.getMemory(m.id).statement).toBe("I use GitHub, token [removed].");
    expect(store.getMemory(m.id).attrs).toEqual({ quote: "token [removed]" });
    expect(store.db.prepare("SELECT span_id FROM span_content").all()).toEqual([{ span_id: "span_2" }]);
    expect(store.scanStored()).toEqual([]);
  });
});
