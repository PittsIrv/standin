import { describe, expect, it } from "vitest";
import { tempStore } from "./helpers.ts";

describe("questions on nodes", () => {
  it("adds, lists and settles questions, oldest first", () => {
    const { store, clock } = tempStore();
    const pets = store.ensureNode("Pets", "pet");
    const kite = store.ensureNode("Kite", "project");
    const q1 = store.addQuestion({ nodeId: pets.id, text: "What are your cats' names?" });
    clock.advanceDays(1);
    const q2 = store.addQuestion({ nodeId: kite.id, text: "How did Kite turn out?" });
    expect(q1).toMatchObject({ nodeId: pets.id, status: "open", decidedAt: null });
    expect(store.listQuestions({ status: "open" }).map((q) => q.id)).toEqual([q1.id, q2.id]);
    expect(store.setQuestionStatus(q1.id, "answered")).toMatchObject({ status: "answered", decidedAt: expect.any(String) });
    store.setQuestionStatus(q2.id, "dismissed");
    expect(store.listQuestions({ status: "open" })).toEqual([]);
    expect(store.listQuestions({ nodeId: kite.id }).map((q) => q.status)).toEqual(["dismissed"]);
    expect(store.getQuestion(q2.id).text).toBe("How did Kite turn out?");
  });
});
