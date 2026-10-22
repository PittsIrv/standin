import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedLLM, type GenerateObjectRequest } from "@standin/llm";
import { SecretFoundError } from "@standin/airlock";
import { openStore } from "@standin/store";
import { describe, expect, it } from "vitest";
import { loadSnapshot, needsIntro, readSource, saveIntro, seedBackground, skipIntro, type ConfirmedStatement, type IntroSource } from "../src/index.ts";

const store = () => openStore({ path: join(mkdtempSync(join(tmpdir(), "standin-intro-")), "db") });
const RESUME: IntroSource = {
  id: "src1",
  kind: "file",
  ref: "cv.pdf",
  text: "EDUCATION\nBS in Mathematics, State University (2015–2019)\n\nEXPERIENCE\nResearch intern, Robotics Lab (2022–present): built a motion-planning stack for legged robots.",
};
const said = (statement: string, o: Partial<ConfirmedStatement> = {}): ConfirmedStatement => ({
  sourceId: "src1",
  statement,
  quote: statement,
  kind: "other",
  kindLabel: null,
  start: null,
  end: null,
  current: false,
  ...o,
});
/** Saves statements typed into the box: the box's text is what they quote. */
const intro = (s: ReturnType<typeof store>, ...said: ConfirmedStatement[]) =>
  saveIntro(s, [{ id: "box", kind: "intro", ref: "your introduction", text: said.map((x) => x.quote).join("\n") }], said.map((x) => ({ ...x, sourceId: "box" })));

describe("reading a source", () => {
  it("reads each section, keeps statements whose quote is in the source, and counts the rest", async () => {
    const llm = new ScriptedLLM((req: GenerateObjectRequest<unknown>) => {
      expect(req.purpose).toBe("intro");
      expect(req.system).toMatch(/one fact each, not one line each/);
      if (req.prompt.includes("EDUCATION"))
        return { statements: [{ statement: "I have a BS in math.", quote: "BS in Mathematics, State University (2015-2019)", kind: "education", start: "2015", end: "2019" }] };
      return {
        statements: [
          { statement: "I build motion planners for legged robots.", quote: "built a motion-planning stack for legged robots", kind: "project", current: true },
          { statement: "I lead the lab.", quote: "Director of the Robotics Lab", kind: "occupation" },
          { statement: "I go to church every week.", quote: "Research intern, Robotics Lab", kind: "routine" },
          { statement: "I intern at a robotics lab.", quote: "Research intern, Robotics Lab (2022–present)", kind: "internship" },
        ],
      };
    });
    const r = await readSource(llm, RESUME, "Mingxi");
    expect(llm.calls).toHaveLength(2);
    expect(r.statements.map((s) => [s.statement, s.kind, s.kindLabel])).toEqual([
      ["I have a BS in math.", "education", null],
      ["I build motion planners for legged robots.", "project", null],
      ["I intern at a robotics lab.", "other", "internship"],
    ]);
    expect(r.statements[0]).toMatchObject({ sourceId: "src1", start: "2015", end: "2019", current: false });
    expect([r.notFound, r.sensitive]).toEqual([1, 1]);
  });
});

describe("saving an introduction", () => {
  it("keeps only sources a confirmed statement came from, as text, and stores each statement with its kind and quote", () => {
    const s = store();
    const other: IntroSource = { id: "src2", kind: "website", ref: "https://lin.example/", text: "Nothing confirmed from here." };
    const { saved, dropped } = saveIntro(s, [RESUME, other], [
      said("I research legged robots.", { quote: "built a motion-planning stack for legged robots", kind: "project", current: true }),
      said("  "),
      said("My salary is 100k.", { quote: "Research intern, Robotics Lab" }),
      said("I invented this.", { quote: "Nobel Prize in Physics" }),
    ]);
    expect(saved.map((m) => [m.statement, m.attrs])).toEqual([
      ["I research legged robots.", { background: true, kind: "project", quote: "built a motion-planning stack for legged robots", current: true }],
    ]);
    expect(dropped).toEqual(["My salary is 100k."]);
    const obs = s.memorySources(saved[0]!.id)[0]!;
    expect([obs.sourceKind, obs.sourceRef, obs.text]).toEqual(["file", "cv.pdf", RESUME.text]);
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM observations").get()).toEqual({ n: 1 });
  });

  it("doesn't store a statement that is already a fact", () => {
    const s = store();
    intro(s, said("I research RL."));
    const { saved } = intro(s, said("i research rl."), said("I build robots."));
    expect(saved.map((m) => m.statement)).toEqual(["I build robots."]);
  });

  it("is needed until there is a background, or the person skips it", () => {
    const a = store();
    expect(needsIntro(a)).toBe(true);
    skipIntro(a);
    expect(needsIntro(a)).toBe(false);
    const b = store();
    intro(b, said("I'm a CS master's student."));
    expect(needsIntro(b)).toBe(false);
  });
});

