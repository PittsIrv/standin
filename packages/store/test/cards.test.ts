import { describe, expect, it } from "vitest";
import { AlreadyRatedError } from "../src/index.ts";
import { tempStore } from "./helpers.ts";

describe("concept-card answers", () => {
  const setup = () => {
    const { store, clock } = tempStore();
    const session = store.startSession(1);
    const show = (name: string) => {
      const n = store.ensureTopic(name);
      const p = store.insertProbe({ nodeId: n.id, checkOf: null, kind: "card", difficulty: 1, question: `${name}.`, holdout: "none" });
      return { n, r: store.showProbe(p.id, session.id, "decline") };
    };
    return { store, clock, show };
  };

  it("stores a level with a matching rating, and refuses a second answer", () => {
    const { store, show } = setup();
    const ratings = [0, 1, 2, 3, 4].map((level) => store.answerCard(show(`n${level}`).r.id, level).rating);
    expect(ratings).toEqual(["no_idea", "roughly", "roughly", "know", "know"]);
    const { r } = show("x");
    expect(store.answerCard(r.id, 3)).toMatchObject({ level: 3, rating: "know" });
    expect(() => store.answerCard(r.id, 1)).toThrow(AlreadyRatedError);
    expect(store.answerCard(show("w").r.id, "wouldnt_say")).toMatchObject({ level: null, rating: "wouldnt_say" });
  });

  it("carries an unanswered card into a later session, and refuses an answered one", () => {
    const { store, show } = setup();
    const later = store.startSession(1);
    const { r } = show("RL");
    expect(store.carryResponse(r.id, later.id)).toMatchObject({ id: r.id, sessionId: later.id, rating: null });
    store.answerCard(r.id, 2);
    expect(() => store.carryResponse(r.id, later.id)).toThrow(AlreadyRatedError);
  });

  it("keeps the latest stated level per node", () => {
    const { store, clock, show } = setup();
    const first = show("RL");
    store.answerCard(first.r.id, 1);
    clock.advanceDays(1);
    const p = store.insertProbe({ nodeId: first.n.id, checkOf: null, kind: "card", difficulty: 1, question: "again", holdout: "none" });
    store.answerCard(store.showProbe(p.id, store.listSessions()[0]!.id, "brief").id, 3);
    expect(store.stateds().get(first.n.id)).toMatchObject({ level: 3 });
    expect(store.stateds().size).toBe(1);
  });

  it("stores a part's level and a stopped walk on the node", () => {
    const { store } = setup();
    const n = store.setTopic(store.ensureTopic("Async RL").id, { partLevel: 4, walkStopped: true });
    expect(n).toMatchObject({ partLevel: 4, walkStopped: true });
  });
});
