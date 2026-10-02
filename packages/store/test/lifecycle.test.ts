import { describe, expect, it } from "vitest";
import { AmbiguousIdError, InvalidTransitionError, NotFoundError } from "../src/index.ts";
import { obs, seedMemory, tempStore } from "./helpers.ts";

describe("insertMemory", () => {
  it("creates a proposed memory with sources, entities and a creation event", () => {
    const { store } = tempStore();
    const e = store.resolveEntity({ name: "Dealer's Choice", kind: "project" });
    const m = seedMemory(store, "I built Dealer's Choice.", {}, [e.id]);
    expect(m.status).toBe("proposed");
    expect(m.id).toMatch(/^mem_[0-9a-f]{12}$/);
    expect(m.confidence).toBeCloseTo(0.9, 10);
    expect(store.memorySources(m.id)).toHaveLength(1);
    expect(store.memoryEntities(m.id).map((x) => x.id)).toEqual([e.id]);
    expect(store.memoryEvents(m.id).map((ev) => [ev.fromStatus, ev.toStatus, ev.actor])).toEqual([
      [null, "proposed", "compaction"],
    ]);
  });

  it("corroboration adds a source and raises confidence", () => {
    const { store } = tempStore();
    const m = seedMemory(store, "I like poker.", {});
    const o2 = store.addObservation(obs({ sourceKind: "slack", text: "poker night again, love it" }));
    const after = store.addCorroboration(m.id, o2.id);
    expect(store.memorySources(m.id)).toHaveLength(2);
    expect(after.confidence).toBeCloseTo(1 - 0.1 * 0.3, 10);
    // idempotent
    expect(store.addCorroboration(m.id, o2.id).confidence).toBeCloseTo(after.confidence, 10);
  });
});

describe("lifecycle", () => {
  it("approve sets affirmed, full confidence, decidedAt and an event", () => {
    const { store, clock } = tempStore();
    const m = seedMemory(store, "I study at CMU.");
    clock.advanceDays(1);
    const a = store.approve(m.id);
    expect(a.status).toBe("approved");
    expect(a.affirmed).toBe(true);
    expect(a.confidence).toBe(1);
    expect(a.decidedAt).toBe(clock.now().toISOString());
    expect(store.memoryEvents(m.id).at(-1)).toMatchObject({ fromStatus: "proposed", toStatus: "approved", actor: "person" });
  });

  it("rejects invalid transitions", () => {
    const { store } = tempStore();
    const m = seedMemory(store, "A");
    store.approve(m.id);
    expect(() => store.approve(m.id)).toThrow(InvalidTransitionError);
    const r = seedMemory(store, "B");
    store.reject(r.id);
    expect(() => store.approve(r.id)).toThrow(InvalidTransitionError);
    const p = seedMemory(store, "C");
    expect(() => store.retract(p.id)).toThrow(InvalidTransitionError);
    store.approve(p.id);
    expect(store.retract(p.id).status).toBe("retracted");
  });

  it("records edits made at approval", () => {
    const { store } = tempStore();
    const m = seedMemory(store, "I earn a lot.", { tier: 2 });
    const a = store.approve(m.id, { tier: 3, statement: "Compensation: ask me directly." });
    expect(a.tier).toBe(3);
    expect(a.statement).toBe("Compensation: ask me directly.");
    const note = store.memoryEvents(m.id).at(-1)!.note!;
    expect(note).toContain("tier 2 → 3");
    expect(note).toContain("I earn a lot.");
  });

  it("approving an update supersedes the approved target and closes its validity", () => {
    const { store, clock } = tempStore();
    const old = seedMemory(store, "I'm currently reading Dune.", { isCurrentState: true });
    store.approve(old.id);
    clock.advanceDays(10);
    const upd = seedMemory(store, "I'm currently reading Solaris.", { isCurrentState: true, supersedesId: old.id });
    clock.advanceDays(1);
    const approved = store.approve(upd.id);
    const prev = store.getMemory(old.id);
    expect(prev.status).toBe("superseded");
    expect(approved.validFrom).toBe(clock.now().toISOString());
    expect(prev.validUntil).toBe(approved.validFrom);
  });

  it("approving a contradiction supersedes the target too", () => {
    const { store } = tempStore();
    const old = seedMemory(store, "I prefer Python.");
    store.approve(old.id);
    const c = seedMemory(store, "I prefer Rust now.", { conflictsWithId: old.id, validFrom: "2026-09-01T00:00:00.000Z" });
    store.approve(c.id);
    expect(store.getMemory(old.id)).toMatchObject({ status: "superseded", validUntil: "2026-09-01T00:00:00.000Z" });
  });

  it("approving an update whose target was already retracted leaves the target alone", () => {
    const { store } = tempStore();
    const old = seedMemory(store, "Old claim.");
    store.approve(old.id);
    const upd = seedMemory(store, "New claim.", { supersedesId: old.id });
    store.retract(old.id);
    expect(store.approve(upd.id).status).toBe("approved");
    expect(store.getMemory(old.id).status).toBe("retracted");
  });

  it("approving a replacement for a still-proposed memory rejects that memory, so both can't end up approved", () => {
    const { store } = tempStore();
    const old = seedMemory(store, "I prefer Python.");
    const c = seedMemory(store, "I prefer Rust now.", { conflictsWithId: old.id });
    store.approve(c.id);
    const resolved = store.getMemory(old.id);
    expect(resolved.status).toBe("rejected");
    expect(store.memoryEvents(old.id).at(-1)).toMatchObject({ toStatus: "rejected", actor: "person", note: `replaced by ${c.id}` });
    expect(() => store.approve(old.id)).toThrow(InvalidTransitionError);
  });

  it("expire only applies to approved memories", () => {
    const { store } = tempStore();
    const m = seedMemory(store, "X");
    expect(() => store.expire(m.id)).toThrow(InvalidTransitionError);
    store.approve(m.id);
    expect(store.expire(m.id, "stale").status).toBe("expired");
  });
});

