import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@standin/store";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/main.ts";

function harness() {
  const home = join(mkdtempSync(join(tmpdir(), "standin-cli-")), "home");
  let stdin = "";
  const run = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, {
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      env: { STANDIN_HOME: home },
      readStdin: async () => stdin,
      sleep: async () => {},
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  const observations = () => {
    const store = openStore({ path: join(home, "standin.db") });
    try {
      return store.uncompactedObservations(100);
    } finally {
      store.close();
    }
  };
  return { home, run, observations, setStdin: (s: string) => (stdin = s) };
}

/** Fills the `copy`-th occurrence (1-based) of a heading. */
function fillCopy(sheet: string, heading: string, copy: number, answer: string): string {
  let seen = 0;
  return sheet.replace(new RegExp(`(### ${heading.replace(/\./g, "\\.")}\\n(?:>.*\\n)+)`, "g"), (m) => (++seen === copy ? `${m}\n${answer}\n` : m));
}

describe("standin tell", () => {
  it("adds a self-authored manual observation that compaction turns into a proposal", async () => {
    const { run, observations } = harness();
    await run("init", "--name", "T");
    const res = await run("tell", "I ran my first marathon in 2024.");
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/obs_[0-9a-f]{12}/);
    expect(res.out).toContain("Next: standin compact");
    const [o] = observations();
    expect(o).toMatchObject({ sourceKind: "manual", authorRole: "self", text: "I ran my first marathon in 2024." });
    expect(o!.sourceRef).toMatch(/^tell:\d{4}-/);
  });

  it("reads text from a file or stdin", async () => {
    const { home, run, observations, setStdin } = harness();
    await run("init", "--name", "T");
    const file = join(home, "facts.txt");
    writeFileSync(file, "I can solve a Rubik's cube in under a minute.");
    expect((await run("tell", "--file", file)).code).toBe(0);
    setStdin("I have two cats.");
    expect((await run("tell")).code).toBe(0);
    expect(observations().map((o) => o.text).sort()).toEqual(["I can solve a Rubik's cube in under a minute.", "I have two cats."]);
  });

  it("refuses empty or non-English text and writes nothing", async () => {
    const { run, observations, setStdin } = harness();
    await run("init", "--name", "T");
    expect((await run("tell", "")).err).toContain("nothing to tell");
    setStdin("   ");
    expect((await run("tell")).err).toContain("nothing to tell");
    const zh = await run("tell", "我从小跟外公下围棋。");
    expect(zh.code).toBe(1);
    expect(zh.err).toContain("English-only");
    expect(observations()).toEqual([]);
  });
});

describe("detailed banks", () => {
  it("imports one observation per project, idempotently, and re-imports only an edited item", async () => {
    const { home, run, observations } = harness();
    await run("init", "--name", "T");
    const sheet = join(home, "projects.md");
    expect((await run("interview", "template", "--bank", "projects-v1", "--out", sheet)).code).toBe(0);
    let md = readFileSync(sheet, "utf8");
    md = fillCopy(md, "projects.name", 1, "Kite, a Go-variant engine.");
    md = fillCopy(md, "projects.stack", 1, "Rust.");
    md = fillCopy(md, "projects.name", 2, "Lantern Bot, a card-game agent.");
    md = fillCopy(md, "projects.stack", 2, "Rust.");
    md = fillCopy(md, "next.build", 1, "A poker trainer.");
    writeFileSync(sheet, md);

    const first = JSON.parse((await run("interview", "import", sheet, "--json")).out) as { answers: { key: string; status: string }[] };
    expect(first.answers.map((a) => [a.key, a.status])).toEqual([
      ["projects.1", "added"],
      ["projects.2", "added"],
      ["next.build", "added"],
    ]);
    expect(observations().map((o) => o.sourceRef).sort()).toEqual([
      "interview:projects-v1#next.build",
      "interview:projects-v1#projects.1",
      "interview:projects-v1#projects.2",
    ]);
    expect((await run("interview", "import", sheet)).out).toContain("added 0, unchanged 3");

    writeFileSync(sheet, md.replace("Lantern Bot, a card-game agent.", "Lantern Bot, a self-play card-game agent."));
    expect((await run("interview", "import", sheet)).out).toContain("added 1, unchanged 2");
  });

  it("lists every bank when the name is unknown", async () => {
    const { run } = harness();
    await run("init", "--name", "T");
    const res = await run("interview", "template", "--bank", "nope", "--stdout");
    expect(res.code).toBe(1);
    for (const id of ["core-v1", "projects-v1", "skills-v1", "education-v1", "opinions-v1", "life-v1"]) expect(res.err).toContain(id);
  });
});

describe("secrets and contacts on the way in (personal-data guard)", () => {
  // Built at run time so no key-shaped string sits in the repo.
  const TOKEN = "ghp_" + "aB3kQ9zX7mW2pL5vR8tY4nC6aB3kQ9zX7mW2".slice(0, 36);

  it("refuses to tell a secret, says where it is without printing it, and saves nothing", async () => {
    const { run, observations } = harness();
    await run("init", "--name", "T");
    const res = await run("tell", `I use GitHub.\nMy token is ${TOKEN} for work.`);
    expect(res.code).toBe(1);
    expect(res.err).toContain("GitHub token (line 2:");
    expect(res.err).toContain("never needs it");
    expect(res.err).not.toContain(TOKEN.slice(4));
    expect(observations()).toEqual([]);
  });

  it("cuts contact details from what you tell, and says how many", async () => {
    const { run, observations } = harness();
    await run("init", "--name", "T");
    const res = await run("tell", "Reach me at lin@example.edu about Go.");
    expect(res.code).toBe(0);
    expect(res.out).toContain("1 contact detail removed");
    expect(observations()[0]!.text).toBe("Reach me at [removed] about Go.");
  });

  it("refuses a whole interview import that holds a secret, listing every answer that does", async () => {
    const { home, run, observations } = harness();
    await run("init", "--name", "T");
    const sheet = join(home, "projects.md");
    await run("interview", "template", "--bank", "projects-v1", "--out", sheet);
    let md = readFileSync(sheet, "utf8");
    md = fillCopy(md, "projects.name", 1, "Kite, a Go-variant engine.");
    md = fillCopy(md, "projects.stack", 1, `Rust. Deploy key ${TOKEN}.`);
    md = fillCopy(md, "next.build", 1, "A poker trainer; my password is Hunter2!");
    writeFileSync(sheet, md);
    const res = await run("interview", "import", sheet);
    expect(res.code).toBe(1);
    expect(res.err).toContain("projects.1: GitHub token");
    expect(res.err).toContain("next.build: password");
    expect(res.err).toContain("Nothing was imported");
    expect(res.err).not.toContain(TOKEN.slice(4));
    expect(observations()).toEqual([]);
  });
});
