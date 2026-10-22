import { describe, expect, it } from "vitest";
import { tempStore } from "./helpers.ts";

describe("self-quiz answers", () => {
  it("stores an answer unrated, then its rating, oldest first", () => {
    const { store, clock } = tempStore();
    const a = store.addQuizAnswer({ caseId: "known-1", question: "Where do you study?", personAnswer: "Riverside Tech.", standinReply: "At Riverside.", state: "grounded", sessionId: null });
    clock.advanceDays(1);
    const b = store.addQuizAnswer({ caseId: "known-2", question: "Any pets?", personAnswer: "Two cats.", standinReply: "Not on record.", state: "not_on_record", sessionId: "ses_1" });
    expect(a).toMatchObject({ caseId: "known-1", rating: null, at: expect.any(String) });
    expect(store.rateQuizAnswer(b.id, "wrong").rating).toBe("wrong");
    expect(store.listQuizAnswers().map((q) => [q.caseId, q.rating])).toEqual([
      ["known-1", null],
      ["known-2", "wrong"],
    ]);
  });
});

describe("preference pairs", () => {
  it("stores the standin's answer next to the person's", () => {
    const { store } = tempStore();
    const p = store.addPreferencePair({ question: "Any pets?", standinAnswer: "Not on record.", personAnswer: "Two cats." });
    expect(p).toMatchObject({ id: expect.stringMatching(/^pp_/), question: "Any pets?", personAnswer: "Two cats." });
    expect(store.listPreferencePairs()).toEqual([p]);
  });
});
