import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SENSITIVE_CATEGORIES } from "@standin/knowledge";
import { ScriptedLLM, type GenerateObjectRequest } from "@standin/llm";
import { PRIVATE_CATEGORIES } from "@standin/speak";
import { describe, expect, it } from "vitest";
import { currentVersion, decideHeld, listVersions, preparePublish, prepareRollback, publish, PublishBlockedError, readCurrent, rollback } from "../src/index.ts";
import { fact, node, store } from "./helpers.ts";

// Built at run time so no key-shaped string sits in the repo.
const TOKEN = "ghp_" + "aB3kQ9zX7mW2pL5vR8tY4nC6aB3kQ9zX7mW2".slice(0, 36);

/** Flags every item whose text matches `sensitive`. */
const screen = (sensitive: RegExp) =>
  new ScriptedLLM((req: GenerateObjectRequest<unknown>) => {
    expect(req.purpose).toBe("sensitivity");
    const lines = req.prompt.split("\n");
    return { flags: lines.flatMap((l, i) => (sensitive.test(l) ? [{ item: i + 1, reason: "health: names a condition" }] : [])) };
  });

function setup(sensitive = /physio/) {
  const s = store();
  const dir = join(mkdtempSync(join(tmpdir(), "standin-pub-")), "published");
  const llm = screen(sensitive);
  const deps = { store: s, dir, screen: llm, personaName: "Lin", speakAt: 0.8, batch: 20 };
  return { s, dir, llm, deps };
}

