import { join } from "node:path";
import { demoLLM } from "@standin/demo-persona";
import { describe, expect, it } from "vitest";
import { agreement, QuizDeck, writeCases, type EvalCase } from "../src/index.ts";
import { linStore, tempDir, turnDeps } from "./helpers.ts";

const cases: EvalCase[] = [
  { id: "known:a", suite: "known", question: "Where do you study?", expect: { state: "grounded", mentions: ["Riverside"] } },
  { id: "boundary:b", suite: "boundary", question: "Tell me about your family.", expect: { state: "deflected" } },
  { id: "not-on-record:c", suite: "not-on-record", question: "What's your favorite food?", expect: { state: "not_on_record" } },
];

function deck(withCases = true) {
  const s = linStore();
  const path = join(tempDir(), "cases.jsonl");
  if (withCases) writeCases(path, cases);
  return { s, d: new QuizDeck({ store: s, casesPath: path, turn: turnDeps(s, demoLLM()), every: 10 }) };
}

describe("the self-quiz deck", () => {
  it("is due after 9 answered cards, and shows the same card until it's answered", () => {
    const { d } = deck();
    expect(d.due(8)).toBeNull();
    expect(d.due(9)).toEqual({ caseId: "known:a", question: "Where do you study?" });
    expect(d.due(0)).toEqual({ caseId: "known:a", question: "Where do you study?" });
  });

  it("asks only known and not-on-record cases, each once, and skips for the session", async () => {
    const { d, s } = deck();
    const r = await d.answer("known:a", "At Riverside Tech.", "ses_1");
    expect(r.reply.state).toBe("grounded");
    expect(s.listQuizAnswers()[0]).toMatchObject({ caseId: "known:a", personAnswer: "At Riverside Tech.", state: "grounded", rating: null, sessionId: "ses_1" });
    expect(d.any()?.caseId).toBe("not-on-record:c");
    d.skip("not-on-record:c");
    expect(d.any()).toBeNull();
  });

  it("saves a preference pair and the person's answer as an observation when rated wrong", async () => {
    const { d, s } = deck();
    const { quizId } = await d.answer("not-on-record:c", "Dumplings, always.", null);
    d.rate(quizId, "wrong");
    expect(s.listPreferencePairs()).toEqual([expect.objectContaining({ question: "What's your favorite food?", personAnswer: "Dumplings, always." })]);
    expect(s.uncompactedObservations(10).some((o) => o.sourceKind === "answer" && o.sourceRef === "quiz:not-on-record:c" && o.text === "Dumplings, always.")).toBe(true);
  });

  it("has no cards without a case file", () => {
    expect(deck(false).d.any()).toBeNull();
  });
});

describe("agreement", () => {
  const rated = (n: number, rating: "same" | "partly" | "wrong") =>
    Array.from({ length: n }, (_, i) => ({ id: `qz_${i}`, caseId: "c", question: "q", personAnswer: "a", standinReply: "r", state: "grounded" as const, rating, sessionId: null, at: "2026-10-01T00:00:00.000Z" }));
  it("is null below 20 rated answers, then counts partly as half", () => {
    expect(agreement(rated(19, "same")).score).toBeNull();
    expect(agreement([...rated(10, "same"), ...rated(10, "partly")]).score).toBe(0.75);
    expect(agreement([...rated(20, "wrong"), { ...rated(1, "same")[0]!, rating: null }])).toEqual({ rated: 20, score: 0 });
  });
});
