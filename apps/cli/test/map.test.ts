import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@standin/store";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/main.ts";

function harness() {
  const home = join(mkdtempSync(join(tmpdir(), "standin-cli-")), "home");
  const run = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, { stdout: (s) => out.push(s), stderr: (s) => err.push(s), env: { STANDIN_HOME: home }, sleep: async () => {} });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  return { run };
}

type Node = { name: string; parent: string | null; mode: string; depth: number | null; via: string | null };

describe("standin map", () => {
  it("builds and shows the lit tree on the demo persona", async () => {
    const { run } = harness();
    await run("init", "--demo");
    await run("compact", "--demo-llm");
    const memories = JSON.parse((await run("memories", "--json")).out) as { id: string; kind: string }[];
    const competence = memories.find((m) => m.kind === "competence")!;
    const hinted = await run("approve", competence.id);
    expect(hinted.out).toContain("Run `standin map refresh` to update your knowledge tree.");
    for (const m of memories) if (m.id !== competence.id) await run("approve", m.id);

    expect((await run("map")).out).toContain("Not yet placed");
    const refreshed = await run("map", "refresh", "--demo-llm");
    expect(refreshed.code).toBe(0);
    expect(refreshed.out).toContain("seeded Computer science");
    expect(refreshed.out).toMatch(/proposed \d+ lighting change/);
    expect(refreshed.out).toContain("Next: standin queue");

    const queueText = (await run("queue")).out;
    expect(queueText).toContain("why: core of your background");
    expect(queueText).toContain("Approving lights its whole branch: 6 parts in the tree.");
    const queue = JSON.parse((await run("queue", "--json")).out) as { memory: { id: string; statement: string } }[];
    expect(queue.map((i) => i.memory.statement)).toContain("I've used Algorithms and can get things done with it.");
    for (const i of queue) await run("approve", i.memory.id);

    const text = (await run("map")).out;
    expect(text).toMatch(/Computer science {2}lit 2 \(predicted\)/);
    expect(text).toMatch(/\n {4}Algorithms {2}lit 2 \(predicted\)/);
    expect(text).toMatch(/Board games {2}not lit/);
    for (const root of ["Knowledge", "Work", "Background", "People", "Views", "Life"]) expect(text).toMatch(new RegExp(`^${root}$`, "m"));
    expect(text).toMatch(/^ {2}Projects {2}0 facts\n {4}Kite {2}\d+ facts?$/m);

    const nodes = (JSON.parse((await run("map", "--json")).out) as { nodes: Node[] }).nodes;
    expect(nodes.find((n) => n.name === "reinforcement learning theory")).toMatchObject({ parent: "Machine learning", mode: "brief", depth: 2, via: "own" });
    expect(nodes.find((n) => n.name === "Algorithms")).toMatchObject({ mode: "brief", via: "own", root: "knowledge", label: "topic", state: "lit" });
    expect(nodes.find((n) => n.name === "Kite")).toMatchObject({ root: "work", label: "project", state: "lit", parent: "Projects" });

    const again = await run("map", "refresh", "--demo-llm");
    expect(again.out).toMatch(/proposed 0 lighting changes/);
  });

  it("rejects an unknown subcommand", async () => {
    const { run } = harness();
    await run("init", "--name", "T");
    expect((await run("map", "frob")).code).toBe(1);
  });
});

describe("standin map calibration", () => {
  it("shows the map score, and the presented score only with --private", async () => {
    const home = join(mkdtempSync(join(tmpdir(), "standin-cli-")), "home");
    const run = async (...argv: string[]) => {
      const out: string[] = [];
      const code = await runCli(argv, { stdout: (s) => out.push(s), stderr: () => {}, env: { STANDIN_HOME: home }, sleep: async () => {} });
      return { code, out: out.join("\n") };
    };
    await run("init", "--name", "T");
    expect((await run("map")).out).toContain("Calibration: not enough held-out answers yet");

    const store = openStore({ path: join(home, "standin.db") });
    const session = store.startSession(10);
    const held = (topic: string, holdout: "fixed" | "rotating", mode: "explain" | "decline", rating: "know" | "no_idea") => {
      const node = store.ensureTopic(topic);
      const p = store.insertProbe({ nodeId: node.id, checkOf: null, kind: "foundation", difficulty: 2, question: "?", holdout });
      store.rateResponse(store.showProbe(p.id, session.id, mode).id, rating, false);
    };
    held("a", "fixed", "explain", "know");
    held("b", "fixed", "explain", "no_idea");
    held("c", "rotating", "decline", "no_idea");
    store.close();

    const shown = (await run("map")).out;
    expect(shown).toContain("Calibration (map score): fixed 1/2 (50%), rotating 1/1 (100%)");
    expect(shown).not.toContain("Presented");
    expect((await run("map", "--private")).out).toContain("Presented score (private): fixed 1/2 (50%), rotating 1/1 (100%)");
    const json = JSON.parse((await run("map", "--json")).out) as { calibration: { map: { fixed: { n: number } } } };
    expect(json.calibration.map.fixed.n).toBe(2);
  });
});