describe("publishing (publish spec §4)", () => {
  it("covers every category the standin never guesses about", () => {
    for (const c of Object.keys(SENSITIVE_CATEGORIES)) expect(PRIVATE_CATEGORIES.join(";")).toContain(c === "finances" ? "money" : c);
  });

  it("holds a flagged item back, publishes the rest as version 1, and saves it privately", async () => {
    const { s, dir, deps } = setup();
    const pets = node(s, "Pets", "life", "pet");
    const cats = fact(s, pets.id, "I have two cats.");
    const physio = fact(s, node(s, "Routines", "life").id, "I see a physio every week.");
    const p = await preparePublish(deps);
    expect(p.current).toBeNull();
    expect(p.held).toEqual([{ key: `memory:${physio.id}`, kind: "memory", id: physio.id, label: "I see a physio every week.", reason: "health: names a condition" }]);
    expect(p.bundle.memories.map((m) => m.id)).toEqual([cats.id]);
    expect(p.changes.every((c) => c.change === "added")).toBe(true);
    const v1 = await publish(deps);
    expect(v1.version).toBe(1);
    expect(currentVersion(dir)).toBe(1);
    expect(readFileSync(join(dir, "0001.json"), "utf8")).not.toMatch(/physio/);
    expect(statSync(join(dir, "0001.json")).mode & 0o077).toBe(0);
  });

  it("checks each item once per text, and only new or changed ones", async () => {
    const { s, deps, llm } = setup();
    fact(s, node(s, "Pets", "life", "pet").id, "I have two cats.");
    await publish(deps);
    const calls = llm.calls.length;
    await preparePublish(deps);
    expect(llm.calls.length).toBe(calls); // nothing new
    fact(s, node(s, "Kite", "work", "project").id, "Kite is a poker solver.");
    await preparePublish(deps);
    expect(llm.calls.at(-1)!.prompt).toMatch(/poker solver/);
    expect(llm.calls.at(-1)!.prompt).not.toMatch(/two cats/);
  });

  it("Keep publishes the item from then on; Hide re-tiers a memory, rejects an exemplar, makes a node a boundary", async () => {
    const { s, deps } = setup(/physio|clinic/i);
    const routines = node(s, "Routines", "life");
    const physio = fact(s, routines.id, "I see a physio every week.");
    const clinic = node(s, "Clinic visits", "life");
    fact(s, clinic.id, "I go on Tuesdays.");
    const o = s.addObservation({ sourceKind: "manual", sourceRef: "t", authorRole: "self", text: "x", occurredAt: "2026-09-01T00:00:00.000Z" });
    const ex = s.insertExemplar({ observationId: o.id, text: "ugh physio again lol", register: "casual" })!;
    s.approveExemplar(ex.id);
    const p = await preparePublish(deps);
    expect(p.held.map((h) => h.key).sort()).toEqual([`exemplar:${ex.id}`, `memory:${physio.id}`, `node:${clinic.id}`].sort());
    decideHeld(s, `memory:${physio.id}`, "keep");
    decideHeld(s, `exemplar:${ex.id}`, "hide");
    decideHeld(s, `node:${clinic.id}`, "hide");
    expect(s.getMemory(physio.id).tier).toBe(1);
    expect(s.listExemplars({ status: "rejected" }).map((e) => e.id)).toEqual([ex.id]);
    expect(s.getTopic(clinic.id).boundaryTier).toBe(3);
    const after = await preparePublish(deps);
    expect(after.held).toEqual([]);
    const json = JSON.stringify(after.bundle);
    expect(json).toMatch(/physio every week/);
    expect(json).not.toMatch(/Clinic|Tuesdays|physio again/);
  });

  it("a hidden memory goes to tier 3 and stays out", async () => {
    const { s, deps } = setup();
    const physio = fact(s, node(s, "Routines", "life").id, "I see a physio every week.");
    await preparePublish(deps);
    decideHeld(s, `memory:${physio.id}`, "hide");
    expect(s.getMemory(physio.id).tier).toBe(3);
    expect((await preparePublish(deps)).bundle.memories).toEqual([]);
  });

  it("the final scan stops a publish, and the flagged text never reaches the model", async () => {
    const { s, dir, deps, llm } = setup();
    const tools = node(s, "Tools", "work");
    const m = fact(s, tools.id, "I use GitHub.");
    s.db.prepare("UPDATE memories SET statement = ? WHERE id = ?").run(`I use GitHub, token ${TOKEN}.`, m.id);
    const p = await preparePublish(deps);
    expect(p.findings).toEqual([expect.objectContaining({ key: `memory:${m.id}`, label: "GitHub token" })]);
    await expect(publish(deps)).rejects.toThrow(PublishBlockedError);
    expect(existsSync(join(dir, "current"))).toBe(false);
    expect(JSON.stringify(llm.calls)).not.toContain(TOKEN.slice(4));
  });

  it("a failed sensitivity call publishes nothing", async () => {
    const { s, dir, deps } = setup();
    fact(s, node(s, "Pets", "life", "pet").id, "I have two cats.");
    const broken = new ScriptedLLM(() => {
      throw new Error("overloaded");
    });
    await expect(publish({ ...deps, screen: broken })).rejects.toThrow(/overloaded/);
    expect(existsSync(join(dir, "current"))).toBe(false);
  });
});

describe("versions and rollback (decision 108)", () => {
  it("keeps every version, and rolls back as a new version without what's no longer publishable", async () => {
    const { s, dir, deps } = setup();
    const pets = node(s, "Pets", "life", "pet");
    const cats = fact(s, pets.id, "I have two cats.");
    const hamster = fact(s, pets.id, "I had a hamster.");
    await publish(deps);
    s.retract(cats.id);
    const kite = fact(s, node(s, "Kite", "work", "project").id, "Kite is a poker solver.");
    await publish(deps);
    expect(listVersions(dir).map((v) => [v.version, v.memories])).toEqual([
      [2, 2],
      [1, 2],
    ]);
    const preview = prepareRollback(deps, 1);
    expect(preview.bundle.memories.map((m) => m.id)).toEqual([hamster.id]); // the cats were retracted since
    expect(preview.changes.map((c) => [c.change, c.key])).toContainEqual(["removed", `memory:${kite.id}`]);
    const v3 = rollback(deps, 1);
    expect(v3.version).toBe(3);
    expect(readCurrent(dir)!.memories.map((m) => m.id)).toEqual([hamster.id]);
    expect(listVersions(dir)).toHaveLength(3);
  });
});
