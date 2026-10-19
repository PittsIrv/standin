import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseConfig } from "@standin/schema";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/migrations.ts";
import { openStore } from "../src/index.ts";
import { FakeClock, obs, seedMemory, tempStore } from "./helpers.ts";

const config = parseConfig({ persona: { name: "Lin Qiao" } });

describe("migration 4", () => {
  it("drops language, confidence and salience while keeping old rows (including Chinese ones)", () => {
    const path = join(mkdtempSync(join(tmpdir(), "standin-mig-")), "standin.db");
    const db = new DatabaseSync(path);
    migrate(db, 3);
    db.prepare(
      `INSERT INTO observations (id, source_kind, source_ref, author_role, lang, text, content_hash, occurred_at, ingested_at, meta)
       VALUES ('obs_000000000001', 'interview', 'i', 'self', 'zh', '我喜欢扑克。', 'h1', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', '{}')`,
    ).run();
    db.prepare(
      `INSERT INTO memories (id, kind, statement, lang, tier, status, confidence, salience, is_current_state, affirmed, recorded_at, last_corroborated_at, attrs)
       VALUES ('mem_000000000001', 'fact', '我喜欢扑克。', 'zh', 1, 'proposed', 0.9, 1, 0, 0, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', '{}')`,
    ).run();
    db.close();

    const store = openStore({ path });
    expect(store.getObservation("obs_000000000001").text).toBe("我喜欢扑克。");
    const m = store.getMemory("mem_000000000001");
    expect(m.statement).toBe("我喜欢扑克。");
    expect("lang" in m || "confidence" in m || "salience" in m).toBe(false);
    const cols = (t: string) => (store.db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols("observations")).not.toContain("lang");
    expect(cols("memories")).not.toEqual(expect.arrayContaining(["lang"]));
    expect(cols("memories").filter((c) => ["lang", "confidence", "salience"].includes(c))).toEqual([]);
    expect(cols("exemplars")).not.toContain("lang");
    expect(cols("preference_pairs")).not.toContain("lang");
  });
});

describe("memorySourceSummary", () => {
  it("counts sources by kind and flags AI-memory sources as unverified", () => {
    const { store } = tempStore();
    const m = seedMemory(store, "I play poker.");
    store.addCorroboration(m.id, store.addObservation(obs({ text: "Poker again." })).id);
    store.addCorroboration(m.id, store.addObservation(obs({ sourceKind: "slack", text: "poker tonight" })).id);
    expect(store.memorySourceSummary(m.id)).toEqual({
      counts: [
        { sourceKind: "interview", count: 2 },
        { sourceKind: "slack", count: 1 },
      ],
      distinct: 3,
      unverified: false,
    });
    store.addCorroboration(m.id, store.addObservation(obs({ sourceKind: "claude-memory", text: "User plays poker." })).id);
    expect(store.memorySourceSummary(m.id).unverified).toBe(true);
  });
});

describe("still-true", () => {
  function staleSetup() {
    const clock = new FakeClock();
    const { store } = tempStore(clock);
    const reading = seedMemory(store, "I'm currently reading Gödel, Escher, Bach.", { isCurrentState: true });
    store.approve(reading.id);
    const fresh = seedMemory(store, "I'm currently learning Rust.", { isCurrentState: true });
    clock.advanceDays(100);
    store.approve(fresh.id);
    clock.advanceDays(21);
    return { store, clock, reading, fresh };
  }

  it("lists approved current-state memories not mentioned for freshnessDays", () => {
    const { store, reading } = staleSetup();
    expect(store.staleCurrentState(120).map((m) => m.id)).toEqual([reading.id]);
  });

  it("skips a stale memory that a pending proposal already updates", () => {
    const { store, reading } = staleSetup();
    seedMemory(store, "I'm currently reading Dune.", { isCurrentState: true, supersedesId: reading.id });
    expect(store.staleCurrentState(120)).toEqual([]);
  });

  it("keep renews the memory and notes it", () => {
    const { store, reading } = staleSetup();
    store.keepCurrent(reading.id);
    expect(store.staleCurrentState(120)).toEqual([]);
    expect(store.memoryEvents(reading.id).at(-1)?.note).toBe("still true");
  });

  it("expire can be recorded as the person's decision", () => {
    const { store, reading } = staleSetup();
    const m = store.expire(reading.id, "no longer true", "person");
    expect(m.status).toBe("expired");
    expect(store.memoryEvents(reading.id).at(-1)).toMatchObject({ actor: "person", note: "no longer true" });
  });

  it("consolidate never expires stale current-state memories, but does expire past validUntil", () => {
    const { store, reading } = staleSetup();
    const ended = seedMemory(store, "I'm in Kyoto this week.", { validUntil: "2026-10-05T00:00:00.000Z" });
    store.approve(ended.id);
    const report = store.consolidate(config);
    expect(report.expired).toEqual([ended.id]);
    expect(store.getMemory(reading.id).status).toBe("approved");
  });
});

describe("purge", () => {
  it("consolidate purges nothing unless purgeAfterDays is set", () => {
    const clock = new FakeClock();
    const { store } = tempStore(clock);
    const o = store.addObservation(obs({ text: "old text" }));
    store.markCompacted(o.id, "processed");
    clock.advanceDays(400);
    expect(store.consolidate(config).purged).toBe(0);
    expect(store.getObservation(o.id).text).toBe("old text");
    const withWindow = parseConfig({ persona: { name: "X" }, consolidation: { purgeAfterDays: 90 } });
    expect(store.consolidate(withWindow).purged).toBe(1);
  });

  it("purge clears raw text compacted before the date and keeps the hash", () => {
    const clock = new FakeClock();
    const { store } = tempStore(clock);
    const old = store.addObservation(obs({ text: "old text" }));
    store.markCompacted(old.id, "processed");
    clock.advanceDays(10);
    const recent = store.addObservation(obs({ text: "recent text" }));
    store.markCompacted(recent.id, "processed");
    const result = store.purge(new Date(clock.current.getTime() - 86_400_000).toISOString());
    expect(result.observations).toBe(1);
    expect(store.getObservation(old.id)).toMatchObject({ text: null, contentHash: old.contentHash });
    expect(store.getObservation(recent.id).text).toBe("recent text");
  });
});

describe("queue decisions", () => {
  it("records a decision with its queue position", () => {
    const { store } = tempStore();
    store.recordQueueDecision({ itemId: "mem_000000000001", itemKind: "memory", group: "new", position: 3, decision: "approve" });
    store.recordQueueDecision({ itemId: "exm_000000000001", itemKind: "exemplar", group: null, position: null, decision: "reject" });
    const rows = store.db.prepare("SELECT item_id, item_kind, queue_group, position, decision FROM queue_decisions ORDER BY at, rowid").all();
    expect(rows).toEqual([
      { item_id: "mem_000000000001", item_kind: "memory", queue_group: "new", position: 3, decision: "approve" },
      { item_id: "exm_000000000001", item_kind: "exemplar", queue_group: null, position: null, decision: "reject" },
    ]);
  });
});
