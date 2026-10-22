import { describe, expect, it } from "vitest";
import { answerMode, computeLighting, loadSnapshot } from "../src/index.ts";
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
