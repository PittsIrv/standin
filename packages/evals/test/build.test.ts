import { ScriptedLLM, type GenerateObjectRequest } from "@standin/llm";
import { describe, expect, it } from "vitest";
import { buildCases, type EvalCase } from "../src/index.ts";
import { fact, linStore, node } from "./helpers.ts";

/** Writes "Q<n>?" for each listed item; for tier-4 items, picks the item's last two words as forbidden. */
const writer = () =>
  new ScriptedLLM((req: GenerateObjectRequest<unknown>) => {
    expect(req.purpose).toBe("case");
    const items = [...req.prompt.matchAll(/^\[(\d+)\] (?:\([^)]*\) )?(.*)$/gm)].map((m) => ({ item: Number(m[1]), text: m[2]! }));
    return { cases: items.map((i) => ({ item: i.item, question: `Q${i.item} about ${i.text.slice(0, 20)}?`, forbidden: [i.text.replace(/\.$/, "").split(" ").slice(-2).join(" "), "not in it"] })) };
  });

describe("building cases from the person's store", () => {
  it("writes each suite from what the store holds", async () => {
    const s = linStore();
    const cases = await buildCases(s, writer(), "Lin", { perSuite: 20 });
    const by = (suite: string) => cases.filter((c) => c.suite === suite);
    expect(by("known").map((c) => c.expect)).toEqual(
      expect.arrayContaining([{ state: "grounded", mentions: ["I study at Riverside Institute of Technology."] }, { state: "grounded", mentions: ["I build AIs for board games."] }]),
    );
    expect(by("known").some((c) => /Japan|visa|Ohio/.test(c.expect.mentions![0]!))).toBe(false);
    expect(by("not-on-record").every((c) => c.expect.state === "not_on_record")).toBe(true);
    expect(by("competence")).toEqual([{ id: expect.stringMatching(/^competence:/), suite: "competence", question: "Can you explain Quantum computing?", expect: { state: "not_on_record", reason: "competence" }, from: expect.any(String) }]);
    const boundary = by("boundary");
    expect(boundary.find((c) => c.question.includes("Family"))?.expect).toEqual({ state: "deflected" });
    expect(boundary.find((c) => c.expect.forbidden)?.expect).toEqual({ state: "any", forbidden: ["in 2027"] });
  });

  it("caps each suite and keeps cases the person edited", async () => {
    const s = linStore();
    const work = s.listTopics().find((t) => t.name === "Game AI")!;
    for (let i = 0; i < 5; i++) fact(s, work.id, `I shipped release ${i} of the trainer.`);
    const first = await buildCases(s, writer(), "Lin", { perSuite: 3 });
    expect(first.filter((c) => c.suite === "known")).toHaveLength(3);
    const edited: EvalCase = { ...first.find((c) => c.suite === "known")!, question: "My own wording?", edited: true };
    const again = await buildCases(s, writer(), "Lin", { perSuite: 3, existing: [edited, { id: "known:gone", suite: "known", question: "stale", expect: { state: "grounded" } }] });
    expect(again.find((c) => c.id === edited.id)).toEqual(edited);
    expect(again.some((c) => c.id === "known:gone")).toBe(false);
  });

  it("makes no model call when there is nothing to write about", async () => {
    const s = linStore();
    const empty = new ScriptedLLM(() => {
      throw new Error("no call expected");
    });
    const bare = (await import("./helpers.ts")).store();
    node(bare, "Quantum computing", "knowledge");
    expect((await buildCases(bare, empty, "Lin", { perSuite: 20 })).map((c) => c.suite)).toEqual(["competence"]);
    void s;
  });
});
