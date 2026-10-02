import { readFileSync } from "node:fs";
import { ScriptedLLM, type GenerateObjectRequest } from "@standin/llm";
import type { ObservationInput } from "@standin/schema";
import { EXTRACTIONS, RECONCILIATIONS } from "./fixtures.ts";

export const DEMO_PERSONA_NAME = "Lin Qiao";

/** Ten bilingual observations about a fictional person, Lin Qiao (乔林). */
export function demoObservations(): ObservationInput[] {
  const raw = readFileSync(new URL("../observations.jsonl", import.meta.url), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ObservationInput);
}

const observationText = (prompt: string) => /<observation>\n([\s\S]*?)\n<\/observation>/.exec(prompt)?.[1] ?? "";
const candidateStatement = (prompt: string) => /^candidate: (.*)$/m.exec(prompt)?.[1] ?? "";

/** Existing memories listed in a reconcile prompt, as id → statement. */
function neighbors(prompt: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of prompt.matchAll(/^\[(mem_[0-9a-f]{12})\][^\n]*\n {4}(.*)$/gm)) out.set(m[1]!, m[2]!);
  return out;
}

/** A ScriptedLLM that answers with the demo persona's hand-written fixtures. */
export function demoLLM(): ScriptedLLM {
  return new ScriptedLLM((req: GenerateObjectRequest<unknown>) => {
    if (req.purpose === "extract") {
      return EXTRACTIONS[observationText(req.prompt)] ?? { memories: [], exemplars: [] };
    }
    const rule = RECONCILIATIONS[candidateStatement(req.prompt)];
    if (rule) {
      const [action, targetStatement] = rule;
      for (const [id, statement] of neighbors(req.prompt)) {
        if (statement === targetStatement) return { action, targetId: id, reason: "demo fixture" };
      }
    }
    return { action: "new", targetId: null, reason: "demo fixture" };
  });
}
