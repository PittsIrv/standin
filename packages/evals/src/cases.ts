import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { AnswerState } from "@standin/schema";
import { z } from "zod";

export const SUITES = ["known", "not-on-record", "competence", "boundary", "extraction"] as const;
export const Suite = z.enum(SUITES);
export type Suite = z.infer<typeof Suite>;
/** One failure in these fails the run (decision 88). */
export const SAFETY: readonly Suite[] = ["boundary", "extraction"];
/** Scored, and compared with the baseline. */
export const QUALITY: readonly Suite[] = ["known", "not-on-record", "competence"];

export const EvalCase = z.object({
  id: z.string().min(1),
  suite: Suite,
  question: z.string().min(1),
  expect: z.object({
    state: z.union([AnswerState, z.literal("any")]),
    reason: z.enum(["nothing", "competence", "check"]).optional(),
    /** Facts the reply must convey, graded by the judge. */
    mentions: z.array(z.string()).optional(),
    /** Phrases that must never appear, checked in code. */
    forbidden: z.array(z.string()).optional(),
  }),
  /** The memory or node the case was built from. */
  from: z.string().optional(),
  /** The person changed it: a rebuild keeps it. */
  edited: z.boolean().optional(),
});
export type EvalCase = z.infer<typeof EvalCase>;

/** A JSON-lines case file. A missing file is no cases; a bad line is named and skipped. */
export function readCases(path: string): { cases: EvalCase[]; errors: { line: number; message: string }[] } {
  if (!existsSync(path)) return { cases: [], errors: [] };
  const cases: EvalCase[] = [];
  const errors: { line: number; message: string }[] = [];
  readFileSync(path, "utf8")
    .split("\n")
    .forEach((raw, i) => {
      if (!raw.trim()) return;
      try {
        cases.push(EvalCase.parse(JSON.parse(raw)));
      } catch (err) {
        errors.push({ line: i + 1, message: err instanceof z.ZodError ? err.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ") : (err as Error).message });
      }
    });
  return { cases, errors };
}

export function writeCases(path: string, cases: EvalCase[]): void {
  writeFileSync(path, cases.map((c) => JSON.stringify(c)).join("\n") + (cases.length ? "\n" : ""), { mode: 0o600 });
}

/** The generic suites shipped with the code: the demo persona's cases, and extraction attempts. */
export function repoCases(name: "demo" | "extraction"): EvalCase[] {
  const { cases, errors } = readCases(new URL(`../cases/${name}.jsonl`, import.meta.url).pathname);
  if (errors.length) throw new Error(`bad repo case file ${name}.jsonl: line ${errors[0]!.line}`);
  return cases;
}
