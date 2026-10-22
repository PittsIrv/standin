import { describe, expect, it } from "vitest";
import { answerMode, computeLighting, loadSnapshot } from "../src/index.ts";
import { SecretFoundError } from "@standin/airlock";
import { world } from "./session-helpers.ts";

describe("a concept-card session", () => {
  it("asks a guess, settles it from the answer, and lights the node with what you said", async () => {
    const w = world();
    const h = w.guess("Algorithms", 2);
    const s = await w.start();
    const card = (await s.next())!;
    expect(card).toMatchObject({ reason: "guess", topic: "Algorithms", path: ["Knowledge"] });
    expect(s.current()?.responseId).toBe(card.responseId);
    s.answer(card.responseId, 4);
    expect(w.store.getHypothesis(h.id).status).toBe("settled");
    expect(computeLighting(loadSnapshot(w.store)).get(h.nodeId)).toMatchObject({ depth: 4, basis: "stated" });
    expect(s.current()).toBeNull();
  });

  it("says what a card includes: its examples, else its parts, and why a guess was made", async () => {
    const w = world();
    w.guess("Algorithms", 2);
    const s = await w.start();
    const guessCard = (await s.next())!;
    expect(guessCard.why).toMatch(/.+/);
    expect(guessCard.examples).toEqual([]);
    s.answer(guessCard.responseId, 2);
    const part = (await s.next())!;
    expect(part).toMatchObject({ topic: "Algorithms one", examples: ["one a", "one b", "one c"], why: null });
    // A concept with no examples of its own lists its parts instead.
    w.node("Graphs");
    for (const n of ["Shortest paths", "Spanning trees"]) w.store.addEdge({ from: w.store.ensureTopic(n).id, to: w.store.ensureTopic("Graphs").id, kind: "part_of", source: "person" });
    s.answer(part.responseId, 0);
    let card = await s.next();
    while (card && card.topic !== "Graphs") {
      s.answer(card.responseId, 0);
      card = await s.next();
    }
    expect(card?.examples).toEqual(["Shortest paths", "Spanning trees"]);
  });

  it("walks the parts a middle answer opens up, depth-first, and stops when told", async () => {
    const w = world();
    w.guess("Algorithms", 2);
    const s = await w.start();
    s.answer((await s.next())!.responseId, 2);
    const asked: string[] = [];
    let card = await s.next();
    asked.push(card!.topic);
    expect(card).toMatchObject({ reason: "part", parent: "Algorithms" });
    s.answer(card!.responseId, 1);
    card = await s.next();
    asked.push(card!.topic);
    s.skipRest(w.store.listTopics().find((t) => t.name === "Algorithms")!.id);
    s.answer(card!.responseId, 2);
    expect(asked).toEqual(["Algorithms one", "Algorithms three"]);
    expect(await s.next()).toBeNull();
  });

  it("drops the part on screen when you skip the rest of its parent", async () => {
    const w = world();
    w.guess("Algorithms", 2);
    const s = await w.start();
    s.answer((await s.next())!.responseId, 2);
    const part = (await s.next())!;
    s.skipRest(part.parentId!);
    expect(s.current()).toBeNull();
    expect(await s.next()).toBeNull();
  });

  it("offers keep or lower once a claim's parts are rated, and lowers to the lowest part", async () => {
    const w = world();
    w.claim("Rust", 2);
    const s = await w.start();
    // No (0) and Expert (4) settle a part, so nothing deeper is asked.
    const levels = new Map([["Rust one", 0], ["Rust three", 4], ["Rust two", 4]]);
    for (let card = await s.next(); card; card = await s.next()) {
      expect(s.keepLowerDue()).toBeNull();
      s.answer(card.responseId, levels.get(card.topic)!);
    }
    const due = s.keepLowerDue()!;
    expect(due).toMatchObject({ topic: "Rust", claimed: 2, lower: [{ topic: "Rust one", level: 0 }] });
    s.decideClaim(due.claimNodeId, "lower");
    expect(s.keepLowerDue()).toBeNull();
    expect(answerMode(loadSnapshot(w.store), due.claimNodeId)).toMatchObject({ depth: 0 });
  });

  it("carves out what you said you don't know as soon as an answer lights the branch above it", async () => {
    const w = world();
    const h = w.guess("Game AI", 2);
    const chess = w.store.ensureTopic("chess engines");
    w.store.addEdge({ from: chess.id, to: h.nodeId, kind: "part_of", source: "placement" });
    w.approve("negative", "I don't know chess engines.", {}, ["chess engines"]);
    const s = await w.start();
    s.answer((await s.next())!.responseId, 3);
    expect(answerMode(loadSnapshot(w.store), chess.id)).toMatchObject({ depth: 1, from: { via: "gap" } });
  });

  it("sets a boundary and withdraws the guess on 'wouldn't say'", async () => {
    const w = world();
    const h = w.guess("Algorithms", 2);
    const s = await w.start();
    s.answer((await s.next())!.responseId, "wouldnt_say");
    expect(w.store.getHypothesis(h.id).status).toBe("withdrawn");
    expect(w.store.getTopic(h.nodeId).boundaryTier).toBe(3);
    expect(s.boundaries()).toEqual([{ nodeId: h.nodeId, topic: "Algorithms" }]);
    s.undoBoundary(h.nodeId);
    expect(s.boundaries()).toEqual([]);
  });

  it("finishes with what it counted, and keeps going when a model is down", async () => {
    const w = world();
    w.guess("Algorithms", 2);
    const s = await w.start();
    s.answer((await s.next())!.responseId, 0);
    expect(await s.finish()).toEqual({ answered: 1, settled: 1 });
    const down = world({ failing: true });
    down.claim("Rust", 2);
    const s2 = await down.start();
    expect(s2.warnings.join()).toMatch(/down/);
    expect(await s2.next()).toBeNull();
    expect(s2.warnings.join()).toMatch(/expanding Rust failed/);
  });
});

