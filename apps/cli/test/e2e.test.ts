import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@standin/store";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/main.ts";

function harness() {
  const home = join(mkdtempSync(join(tmpdir(), "standin-cli-")), "home");
  const out: string[] = [];
  const err: string[] = [];
  const run = async (...argv: string[]) => {
    out.length = 0;
    err.length = 0;
    const code = await runCli(argv, {
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      env: { STANDIN_HOME: home },
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  return { home, run };
}

describe("standin CLI, end to end on the demo persona", () => {
  it("runs init → compact → review → as-of queries → consolidate offline", async () => {
    const { home, run } = harness();

    const before = await run("memories");
    expect(before.code).toBe(1);
    expect(before.err).toContain("run `standin init`");

    const init = await run("init", "--demo");
    expect(init.code).toBe(0);
    expect(init.out).toContain("Lin Qiao");
    expect(init.out).toContain("10 demo observations");
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect((await run("init", "--demo")).code).toBe(1);

    const compacted = await run("compact", "--demo-llm", "--json");
    expect(compacted.code).toBe(0);
    const report = JSON.parse(compacted.out);
    expect(report).toMatchObject({
      processed: 9,
      skippedExposed: 1,
      created: 13,
      corroborated: 1,
      updates: 1,
      contradictions: 1,
      exemplars: 3,
      failed: [],
    });

    const queue = await run("queue", "--json");
    const proposed = JSON.parse(queue.out) as { id: string; statement: string; conflictsWithId: string | null; supersedesId: string | null }[];
    expect(proposed[0]!.statement).toBe("I write most of my game engines in Rust rather than Python.");
    expect((await run("queue")).out).toContain("conflicts with");

    const all = JSON.parse((await run("memories", "--json")).out) as { id: string; statement: string; tier: number }[];
    const byStatement = (s: string) => all.find((m) => m.statement === s)!;
    const pythonPref = byStatement("I prefer Python for all my projects.");
    const rust = byStatement("I write most of my game engines in Rust rather than Python.");
    const trainer = byStatement("I'm currently working on a self-play trainer for Lantern.");
    const kite = byStatement("I'm currently working on a Go-variant engine called Kite.");
    const salary = byStatement("我不想公开讨论工资，想了解可以直接邮件问我。");
    expect(salary.tier).toBe(3);

    // Approve the AI-memory claim, then the contradiction that replaces it.
    expect((await run("approve", pythonPref.id)).code).toBe(0);
    expect((await run("approve", rust.id.slice(4, 12))).code).toBe(0);
    // Approve the old current-state fact, then its update.
    expect((await run("approve", trainer.id)).code).toBe(0);
    expect((await run("approve", kite.id)).code).toBe(0);
    // Re-tier and reword at approval; reject something.
    expect((await run("approve", salary.id, "--tier", "3", "--statement", "工资的问题请直接邮件问我。")).code).toBe(0);
    expect((await run("reject", byStatement("I'm learning Japanese.").id)).code).toBe(0);
    expect((await run("approve", byStatement("I'm learning Japanese.").id)).code).toBe(1);

    const approved = JSON.parse((await run("memories", "--status", "approved", "--json")).out) as { statement: string }[];
    expect(approved.map((m) => m.statement).sort()).toEqual(
      [
        "I write most of my game engines in Rust rather than Python.",
        "I'm currently working on a Go-variant engine called Kite.",
        "工资的问题请直接邮件问我。",
      ].sort(),
    );
    const superseded = JSON.parse((await run("memories", "--status", "superseded", "--json")).out) as { statement: string }[];
    expect(superseded.map((m) => m.statement).sort()).toEqual(
      ["I prefer Python for all my projects.", "I'm currently working on a self-play trainer for Lantern."].sort(),
    );

    // What was true on Sept 1, according to what we know now.
    const asOf = (await run("memories", "--as-of", "2026-09-01T00:00:00.000Z")).out;
    expect(asOf).toContain("self-play trainer for Lantern");
    expect(asOf).not.toContain("Kite");

    const cons = await run("consolidate", "--json");
    expect(cons.code).toBe(0);
    expect(JSON.parse(cons.out)).toMatchObject({ expired: [], purged: 0 });
  });

  it("adds observations from a file and reports unknown or ambiguous ids", async () => {
    const { home, run } = harness();
    expect((await run("init", "--name", "Test Person", "--languages", "en,zh")).code).toBe(0);
    const file = join(home, "note.txt");
    writeFileSync(file, "I started learning the cello this month.");
    const added = await run("observe", "--source", "manual", "--role", "self", "--lang", "en", "--file", file);
    expect(added.code).toBe(0);
    expect(added.out).toMatch(/obs_[0-9a-f]{12}/);
    expect((await run("observe", "--source", "nope", "--role", "self", "--lang", "en", "--file", file)).code).toBe(1);

    expect((await run("approve", "mem_ffffffffffff")).err).toContain("not found");

    const store = openStore({ path: join(home, "standin.db") });
    const o = store.addObservation({
      sourceKind: "manual",
      sourceRef: "t",
      authorRole: "self",
      lang: "en",
      text: "seed",
      occurredAt: "2026-09-01T00:00:00.000Z",
    });
    for (const s of ["A", "B"])
      store.insertMemory(
        { kind: "fact", statement: s, lang: "en", tier: 1, isCurrentState: false, attrs: {} },
        { sourceObservationIds: [o.id], entityIds: [], actor: "person", salience: 1 },
      );
    store.db.exec("PRAGMA foreign_keys = OFF");
    store.db.exec("UPDATE memories SET id = 'mem_abcdef00000' || rowid");
    store.close();
    const ambiguous = await run("approve", "abcdef");
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.err).toContain("mem_abcdef000001");
    expect(ambiguous.err).toContain("mem_abcdef000002");
  });

  it("prints usage for unknown commands", async () => {
    const { run } = harness();
    const res = await run("frobnicate");
    expect(res.code).toBe(2);
    expect(res.err).toContain("Usage");
  });
});
