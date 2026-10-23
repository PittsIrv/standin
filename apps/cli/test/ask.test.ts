import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBundle, saveVersion } from "@standin/publish";
import { openStore } from "@standin/store";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/main.ts";

function harness() {
  const home = join(mkdtempSync(join(tmpdir(), "standin-ask-")), "home");
  const run = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, { stdout: (s) => out.push(s), stderr: (s) => err.push(s), env: { STANDIN_HOME: home }, sleep: async () => {} });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  const withStore = <T>(fn: (s: ReturnType<typeof openStore>) => T): T => {
    const s = openStore({ path: join(home, "standin.db") });
    try {
      return fn(s);
    } finally {
      s.close();
    }
  };
  return { run, withStore, home };
}

/** Lin with two cats on a Pets node under Life. */
async function lin() {
  const h = harness();
  await h.run("init", "--name", "Lin");
  const id = h.withStore((s) => {
    const pets = s.ensureNode("Pets", "pet");
    s.addEdge({ from: pets.id, to: s.root("life").id, kind: "part_of", source: "placement" });
    const o = s.addObservation({ sourceKind: "manual", sourceRef: "t", authorRole: "self", text: "I have two cats.", occurredAt: "2026-09-01T00:00:00.000Z" });
    const m = s.insertMemory({ kind: "fact", statement: "I have two cats.", tier: 1, isCurrentState: false, attrs: {} } as never, { sourceObservationIds: [o.id], entityIds: [pets.id], actor: "compaction", homeNodeId: pets.id });
    s.approve(m.id);
    return m.id;
  });
  return { h, id };
}

describe("standin ask", () => {
  it("--published answers from the published version, not from what was approved since", async () => {
    const { h } = await lin();
    expect((await h.run("ask", "--published", "--demo-llm", "Do you have cats?")).err).toMatch(/Nothing is published yet/);
    // Publish while the standin knows nothing, then approve the cats: only the draft knows them.
    const home = join(h.home, "published");
    h.withStore((s) => {
      const empty = buildBundle(s, { personaName: "Lin", speakAt: 0.8 });
      saveVersion(home, { ...empty, memories: [] });
    });
    expect((await h.run("ask", "--published", "--demo-llm", "Do you have cats?")).out).toMatch(/^I don't know\./);
    expect((await h.run("ask", "--demo-llm", "Do you have cats?")).out).toMatch(/two cats/);
  });

  it("refuses a question with a secret in it before any model sees it", async () => {
    const { h } = await lin();
    const token = "ghp_" + "aB3kQ9zX7mW2pL5vR8tY4nC6aB3kQ9zX7mW2".slice(0, 36);
    const r = await h.run("ask", "--demo-llm", `Is ${token} my token?`);
    expect(r.code).toBe(1);
    expect(r.err).toContain("GitHub token");
    expect(h.withStore((s) => s.db.prepare("SELECT COUNT(*) AS n FROM spans").get())).toEqual({ n: 0 });
  });

  it("answers a known fact grounded, with its citation", async () => {
    const { h } = await lin();
    const r = await h.run("ask", "--demo-llm", "Do you have cats?");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/I have two cats\./);
    expect(r.out).toMatch(/\[grounded\]/);
    expect(r.out).toMatch(/- I have two cats\. \(Pets\)/);
  });

  it("says when something isn't on record, and shows its work", async () => {
    const { h } = await lin();
    const r = await h.run("ask", "--demo-llm", "--work", "What's your favorite color?");
    expect(r.out).toMatch(/\[not on record: nothing\]/);
    expect(r.out).toMatch(/Candidates: none/);
  });

  it("prints the whole reply as JSON", async () => {
    const { h, id } = await lin();
    const r = await h.run("ask", "--demo-llm", "--json", "Do you have cats?");
    const reply = JSON.parse(r.out);
    expect(reply).toMatchObject({ state: "grounded", cites: [{ id }], work: { seeds: [{ name: "Pets" }] } });
  });

  it("needs a question", async () => {
    const { h } = await lin();
    const r = await h.run("ask");
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/usage: standin ask/);
  });
});
