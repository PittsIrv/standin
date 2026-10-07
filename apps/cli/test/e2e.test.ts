import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
      sleep: async () => {},
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

  it("writes a private interview sheet and imports answers idempotently", async () => {
    const { home, run } = harness();
    expect((await run("interview", "template")).code).toBe(1);
    expect((await run("init", "--name", "Test Person")).code).toBe(0);

    const tpl = await run("interview", "template");
    expect(tpl.code).toBe(0);
    const sheetPath = join(home, "interviews", `core-v1-${new Date().toISOString().slice(0, 10)}.md`);
    expect(tpl.out).toContain(sheetPath);
    expect(statSync(sheetPath).mode & 0o777).toBe(0o600);
    expect((await run("interview", "template")).err).toContain("already exists");

    const filled = readFileSync(sheetPath, "utf8")
      .replace(/(### now\.work\n(?:>.*\n)+)/, "$1\nI'm building standin.\n")
      .replace(/(### competence\.gaps\n(?:>.*\n)+)/, "$1\n编译器优化我不太懂。\n");
    writeFileSync(sheetPath, filled);

    const dry = await run("interview", "import", sheetPath, "--dry-run");
    expect(dry.out).toContain("would add 2");
    const first = await run("interview", "import", sheetPath, "--occurred", "2026-10-02", "--json");
    expect(first.code).toBe(0);
    const report = JSON.parse(first.out) as { answers: { questionId: string; lang: string; status: string }[]; blank: string[] };
    expect(report.answers).toMatchObject([
      { questionId: "now.work", lang: "en", status: "added" },
      { questionId: "competence.gaps", lang: "zh", status: "added" },
    ]);
    expect(report.blank.length).toBeGreaterThan(20);

    const again = await run("interview", "import", sheetPath);
    expect(again.out).toContain("added 0, unchanged 2");

    const store = openStore({ path: join(home, "standin.db") });
    const pending = store.uncompactedObservations(10);
    store.close();
    expect(pending.map((o) => [o.sourceKind, o.authorRole, o.occurredAt])).toEqual([
      ["interview", "self", "2026-10-02T00:00:00.000Z"],
      ["interview", "self", "2026-10-02T00:00:00.000Z"],
    ]);
    expect((await run("interview", "import", sheetPath, "--occurred", "soon")).code).toBe(1);
    expect((await run("interview", "frob")).code).toBe(1);
  });

  it("compacts through a batch with the same result as live compaction", async () => {
    const { run } = harness();
    expect((await run("init", "--demo")).code).toBe(0);
    const submitted = await run("compact", "--batch", "--demo-llm");
    expect(submitted.out).toContain("9 observations (skipped exposed: 1)");
    expect((await run("compact", "--demo-llm")).err).toContain("is open");
    const collected = await run("compact", "--batch", "--demo-llm", "--json");
    expect(JSON.parse(collected.out)).toMatchObject({
      kind: "collected",
      report: { processed: 9, created: 13, corroborated: 1, updates: 1, contradictions: 1, exemplars: 3, failed: [] },
    });
    expect((await run("compact", "--batch", "--demo-llm")).out).toContain("Nothing to compact");
    expect((await run("compact", "--abandon-batch")).out).toContain("No open batch");
  });

  it("--wait polls a batch to completion, and --abandon-batch releases it", async () => {
    const { run } = harness();
    expect((await run("init", "--demo")).code).toBe(0);
    const waited = await run("compact", "--batch", "--wait", "--demo-llm");
    expect(waited.out).toContain("Submitted batch");
    expect(waited.out).toContain("processed 9");

    const { run: run2 } = harness();
    await run2("init", "--demo");
    await run2("compact", "--batch", "--demo-llm");
    expect((await run2("compact", "--abandon-batch")).out).toContain("pending again");
    expect(JSON.parse((await run2("compact", "--demo-llm", "--json")).out)).toMatchObject({ processed: 9 });
  });

  it("validates model config and flags", async () => {
    const { home, run } = harness();
    expect((await run("init", "--name", "T")).code).toBe(0);
    await run("observe", "--source", "manual", "--role", "self", "--lang", "en", "--file", join(home, "config.json"));
    expect((await run("compact", "--limit", "abc")).err).toContain("--limit must be a positive integer");

    const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    cfg.models.tiers.large = { provider: "anthropic", model: "claude-opus-5-5", apiKeyEnv: "STANDIN_TEST_MISSING_KEY" };
    writeFileSync(join(home, "config.json"), JSON.stringify(cfg));
    const missing = await run("compact");
    expect(missing.code).toBe(1);
    expect(missing.err).toBe("error: STANDIN_TEST_MISSING_KEY is not set (named by apiKeyEnv for model claude-opus-5-5)");

    cfg.models.tiers.large = { provider: "openai-compatible", model: "qwen", baseURL: "http://127.0.0.1:9/v1" };
    writeFileSync(join(home, "config.json"), JSON.stringify(cfg));
    expect((await run("compact", "--batch")).err).toContain("--batch needs a provider with a batch API");
  });

  it("prints usage for unknown commands", async () => {
    const { run } = harness();
    const res = await run("frobnicate");
    expect(res.code).toBe(2);
    expect(res.err).toContain("Usage");
  });
});
