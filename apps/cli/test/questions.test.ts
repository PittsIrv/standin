import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@standin/store";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/main.ts";

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "standin-cli-"));
  const home = join(dir, "home");
  const run = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, { stdout: (s) => out.push(s), stderr: (s) => err.push(s), env: { STANDIN_HOME: home }, sleep: async () => {} });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  /** Opens the instance's store for setup, then closes it. */
  const withStore = <T>(fn: (s: ReturnType<typeof openStore>) => T): T => {
    const s = openStore({ path: join(home, "standin.db") });
    try {
      return fn(s);
    } finally {
      s.close();
    }
  };
  return { dir, home, run, withStore };
}

describe("standin questions", () => {
  it("lists open questions, prints them as a sheet, and an imported sheet answers them", async () => {
    const h = harness();
    await h.run("init", "--name", "Lin");
    expect((await h.run("questions")).out).toContain("No open questions.");
    const id = h.withStore((s) => {
      const pets = s.ensureNode("Pets", "pet");
      s.addEdge({ from: pets.id, to: s.root("life").id, kind: "part_of", source: "placement" });
      return s.addQuestion({ nodeId: pets.id, text: "What are your cats' names?" }).id;
    });
    expect((await h.run("questions")).out).toMatch(new RegExp(`${id} +Life › Pets +What are your cats' names\\?`));
    const sheet = (await h.run("questions", "--sheet")).out;
    expect(sheet).toContain(`### ${id}`);
    expect(sheet).toContain("> **What are your cats' names?**");
    const file = join(h.dir, "answers.md");
    writeFileSync(file, sheet.replace("> **What are your cats' names?**", "> **What are your cats' names?**\n\nMiso and Tofu."));
    const imported = await h.run("interview", "import", file);
    expect(imported.out).toMatch(/added 1/);
    expect(h.withStore((s) => s.getQuestion(id).status)).toBe("answered");
  });
});

describe("standin outcomes", () => {
  it("won't export until sharing is turned on, then writes text-free records to a local file", async () => {
    const h = harness();
    await h.run("init", "--name", "Lin");
    const refused = await h.run("outcomes", "export");
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain('"sharing": { "outcomes": true }');
    const config = join(h.home, "config.json");
    writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, "utf8")), sharing: { outcomes: true } }));
    const out = join(h.dir, "o.json");
    const done = await h.run("outcomes", "export", "--out", out);
    expect(done.out).toContain("0 records");
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({ records: [] });
  });

  it("loads default reliabilities capped per cell, and clears them", async () => {
    const h = harness();
    await h.run("init", "--name", "Lin");
    const file = join(h.dir, "priors.json");
    writeFileSync(file, JSON.stringify({ "job:medium": { a: 30, b: 10 } }));
    expect((await h.run("outcomes", "priors", file)).out).toContain("job:medium  a 7.5  b 2.5");
    expect(h.withStore((s) => s.getKv("priors"))).toBe(JSON.stringify({ "job:medium": { a: 7.5, b: 2.5 } }));
    writeFileSync(file, JSON.stringify({ "job:medium": { a: -1, b: 1 } }));
    expect((await h.run("outcomes", "priors", file)).err).toContain("positive counts");
    await h.run("outcomes", "priors", "--clear");
    expect(h.withStore((s) => s.getKv("priors"))).toBeNull();
  });
});
