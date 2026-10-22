import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedLLM, type GenerateObjectRequest } from "@standin/llm";
import type { RootKey } from "@standin/schema";
import { openStore, type Store } from "@standin/store";
import { describe, expect, it } from "vitest";
import { askQuestions } from "../src/index.ts";

const store = () => openStore({ path: join(mkdtempSync(join(tmpdir(), "standin-questions-")), "db") });
/** A node under a root, holding one approved fact. */
const withFact = (s: Store, root: RootKey, name: string, label: "pet" | "project" | "topic" | "person", statement: string) => {
  const n = s.ensureNode(name, label);
  s.addEdge({ from: n.id, to: s.root(root).id, kind: "part_of", source: "placement" });
  const o = s.addObservation({ sourceKind: "manual", sourceRef: "t", authorRole: "self", text: statement, occurredAt: "2026-09-01T00:00:00.000Z" });
  const m = s.insertMemory({ kind: "fact", statement, tier: 1, isCurrentState: false, attrs: {} } as never, { sourceObservationIds: [o.id], entityIds: [n.id], actor: "compaction", homeNodeId: n.id });
  s.approve(m.id);
  return n;
};
/** Asks one question per listed node, in the order given, by the node's number in the prompt. */
const asker = (ask: (prompt: string) => { node: number; question: string }[]) =>
  new ScriptedLLM((req: GenerateObjectRequest<unknown>) => {
    expect(req.purpose).toBe("question");
    return { questions: ask(req.prompt) };
  });
const numberOf = (prompt: string, name: string) => Number(new RegExp(`\\[(\\d+)\\][^\\n]*${name}`).exec(prompt)?.[1] ?? 0);

describe("asking about gaps", () => {
  it("asks about nodes with facts outside Knowledge, never guessing, at most 3 new a refresh", async () => {
    const s = store();
    const pets = withFact(s, "life", "Pets", "pet", "I have two cats.");
    for (const p of ["Kite", "Orbit", "Lumen", "Tally"]) withFact(s, "work", p, "project", `I built ${p}.`);
    withFact(s, "knowledge", "Rust", "topic", "I know Rust.");
    const llm = asker((p) => [
      { node: numberOf(p, "Pets"), question: "What are your cats' names?" },
      ...["Kite", "Orbit", "Lumen", "Tally"].map((n) => ({ node: numberOf(p, n), question: `How did ${n} turn out?` })),
    ]);
    expect((await askQuestions(s, llm, "Lin")).asked).toBe(3);
    expect(llm.calls[0]!.prompt).not.toMatch(/Rust/);
    expect(llm.calls[0]!.prompt).toMatch(/I have two cats\./);
    expect(s.listQuestions({ status: "open" })[0]).toMatchObject({ nodeId: pets.id, text: "What are your cats' names?" });
  });

  it("drops a sensitive question, one for a node it wasn't shown, and a second for the same node", async () => {
    const s = store();
    withFact(s, "life", "Pets", "pet", "I have two cats.");
    withFact(s, "people", "Mom", "person", "My mom lives in Ohio.");
    const llm = asker((p) => [
      { node: numberOf(p, "Mom"), question: "Does your mom go to church?" },
      { node: 99, question: "Anything else?" },
      { node: numberOf(p, "Pets"), question: "What are your cats' names?" },
      { node: numberOf(p, "Pets"), question: "How old are they?" },
    ]);
    await askQuestions(s, llm, "Lin");
    expect(s.listQuestions({}).map((q) => q.text)).toEqual(["What are your cats' names?"]);
  });

  it("doesn't ask again where a question is open or was dismissed, and stops at 10 open", async () => {
    const s = store();
    const pets = withFact(s, "life", "Pets", "pet", "I have two cats.");
    const kite = withFact(s, "work", "Kite", "project", "I built Kite.");
    s.addQuestion({ nodeId: pets.id, text: "Names?" });
    s.setQuestionStatus(s.addQuestion({ nodeId: kite.id, text: "Outcome?" }).id, "dismissed");
    const llm = asker(() => []);
    await askQuestions(s, llm, "Lin");
    expect(llm.calls).toHaveLength(0);
    const busy = store();
    for (let i = 0; i < 10; i++) busy.addQuestion({ nodeId: withFact(busy, "work", `P${i}`, "project", `I built P${i}.`).id, text: `Q${i}?` });
    withFact(busy, "life", "Pets", "pet", "I have two cats.");
    await askQuestions(busy, llm, "Lin");
    expect(llm.calls).toHaveLength(0);
  });
});
