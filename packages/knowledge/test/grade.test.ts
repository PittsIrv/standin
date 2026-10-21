import { ScriptedLLM, type GenerateObjectRequest } from "@standin/llm";
import { describe, expect, it } from "vitest";
import { collectGrades, submitGrades } from "../src/index.ts";
import { queued, topicId, world } from "./session-helpers.ts";

/** A session where every probe is spot-checked and answered with `answer(probeIndex)`. */
async function spotChecked(w: ReturnType<typeof world>, answer: (i: number) => string) {
  const s = await w.start();
  let i = 0;
  for (let p = await s.next(); p; p = await s.next(), i++) {
    s.rate(p.responseId, "know");
    s.answer(p.responseId, answer(i));
  }
  return s;
}

describe("grading", () => {
  const grader = (opts: { batchPolls?: number; failOn?: string } = {}) =>
    new ScriptedLLM((req: GenerateObjectRequest<unknown>) => {
      if (opts.failOn && req.prompt.includes(opts.failOn)) throw new Error("grader hiccup");
      return { grade: "pass", reason: "ok" };
    }, opts);

  it("grades through a batch: submit, wait, collect, and resubmit failures", async () => {
    const w = world({ size: 2, rng: queued([0.5, 0.0, 0.5, 0.0]) });
    w.claim("Rust", 3);
    await (await spotChecked(w, (i) => (i === 0 ? "Ownership moves values between owners." : "Borrowing lends without moving."))).finish();
    w.store.listResponses().forEach((r) => w.store.setGradeBatch([r.id], null)); // undo the session's own grading
    const g = grader({ batchPolls: 1, failOn: "Borrowing" });
    expect(await submitGrades(w.store, g, "Lin Qiao")).toEqual({ submitted: 2, gradedLive: 0 });
    expect(w.store.listResponses().every((r) => r.gradeBatchId !== null)).toBe(true);
    expect(await collectGrades(w.store, g)).toEqual({ collected: 0, failedResubmit: 0 });
    expect(await collectGrades(w.store, g)).toEqual({ collected: 1, failedResubmit: 1 });
    const failed = w.store.listResponses({ ungraded: true });
    expect(failed.map((r) => r.gradeBatchId)).toEqual([null]);
    expect((await submitGrades(w.store, grader(), "Lin Qiao")).submitted).toBe(1);
  });

  it("grades live when the provider has no batch API", async () => {
    const w = world({ size: 1, rng: queued([0.5, 0.0]) });
    w.claim("Rust", 3);
    await spotChecked(w, () => "Ownership moves values between owners.");
    const live = { generateObject: async () => ({ grade: "fail" as const, reason: "wrong" }) };
    expect(await submitGrades(w.store, live as never, "Lin Qiao")).toEqual({ submitted: 0, gradedLive: 1 });
    expect(w.store.listResponses()[0]!.grade).toBe("fail");
  });
});