const concept = (name: string, depth: number, evidence: { fact: number; type: string }[], partOf: string | null = null) => ({
  name,
  definition: `${name}.`,
  examples: ["a", "b", "c"],
  depth,
  reason: `because of ${name}`,
  partOf,
  evidence,
});

describe("saving an edited statement with a secret", () => {
  it("refuses the whole save", () => {
    const s = store();
    const token = "ghp_" + "aB3kQ9zX7mW2pL5vR8tY4nC6aB3kQ9zX7mW2".slice(0, 36);
    const box: IntroSource = { id: "box", kind: "intro", ref: "your introduction", text: "I use GitHub." };
    expect(() => saveIntro(s, [box], [said(`I use GitHub, token ${token}`, { sourceId: "box", quote: "I use GitHub." })])).toThrow(SecretFoundError);
    expect(s.listMemories({})).toEqual([]);
  });
});

describe("seeding from background evidence", () => {
  it("makes one call over every new fact, and guesses each concept with its strongest evidence and how much there is", async () => {
    const s = store();
    intro(
      s,
      said("I research RL for robots.", { kind: "occupation", current: true }),
      said("I published a paper on policy gradients.", { kind: "publication" }),
      said("I took a course on control.", { kind: "education" }),
    );
    const llm = new ScriptedLLM((req: GenerateObjectRequest<unknown>) => {
      expect(req.prompt).toMatch(/\[1\] \(occupation, current\) I research RL for robots\./);
      return {
        concepts: [
          concept("Robotics", 3, [{ fact: 1, type: "job" }]),
          concept("Reinforcement learning", 3, [{ fact: 1, type: "job" }, { fact: 2, type: "publication" }], "Robotics"),
          concept("Control theory", 9, [{ fact: 3, type: "course" }], "Robotics"),
          concept("Unfounded", 2, [{ fact: 7, type: "job" }]),
        ],
      };
    });
    await seedBackground(s, llm, "Mingxi");
    await seedBackground(s, llm, "Mingxi");
    expect(llm.calls).toHaveLength(1);
    const t = loadSnapshot(s);
    const rl = s.ensureTopic("Reinforcement learning");
    expect(t.hypotheses.get(rl.id)).toMatchObject({ depth: 3, kind: "publication", rawScore: "medium", reason: "because of Reinforcement learning" });
    expect(t.hypotheses.get(s.ensureTopic("Control theory").id)).toMatchObject({ depth: 4, kind: "course", rawScore: "low" });
    expect(s.homeParent(rl.id)).toBe(s.ensureTopic("Robotics").id);
    expect(s.homeParent(s.ensureTopic("Robotics").id)).toBe(s.root("knowledge").id);
    expect(rl.examples).toEqual(["a", "b", "c"]);
    expect(s.findEntity({ name: "Unfounded", kind: "topic" })).toBeNull();
  });

  it("seeds nothing from facts with no knowledge in them, and doesn't ask about them again", async () => {
    const s = store();
    intro(s, said("I have two cats.", { kind: "relationship" }));
    const llm = new ScriptedLLM(() => ({ concepts: [] }));
    await seedBackground(s, llm, "Mingxi");
    await seedBackground(s, llm, "Mingxi");
    expect(llm.calls).toHaveLength(1);
    expect(s.listHypotheses({})).toEqual([]);
  });

  it("skips a concept that would make a loop, and still seeds the rest", async () => {
    const s = store();
    const learning = s.ensureTopic("Learning");
    s.addEdge({ from: s.ensureTopic("RL").id, to: learning.id, kind: "part_of", source: "person" });
    intro(s, said("I research RL."));
    const ev = [{ fact: 1, type: "job" }];
    const llm = new ScriptedLLM(() => ({ concepts: [concept("RL", 3, ev), concept("Learning", 2, ev, "RL"), concept("Bandits", 2, ev, "RL")] }));
    await seedBackground(s, llm, "Mingxi");
    expect(s.homeParent(s.ensureTopic("Bandits").id)).toBe(s.ensureTopic("RL").id);
    expect(s.homeParent(learning.id)).toBeNull();
    expect(s.getTopic(learning.id).seedMemoryId).toBeNull();
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
    intro(s, said("I write systems software."));
    const ev = [{ fact: 1, type: "job" }];
    const llm = new ScriptedLLM(() => ({ concepts: [concept("Systems programming", 2, ev), concept("Rust", 2, ev, "Systems programming"), concept("Bible study", 2, ev, "Systems programming")] }));
    await seedBackground(s, llm, "Mingxi");
    expect(s.listHypotheses({}).map((h) => s.getTopic(h.nodeId).name)).toEqual(["Systems programming"]);
  });
});
