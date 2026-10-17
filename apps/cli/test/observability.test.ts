import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/main.ts";

function harness() {
  const home = join(mkdtempSync(join(tmpdir(), "standin-obs-")), "home");
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
  const editConfig = (f: (cfg: any) => void) => {
    const path = join(home, "config.json");
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    f(cfg);
    writeFileSync(path, JSON.stringify(cfg));
  };
  return { home, run, editConfig };
}

describe("standin observability", () => {
  it("traces a compaction run and reports usage by role", async () => {
    const { run } = harness();
    expect((await run("init", "--demo")).code).toBe(0);
    expect((await run("compact", "--demo-llm")).code).toBe(0);

    const runs = JSON.parse((await run("traces", "--json")).out) as { traceId: string; kind: string; modelCalls: number }[];
    expect(runs).toHaveLength(1);
    expect(runs[0]!.kind).toBe("compaction");
    expect((await run("traces")).out).toContain("compaction");

    const tree = (await run("trace", "--last")).out;
    for (const name of ["standin.run", "compaction.observation", "chat scripted", "store.apply"]) expect(tree).toContain(name);
    expect((await run("trace", runs[0]!.traceId.slice(0, 8))).out).toBe(tree);
    expect((await run("trace", "--last", "--content")).out).toContain("prompt");
    const spans = JSON.parse((await run("trace", "--last", "--json")).out) as { span: { name: string } }[];
    expect(spans[0]!.span.name).toBe("standin.run");

    const usage = JSON.parse((await run("usage", "--by", "role", "--json")).out) as { key: string; calls: number; unpricedCalls: number }[];
    const extract = usage.find((u) => u.key === "extract")!;
    expect(extract.calls).toBe(9);
    expect(extract.unpricedCalls).toBe(9);
    expect(usage.find((u) => u.key === "reconcile")!.calls).toBeGreaterThan(0);
    expect(usage.reduce((n, u) => n + u.calls, 0)).toBe(runs[0]!.modelCalls);
    const text = (await run("usage")).out;
    expect(text).toContain("extract");
    expect(text).toContain("cached");
    expect(text).toMatch(/\d+ calls have no known price/);
    expect((await run("usage", "--by", "model")).out).toContain("scripted");
    expect((await run("usage", "--by", "nope")).code).toBe(1);

    expect((await run("trace", "ffffffffffff")).err).toContain("not found");
    expect((await run("trace")).code).toBe(1);
  });

  it("traces interview imports", async () => {
    const { home, run } = harness();
    await run("init", "--name", "T");
    const sheet = join(home, "answers.md");
    writeFileSync(sheet, "<!-- standin interview · bank: core-v1 -->\n### now.work\nBuilding standin.\n");
    await run("interview", "import", sheet, "--dry-run");
    expect(JSON.parse((await run("traces", "--json")).out)).toEqual([]);
    await run("interview", "import", sheet);
    const runs = JSON.parse((await run("traces", "--kind", "import", "--json")).out) as { kind: string }[];
    expect(runs.map((r) => r.kind)).toEqual(["import"]);
    expect((await run("trace", "--last")).out).toContain("standin.run");
  });

  it("keeps working when the trace collector is down", async () => {
    const { run, editConfig } = harness();
    await run("init", "--demo");
    editConfig((cfg) => (cfg.tracing = { otlp: { endpoint: "http://127.0.0.1:9/v1/traces" } }));
    const res = await run("compact", "--demo-llm");
    expect(res.code).toBe(0);
    expect(res.out).toContain("processed 9");
    expect(res.err.split("\n").filter((l) => l.startsWith("warning: trace export failed"))).toHaveLength(1);
  });

  it("refuses --batch for a provider without a batch API", async () => {
    const { run, editConfig } = harness();
    await run("init", "--name", "T");
    editConfig((cfg) => (cfg.models.tiers.large = { provider: "openai-compatible", model: "qwen", baseURL: "http://127.0.0.1:9/v1" }));
    expect((await run("compact", "--batch")).err).toContain("--batch needs a provider with a batch API");
  });

  it("reports purged trace text in consolidate", async () => {
    const { run } = harness();
    await run("init", "--demo");
    await run("compact", "--demo-llm");
    expect(JSON.parse((await run("consolidate", "--json")).out)).toMatchObject({ purgedSpanContent: 0 });
    expect((await run("consolidate")).out).toContain("trace text");
  });
});