describe("getMemory", () => {
  it("accepts unique prefixes with or without the mem_ prefix", () => {
    const { store } = tempStore();
    const m = seedMemory(store, "X");
    expect(store.getMemory(m.id.slice(0, 10)).id).toBe(m.id);
    expect(store.getMemory(m.id.slice(4, 12)).id).toBe(m.id);
  });

  it("refuses short prefixes and unknown ids", () => {
    const { store } = tempStore();
    seedMemory(store, "X");
    expect(() => store.getMemory("mem_")).toThrow(NotFoundError);
    expect(() => store.getMemory("mem_ffffffffffff")).toThrow(NotFoundError);
  });

  it("reports ambiguous prefixes with candidates", () => {
    const { store } = tempStore();
    const a = seedMemory(store, "A");
    const b = seedMemory(store, "B");
    // Force a shared prefix (raw id rewrite, so foreign keys are off for the fixture).
    store.db.exec("PRAGMA foreign_keys = OFF");
    store.db.prepare("UPDATE memories SET id = 'mem_abcdef000001' WHERE id = ?").run(a.id);
    store.db.prepare("UPDATE memories SET id = 'mem_abcdef000002' WHERE id = ?").run(b.id);
    try {
      store.getMemory("abcdef");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AmbiguousIdError);
      expect((err as AmbiguousIdError).candidates).toEqual(["mem_abcdef000001", "mem_abcdef000002"]);
    }
  });
});

describe("listMemories", () => {
  it("filters by status and kind", () => {
    const { store } = tempStore();
    const a = seedMemory(store, "A");
    seedMemory(store, "B");
    store.approve(a.id);
    expect(store.listMemories({ status: "approved" }).map((m) => m.id)).toEqual([a.id]);
    expect(store.listMemories({ kind: "fact" })).toHaveLength(2);
    expect(store.listMemories({ kind: "stance" })).toHaveLength(0);
  });
});
