import { buildBundle } from "@standin/publish";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoLLM } from "@standin/demo-persona";
import { QuizDeck, writeCases } from "@standin/evals";
import { LIMITS, type TurnDeps } from "@standin/speak";
import type { Store } from "@standin/store";
import type { CardSession } from "@standin/knowledge";
import { Tracer } from "@standin/trace";
import { describe, expect, it } from "vitest";
import { nextCard } from "../src/cards.ts";
import { config, served } from "./helpers.ts";

/** Lin has two cats; the quiz has one known case and one not-on-record case. */
function lin(store: Store) {
  const pets = store.ensureNode("Pets", "pet");
  store.addEdge({ from: pets.id, to: store.root("life").id, kind: "part_of", source: "placement" });
  const o = store.addObservation({ sourceKind: "manual", sourceRef: "t", authorRole: "self", text: "I have two cats.", occurredAt: "2026-09-01T00:00:00.000Z" });
  const m = store.insertMemory({ kind: "fact", statement: "I have two cats.", tier: 1, isCurrentState: false, attrs: {} } as never, { sourceObservationIds: [o.id], entityIds: [pets.id], actor: "compaction", homeNodeId: pets.id });
  store.approve(m.id);
}

function extras(store: Store) {
  const turn: TurnDeps = { bundle: () => buildBundle(store, { personaName: "Lin", speakAt: 0.8 }), answer: demoLLM(), check: demoLLM(), tracer: new Tracer({ sinks: [] }), limits: LIMITS };
  const casesPath = join(mkdtempSync(join(tmpdir(), "standin-quiz-")), "cases.jsonl");
  writeCases(casesPath, [
    { id: "known:a", suite: "known", question: "Do you have cats?", expect: { state: "grounded", mentions: ["two cats"] } },
    { id: "not-on-record:b", suite: "not-on-record", question: "What's your favorite food?", expect: { state: "not_on_record" } },
  ]);
  return { turn, quiz: new QuizDeck({ store, casesPath, turn, every: 10 }) };
}

describe("asking on the review page", () => {
  it("answers as a visitor would see it, with its work", async () => {
    const { server, api } = await served({ setup: (w) => lin(w.store), extra: (w) => extras(w.store) });
    const r = (await api("/api/ask", { question: "Do you have cats?" })).json!;
    expect(r).toMatchObject({ text: "I have two cats.", state: "grounded", cites: [{ statement: "I have two cats.", node: "Pets" }], work: { seeds: [{ name: "Pets" }] } });
    expect((await api("/api/ask", { question: "" })).status).toBe(400);
    await server.finish();
  });

  it("says asking isn't available when the session has no turn", async () => {
    const { server, api } = await served();
    const r = await api("/api/ask", { question: "Do you have cats?" });
    expect([r.status, r.json!.error]).toEqual([409, "Asking isn't available in this session."]);
    await server.finish();
  });
});

describe("self-quiz cards", () => {
  it("come once the other cards run out; an answer gets the standin's reply, then a rating", async () => {
    const { w, server, api } = await served({ setup: (w) => lin(w.store), extra: (w) => extras(w.store) });
    expect((await api("/api/card")).json!.card).toEqual({ type: "quiz", quiz: { caseId: "known:a", question: "Do you have cats?" } });
    const a = (await api("/api/quiz/answer", { caseId: "known:a", answer: "Yes, two." })).json!;
    expect(a.reply).toMatchObject({ state: "grounded", text: "I have two cats." });
    await api("/api/quiz/rate", { quizId: a.quizId, rating: "same" });
    expect(w.store.listQuizAnswers()[0]).toMatchObject({ caseId: "known:a", rating: "same" });
    expect((await api("/api/card")).json!.card.quiz.caseId).toBe("not-on-record:b");
    await api("/api/quiz/skip", { caseId: "not-on-record:b" });
    expect((await api("/api/card")).json!.card).toEqual({ type: "done" });
    expect((await api("/api/status")).json!.quiz).toEqual({ rated: 1, score: null, left: 0 });
    await server.finish();
  });

  it("is due before the next concept card after 9 answered cards", async () => {
    const quizzed: string[] = [];
    const session = {
      current: () => null,
      needsIntro: () => false,
      keepLowerDue: () => null,
      questionDue: () => null,
      answeredSinceQuiz: () => 9,
      quizShown: () => quizzed.push("shown"),
      next: async () => ({ topic: "concept" }),
      anyQuestion: () => null,
    } as unknown as CardSession;
    const quiz = { due: (n: number) => (n >= 9 ? { caseId: "c", question: "q" } : null), any: () => null } as unknown as QuizDeck;
    expect(await nextCard(session, {} as Store, config, quiz)).toEqual({ type: "quiz", quiz: { caseId: "c", question: "q" } });
    expect(quizzed).toEqual(["shown"]);
  });
});
