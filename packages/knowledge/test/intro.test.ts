import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedLLM, type GenerateObjectRequest } from "@standin/llm";
import { openStore } from "@standin/store";
import { describe, expect, it } from "vitest";
import { loadSnapshot, needsIntro, readIntro, saveIntro, seedBackground, skipIntro } from "../src/index.ts";

const store = () => openStore({ path: join(mkdtempSync(join(tmpdir(), "standin-intro-")), "db") });
const concept = (name: string, depth: number, reason = `because of ${name}`) => ({ name, definition: `${name}.`, examples: ["a", "b", "c"], depth, reason });

describe("the introduction", () => {
  it("reads statements out of the text: trimmed, deduplicated, never a sensitive one, at most 12", async () => {
    const llm = new ScriptedLLM((req: GenerateObjectRequest<unknown>) => {
      expect(req.purpose).toBe("intro");
      expect(req.prompt).toContain("PhD student");
      return {
        statements: [" I'm a PhD student in CS at CMU. ", "", "I'm a PhD student in CS at CMU.", "I go to church every Sunday.", ...Array.from({ length: 15 }, (_, i) => `Fact ${i}.`)],
      };
    });
    const out = await readIntro(llm, "I'm a PhD student in CS at CMU and I go to church.", "Mingxi");
    expect(out[0]).toBe("I'm a PhD student in CS at CMU.");
    expect(out).not.toContain("I go to church every Sunday.");
    expect(out).toHaveLength(12);
  });

  it("stores only what the person confirmed: the text as an observation, each statement an approved background fact", () => {
    const s = store();
    const { saved, dropped } = saveIntro(s, "Raw intro text.", ["I research RL for robotics.", "  ", "My salary is 100k.", "I did my undergrad in math."]);
    expect(saved.map((m) => m.statement)).toEqual(["I research RL for robotics.", "I did my undergrad in math."]);
    expect(dropped).toEqual(["My salary is 100k."]);
    const facts = s.listMemories({ status: "approved", kind: "fact" });
    expect(facts.map((m) => m.attrs)).toEqual([{ background: true }, { background: true }]);
    const obs = s.memorySources(saved[0]!.id)[0]!;
    expect([obs.sourceKind, obs.authorRole, obs.text]).toEqual(["intro", "self", "Raw intro text."]);
  });

  it("is needed until there is a background, or the person skips it", () => {
    const a = store();
    expect(needsIntro(a)).toBe(true);
    skipIntro(a);
    expect(needsIntro(a)).toBe(false);
    const b = store();
    saveIntro(b, "x", ["I'm a CS master's student."]);
    expect(needsIntro(b)).toBe(false);
  });
});

describe("seeding from background", () => {
  it("guesses each concept at the depth the model picked, with its reason and evidence kind, and stores examples", async () => {
    const s = store();
    saveIntro(s, "x", ["I research RL for robotics."]);
    const llm = new ScriptedLLM(() => ({
      field: concept("Robotics", 3),
      core: [concept("Reinforcement learning", 3, "you research RL"), concept("Control theory", 9)],
      evidence: "work",
    }));
    await seedBackground(s, llm, "Mingxi");
    const t = loadSnapshot(s);
    const rl = s.ensureTopic("Reinforcement learning");
    expect(t.hypotheses.get(rl.id)).toMatchObject({ depth: 3, kind: "work", reason: "you research RL" });
    expect(t.hypotheses.get(s.ensureTopic("Control theory").id)?.depth).toBe(4);
    expect(rl.examples).toEqual(["a", "b", "c"]);
  });

  it("seeds nothing for a statement with no field, and doesn't ask about it again", async () => {
    const s = store();
    saveIntro(s, "x", ["I have two cats."]);
    const llm = new ScriptedLLM(() => ({ field: null, core: [], evidence: "background" }));
    await seedBackground(s, llm, "Mingxi");
    await seedBackground(s, llm, "Mingxi");
    expect(llm.calls).toHaveLength(1);
    expect(s.listHypotheses({})).toEqual([]);
  });

  it("never guesses what the person already spoke to, or a sensitive concept", async () => {
    const s = store();
    const o = s.addObservation({ sourceKind: "interview", sourceRef: "i", authorRole: "self", text: "seed", occurredAt: "2026-09-01T00:00:00.000Z" });
    const m = s.insertMemory({ kind: "competence", statement: "I know Rust.", tier: 1, isCurrentState: false, attrs: { domain: "Rust", depth: 3 } } as never, {
      sourceObservationIds: [o.id],
      entityIds: [s.ensureTopic("Rust").id],
      actor: "compaction",
    });
    s.approve(m.id);
    saveIntro(s, "x", ["I write systems software."]);
    const llm = new ScriptedLLM(() => ({ field: concept("Systems programming", 2), core: [concept("Rust", 2), concept("Bible study", 2)], evidence: "work" }));
    await seedBackground(s, llm, "Mingxi");
    const guessed = s.listHypotheses({}).map((h) => s.getTopic(h.nodeId).name);
    expect(guessed).toEqual(["Systems programming"]);
  });
});
