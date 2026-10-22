import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@standin/store";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/main.ts";

// Built at run time so no key-shaped string sits in the repo.
const TOKEN = "ghp_" + "aB3kQ9zX7mW2pL5vR8tY4nC6aB3kQ9zX7mW2".slice(0, 36);

async function instance() {
  const home = join(mkdtempSync(join(tmpdir(), "standin-scan-")), "home");
  const run = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, { stdout: (s) => out.push(s), stderr: (s) => err.push(s), env: { STANDIN_HOME: home }, sleep: async () => {} });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  await run("init", "--name", "Lin");
  // Data from before the guard: written straight into the database and files.
  const store = openStore({ path: join(home, "standin.db") });
  const o = store.addObservation({ sourceKind: "manual", sourceRef: "t", authorRole: "self", text: "I like Go.", occurredAt: "2026-09-01T00:00:00.000Z" });
  store.db.prepare("UPDATE observations SET text = ? WHERE id = ?").run(`I like Go. My token is ${TOKEN}.`, o.id);
  store.close();
  mkdirSync(join(home, "evals"), { recursive: true });
  writeFileSync(join(home, "evals", "cases.jsonl"), `${JSON.stringify({ id: "known:a", suite: "known", question: `Is ${TOKEN} yours?`, expect: { state: "grounded" } })}\n`);
  mkdirSync(join(home, "interviews"), { recursive: true });
  writeFileSync(join(home, "interviews", "life-v1.md"), "### life.pets\n\nTwo cats. Call 412-555-0100.\n");
  return { home, run, observationId: o.id };
}

describe("standin scan", () => {
  it("lists what was stored before the guard, by place and masked, and changes nothing", async () => {
    const { home, run, observationId } = await instance();
    const r = await run("scan");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`observation ${observationId}  GitHub token  “Go. My token is •••.”`);
    expect(r.out).toContain("evals/cases.jsonl line 1  GitHub token");
    expect(r.out).toContain("interviews/life-v1.md line 3  phone number");
    expect(r.out).toContain("2 secrets and 1 contact detail found. Run standin scan --purge to remove them; it can't be undone.");
    expect(r.out).not.toContain(TOKEN.slice(4));
    expect(readFileSync(join(home, "evals", "cases.jsonl"), "utf8")).toContain(TOKEN);
  });

  it("purges the database and the files, then finds nothing", async () => {
    const { home, run } = await instance();
    const r = await run("scan", "--purge");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Removed: 1 field rewritten in the database, 2 files rewritten.");
    expect(readFileSync(join(home, "evals", "cases.jsonl"), "utf8")).toContain('"question":"Is [removed] yours?"');
    expect(readFileSync(join(home, "interviews", "life-v1.md"), "utf8")).toBe("### life.pets\n\nTwo cats. Call [removed].\n");
    expect((await run("scan")).out).toBe("Nothing found.");
  });

  it("prints JSON", async () => {
    const { run } = await instance();
    const r = JSON.parse((await run("scan", "--json")).out) as { findings: { where: string; label: string }[] };
    expect(r.findings.map((f) => f.label)).toEqual(["GitHub token", "GitHub token", "phone number"]);
  });
});