describe("leaving and coming back", () => {
  it("shows the card left unanswered first, with the prediction made when it was first shown, and settles it", async () => {
    const w = world();
    const h = w.guess("Algorithms", 2);
    const first = await w.start();
    const card = (await first.next())!;
    const predicted = w.store.getResponse(card.responseId).predictedP;
    await first.finish();
    const second = await w.start();
    const again = second.current()!;
    expect(again).toMatchObject({ responseId: card.responseId, topic: "Algorithms", reason: "guess" });
    expect(w.store.getResponse(again.responseId)).toMatchObject({ sessionId: second.sessionId, predictedP: predicted });
    second.answer(again.responseId, 4);
    expect(w.store.getHypothesis(h.id).status).toBe("settled");
    expect((await second.finish()).answered).toBe(1);
  });

  it("doesn't bring back a card whose concept was answered since", async () => {
    const w = world();
    w.guess("Algorithms", 2);
    const first = await w.start();
    const left = (await first.next())!;
    await first.finish();
    const other = await w.start();
    other.answer(other.current()!.responseId, 4);
    await other.finish();
    const third = await w.start();
    expect(third.current()).toBeNull();
    expect(w.store.getResponse(left.responseId).level).toBe(4);
  });
});

describe("questions about your life", () => {
  const withQuestion = (w: ReturnType<typeof world>) => {
    const pets = w.store.ensureNode("Pets", "pet");
    w.store.addEdge({ from: pets.id, to: w.store.root("life").id, kind: "part_of", source: "placement" });
    return { pets, q: w.store.addQuestion({ nodeId: pets.id, text: "What are your cats' names?" }) };
  };

  it("comes as every 5th card, and stays on screen until it's dealt with", async () => {
    const w = world();
    for (const t of ["A", "B", "C", "D", "E"]) w.guess(t, 2);
    const { q } = withQuestion(w);
    const s = await w.start();
    for (let i = 0; i < 4; i++) {
      expect(s.questionDue()).toBeNull();
      s.answer((await s.next())!.responseId, 4);
    }
    expect(s.questionDue()).toMatchObject({ questionId: q.id, text: "What are your cats' names?", node: "Pets", path: ["Life"] });
    expect(s.questionDue()?.questionId).toBe(q.id);
    s.skipQuestion(q.id);
    expect(s.questionDue()).toBeNull();
    expect(s.anyQuestion()).toBeNull();
    expect(w.store.getQuestion(q.id).status).toBe("open");
  });

  it("is asked before the queue once the knowledge cards run out, and can be dismissed for good", async () => {
    const w = world();
    const { q } = withQuestion(w);
    const s = await w.start();
    expect(await s.next()).toBeNull();
    expect(s.anyQuestion()?.questionId).toBe(q.id);
    s.dismissQuestion(q.id);
    expect(w.store.getQuestion(q.id).status).toBe("dismissed");
    expect(s.anyQuestion()).toBeNull();
  });

  it("reads an answer like the introduction, and stores what you confirm as facts on the question's node", async () => {
    const w = world();
    const { pets, q } = withQuestion(w);
    const s = await w.start();
    const read = await s.readAnswer(q.id, "They are Miso and Tofu. Call me at 412-555-0199.");
    expect(read.statements.map((x) => x.statement)).toEqual(["They are Miso and Tofu."]);
    expect(read.contacts).toBe(1);
    expect(w.store.listMemories({})).toEqual([]);
    const r = await s.answerQuestion(q.id, [{ ...read.statements[0]!, statement: "My cats are Miso and Tofu.", kind: "relationship" }]);
    expect(r).toEqual({ saved: 1, dropped: [] });
    const fact = w.store.listMemories({ status: "approved" })[0]!;
    expect([fact.statement, fact.homeNodeId, fact.attrs]).toEqual(["My cats are Miso and Tofu.", pets.id, expect.objectContaining({ kind: "relationship" })]);
    const obs = w.store.memorySources(fact.id)[0]!;
    expect([obs.sourceKind, obs.sourceRef]).toEqual(["answer", "What are your cats' names?"]);
    expect(w.store.getQuestion(q.id).status).toBe("answered");
    expect(s.anyQuestion()).toBeNull();
  });

  it("saves nothing, and keeps the question open, when every statement is sensitive or the answer was never read here", async () => {
    const w = world();
    const { q } = withQuestion(w);
    const s = await w.start();
    const read = await s.readAnswer(q.id, "I take them to church.");
    expect(await s.answerQuestion(q.id, read.statements)).toEqual({ saved: 0, dropped: [] });
    const restarted = await w.start();
    expect(await restarted.answerQuestion(q.id, [{ ...read.statements[0]!, statement: "They are Miso and Tofu." }])).toEqual({ saved: 0, dropped: [] });
    expect(w.store.getQuestion(q.id).status).toBe("open");
    expect(w.store.listMemories({})).toEqual([]);
  });
});

describe("secrets on the way in (personal-data guard)", () => {
  const TOKEN = "ghp_" + "aB3kQ9zX7mW2pL5vR8tY4nC6aB3kQ9zX7mW2".slice(0, 36);

  it("refuses an answer with a secret before any model sees it", async () => {
    const w = world();
    const s = await w.start();
    const q = w.store.addQuestion({ nodeId: w.store.ensureNode("Pets", "other").id, text: "Any pets?" });
    await expect(s.readAnswer(q.id, `Yes. Also my password is Hunter2!`)).rejects.toThrow(SecretFoundError);
  });

  it("refuses typed introduction text, but cuts a secret from a file and says so", async () => {
    const w = world();
    const s = await w.start();
    expect(() => s.addSource("intro", "your introduction", `I'm Lin. token ${TOKEN}`)).toThrow(SecretFoundError);
    const sum = s.addSource("file", "cv.pdf", `Lin Qiao\nGitHub token ${TOKEN}\nmail lin@example.edu`);
    expect(sum).toMatchObject({ contactsRemoved: 1, secretsRemoved: [{ label: "GitHub token", count: 1 }] });
    expect(s.introSources()[0]).toMatchObject({ secretsRemoved: [{ label: "GitHub token", count: 1 }] });
  });
});
