import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@standin/store";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/main.ts";

class FakeClock {
  constructor(public current = new Date("2026-10-01T12:00:00.000Z")) {}
  now() {
    return new Date(this.current);
  }
  advanceDays(n: number) {
    this.current = new Date(this.current.getTime() + n * 86_400_000);
  }
}

function harness() {
  const home = join(mkdtempSync(join(tmpdir(), "standin-cli-")), "home");
  const clock = new FakeClock();
  let stdin = "";
  const run = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, {
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      env: { STANDIN_HOME: home },
      clock,
      readStdin: async () => stdin,
      sleep: async () => {},
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  return { home, clock, run, setStdin: (s: string) => (stdin = s) };
}

const decisions = (home: string) => {
  const store = openStore({ path: join(home, "standin.db") });
  try {
    return store.db.prepare("SELECT item_id, item_kind, queue_group, position, decision FROM queue_decisions ORDER BY at, rowid").all();
  } finally {
    store.close();
  }
};

describe("still-true cards", () => {
  it("shows stale current-state memories and lets the person keep or expire them", async () => {
    const { home, clock, run } = harness();
    await run("init", "--demo");
    await run("compact", "--demo-llm");
    const all = JSON.parse((await run("memories", "--json")).out) as { id: string; statement: string; isCurrentState: boolean }[];
    const current = all.filter((m) => m.isCurrentState);
    expect(current.length).toBeGreaterThanOrEqual(2);
    for (const m of all) await run("approve", m.id);
    clock.advanceDays(121);

    const queue = await run("queue");
    expect(queue.out).toContain("still true?");
    const items = JSON.parse((await run("queue", "--json")).out) as { kind: string; memory: { id: string } }[];
    const stale = items.filter((i) => i.kind === "still-true").map((i) => i.memory.id);
    expect(stale.length).toBeGreaterThanOrEqual(1);

    expect((await run("keep", stale[0]!)).code).toBe(0);
    const after = JSON.parse((await run("queue", "--json")).out) as { memory: { id: string } }[];
    expect(after.map((i) => i.memory.id)).not.toContain(stale[0]);
    expect(decisions(home).at(-1)).toMatchObject({ item_id: stale[0], item_kind: "still-true", queue_group: "still-true", decision: "keep" });

    if (stale[1]) {
      expect((await run("expire", stale[1])).code).toBe(0);
      const expired = JSON.parse((await run("memories", "--status", "expired", "--json")).out) as { id: string }[];
      expect(expired.map((m) => m.id)).toContain(stale[1]);
    }
    const stable = all.find((m) => !m.isCurrentState)!;
    expect((await run("keep", stable.id)).code).toBe(1);
  });
});

describe("decision logging", () => {
  it("logs approvals of items outside the queue with a null position", async () => {
    const { home, run } = harness();
    await run("init", "--demo");
    await run("compact", "--demo-llm");
    const store = openStore({ path: join(home, "standin.db") });
    const exemplar = store.listExemplars({ status: "proposed" })[0]!;
    store.close();
    expect((await run("approve", exemplar.id)).code).toBe(0);
    expect(decisions(home)).toEqual([{ item_id: exemplar.id, item_kind: "exemplar", queue_group: null, position: null, decision: "approve" }]);
  });
});

describe("purge", () => {
  it("deletes raw text compacted before the given date", async () => {
    const { home, clock, run } = harness();
    await run("init", "--demo");
    await run("compact", "--demo-llm");
    clock.advanceDays(30);
    const res = await run("purge", "--before", clock.now().toISOString());
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/purged raw text of 10 observations/);
    const store = openStore({ path: join(home, "standin.db") });
    expect(store.uncompactedObservations(10)).toEqual([]);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM observations WHERE text IS NOT NULL").get()).toEqual({ n: 0 });
    store.close();
    expect((await run("purge")).code).toBe(1);
  });
});

describe("English only", () => {
  it("rejects a mostly Chinese observation with a clear message", async () => {
    const { run, setStdin } = harness();
    await run("init", "--name", "T");
    setStdin("我从小跟外公下围棋，所以后来做游戏AI一点也不意外。");
    const res = await run("observe", "--source", "manual", "--role", "self");
    expect(res.code).toBe(1);
    expect(res.err).toContain("standin is English-only for now");
  });

  it("refuses an interview sheet with a non-English answer, naming the question, and writes nothing", async () => {
    const { home, run } = harness();
    await run("init", "--name", "T");
    const sheet = join(home, "sheet.md");
    await run("interview", "template", "--out", sheet);
    writeFileSync(
      sheet,
      readFileSync(sheet, "utf8")
        .replace(/(### now\.work\n(?:>.*\n)+)/, "$1\nI'm building standin.\n")
        .replace(/(### competence\.gaps\n(?:>.*\n)+)/, "$1\n编译器优化我不太懂。\n"),
    );
    const res = await run("interview", "import", sheet);
    expect(res.code).toBe(1);
    expect(res.err).toContain("competence.gaps");
    expect(res.err).toContain("English-only");
    const store = openStore({ path: join(home, "standin.db") });
    expect(store.uncompactedObservations(10)).toEqual([]);
    store.close();
  });
});

describe("eval dedup", () => {
  it("reports recall for each retrieval method on the labeled set", async () => {
    const { run } = harness();
    const res = await run("eval", "dedup", "--json");
    expect(res.code).toBe(0);
    const reports = JSON.parse(res.out) as { method: string; recall: Record<string, number> }[];
    expect(reports.map((r) => r.method)).toEqual(["dice≥0.3+entity", "dice-topk+entity", "entity-only"]);
    const text = await run("eval", "dedup");
    expect(text.out).toContain("recall@8");
    expect((await run("eval", "nope")).code).toBe(1);
  });
});
