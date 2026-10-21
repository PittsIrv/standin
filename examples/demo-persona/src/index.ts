import { readFileSync } from "node:fs";
import { ScriptedLLM, type GenerateObjectRequest } from "@standin/llm";
import { defaultRoot, type EntityKind, type ObservationInput } from "@standin/schema";
import { EXTRACTIONS, HYPOTHESES, PLACEMENTS, RECONCILIATIONS, SEED } from "./fixtures.ts";

export const DEMO_PERSONA_NAME = "Lin Qiao";

/** Ten observations about a fictional person, Lin Qiao. */
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

/** The demo's placement answer: each new node listed in the prompt ("- Name [label]"), under its fixture parent. */
function placements(prompt: string) {
  const nodes = [...(prompt.split("New topics:\n")[1] ?? "").matchAll(/^- (.+?) \[(\w+)\]$/gm)].map((m) => [m[1]!.trim(), m[2] as EntityKind] as const);
  return {
    merges: [],
    placements: nodes.map(([topic, label]) => {
      const fallback: (typeof PLACEMENTS)[string] =
        label === "topic" ? ["Other topics", "Topics outside the main tree.", topic] : ["Other", "Everything else.", topic, defaultRoot(label), "other"];
      const [parent, parentDefinition, definition, root = "knowledge", parentLabel = "topic"] = PLACEMENTS[topic] ?? fallback;
      return { topic, parent, parentDefinition, parentLabel, root, definition };
    }),
  };
}

/** The demo's homes: school talk goes to Background, everything else to Life (the demo's linked memories already have homes). */
function homes(prompt: string) {
  const memories = [...(prompt.split("Memories:\n")[1] ?? "").matchAll(/^\[(mem_[0-9a-f]{12})\] (.*)$/gm)];
  return {
    homes: memories.map(([, memoryId, statement]) => ({
      memoryId,
      node: /school|university|student|degree|studied/i.test(statement!) ? "Background" : "Life",
      newNode: null,
    })),
  };
}

const topicOf = (prompt: string) => /^Topic: ([^(\n]+)/m.exec(prompt)?.[1]?.trim() ?? "the topic";

/** The demo's expansion: four generic parts per topic, from basic (1) to expert (4), no prerequisites. */
function expansion(topic: string) {
  const parts = [`${topic} fundamentals`, `${topic} in practice`, `${topic} theory`, `advanced ${topic}`];
  return { components: parts.map((name, i) => ({ name, definition: `${name}.`, level: i + 1 })), prerequisites: [] };
}

/** The demo's probes: numbered questions at the requested depth. */
function probes(topic: string, prompt: string) {
  const depth = /^Depth: (\d)/m.exec(prompt)?.[1] ?? "2";
  const count = Number(/^Write (\d+) probe/m.exec(prompt)?.[1] ?? "2");
  return { probes: Array.from({ length: count }, (_, i) => ({ question: `Could you explain ${topic} at depth ${depth} (question ${i + 1})?` })) };
}

/** The demo's grader: passes any answer longer than a few words. */
function grade(prompt: string) {
  const answer = /^Answer: (.*)$/m.exec(prompt)?.[1] ?? "";
  return answer.trim().split(/\s+/).length >= 4 ? { grade: "pass", reason: "demo: substantive answer" } : { grade: "fail", reason: "demo: too short" };
}

/** A ScriptedLLM that answers with the demo persona's hand-written fixtures. */
export function demoLLM(): ScriptedLLM {
  return new ScriptedLLM((req: GenerateObjectRequest<unknown>) => {
    if (req.purpose === "extract") {
      return EXTRACTIONS[observationText(req.prompt)] ?? { memories: [], exemplars: [] };
    }
    if (req.purpose === "seed") return SEED;
    if (req.purpose === "expand") return expansion(topicOf(req.prompt));
    if (req.purpose === "quiz") return probes(topicOf(req.prompt), req.prompt);
    if (req.purpose === "grade") return grade(req.prompt);
    if (req.purpose === "place") return placements(req.prompt);
    if (req.purpose === "home") return homes(req.prompt);
    if (req.purpose === "split") return { children: [] };
    if (req.purpose === "hypothesize") return HYPOTHESES;
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
