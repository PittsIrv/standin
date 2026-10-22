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
    expect(refreshed.out).toMatch(/hypotheses: \+\d+/);
    expect(refreshed.out).toContain("Next: standin queue");

    const text = (await run("map")).out;
    expect(text).toMatch(/Computer science {2}probable 2 \(p 0\.50, degree\)/);
    expect(text).toMatch(/\n {4}Algorithms {2}probable 2 \(p 0\.50, degree\)/);
    expect(text).toMatch(/Board games {2}not lit/);
    for (const root of ["Knowledge", "Work", "Background", "People", "Views", "Life"]) expect(text).toMatch(new RegExp(`^${root}$`, "m"));
    expect(text).toMatch(/^ {2}Projects {2}0 facts\n {4}Kite {2}\d+ facts?$/m);

    const nodes = (JSON.parse((await run("map", "--json")).out) as { nodes: Node[] }).nodes;
    expect(nodes.find((n) => n.name === "reinforcement learning theory")).toMatchObject({ parent: "Machine learning", mode: "brief", depth: 2, via: "own" });
    expect(nodes.find((n) => n.name === "Algorithms")).toMatchObject({ mode: "decline", root: "knowledge", label: "topic", state: "probable", p: 0.5 });
    expect(nodes.find((n) => n.name === "Kite")).toMatchObject({ root: "work", label: "project", state: "lit", parent: "Projects" });

    const again = await run("map", "refresh", "--demo-llm");
    expect(again.out).toMatch(/hypotheses: \+0/);
  });

  it("rejects an unknown subcommand", async () => {
    const { run } = harness();
    await run("init", "--name", "T");
    expect((await run("map", "frob")).code).toBe(1);
  });
});

describe("standin map scores", () => {
  it("shows how often the prediction matched your answers, and the guess score only with --private", async () => {
    const home = join(mkdtempSync(join(tmpdir(), "standin-cli-")), "home");
    const run = async (...argv: string[]) => {
      const out: string[] = [];
      const code = await runCli(argv, { stdout: (s) => out.push(s), stderr: () => {}, env: { STANDIN_HOME: home }, sleep: async () => {} });
      return { code, out: out.join("\n") };
    };
    await run("init", "--name", "T");
    expect((await run("map")).out).toContain("Map score: no answers yet");

    const store = openStore({ path: join(home, "standin.db") });
    const session = store.startSession(10);
    const said = (topic: string, mode: "explain" | "decline", level: number) => {
      const node = store.ensureTopic(topic);
      const p = store.insertProbe({ nodeId: node.id, checkOf: null, kind: "card", difficulty: 1, question: "?", holdout: "none" });
      store.answerCard(store.showProbe(p.id, session.id, mode).id, level);
    };
    said("a", "explain", 3);
    said("b", "explain", 0);
    said("c", "decline", 1);
    store.close();

    const shown = (await run("map")).out;
    expect(shown).toContain("Map score: 2/3 (67%) of your answers matched the standin's prediction");
    expect(shown).not.toContain("Hypothesis calibration");
    expect((await run("map", "--private")).out).toContain("Hypothesis calibration: not enough answers about guesses yet");
    const json = JSON.parse((await run("map", "--json")).out) as { scores: { map: { n: number } } };
    expect(json.scores.map.n).toBe(3);
  });
});

describe("standin map hypothesis calibration", () => {
  it("compares calibrated and prior-only guesses on held-out answers, privately", async () => {
    const home = join(mkdtempSync(join(tmpdir(), "standin-cli-")), "home");
    const run = async (...argv: string[]) => {
      const out: string[] = [];
      const code = await runCli(argv, { stdout: (s) => out.push(s), stderr: () => {}, env: { STANDIN_HOME: home }, sleep: async () => {} });
      return { code, out: out.join("\n") };
    };
    await run("init", "--name", "T");
    const store = openStore({ path: join(home, "standin.db") });
    const session = store.startSession(10);
    for (const rating of ["know", "no_idea"] as const) {
      const node = store.ensureTopic(`n-${rating}`);
      const h = store.insertHypothesis({ nodeId: node.id, depth: 2, rawScore: "medium", kind: "part", path: [node.id], reason: "r" });
      const p = store.insertProbe({ nodeId: node.id, checkOf: null, kind: "hypothesis", difficulty: 2, question: "?", holdout: "fixed", hypothesisId: h.id });
      store.rateResponse(store.showProbe(p.id, session.id, "decline", { predictedP: 0.9, priorP: 0.5 }).id, rating, false);
    }
    store.close();
    const priv = (await run("map", "--private")).out;
    expect(priv).toContain("Hypothesis calibration: Brier 0.41 (calibrated) vs 0.25 (prior) over 2 answers; using prior-only probabilities");
    expect((await run("map")).out).not.toContain("Hypothesis calibration");
  });
});
