import type { Prompt } from "../prompts.ts";

const SCALE = "0 doesn't know · 1 aware of it · 2 working knowledge · 3 strong · 4 expert";

export function buildExpandPrompt(
  node: { name: string; definition: string | null },
  parent: string | null,
  personaName: string,
  problems: string[] = [],
): Prompt {
  const system = `You grow the knowledge tree of ${personaName}'s "standin". Split one concept into its parts, the way a good course or textbook divides it.
- Give 3–7 parts that don't overlap and that together cover the concept.
- Give each part a one-line definition, and a level for how advanced it is: 1 basic (anyone who has heard of the concept knows it), 2 working knowledge, 3 strong, 4 expert.
- Also give the concept's main prerequisites (what someone must know first), each with a one-line definition.
Use broad, standard names. Never list the concept itself, a synonym of it, or anything it is part of.`;
  const retry = problems.length > 0 ? `\n\nProblems with your last answer, fix them:\n${problems.map((p) => `- ${p}`).join("\n")}` : "";
  const prompt = `Topic: ${node.name}${node.definition ? ` (${node.definition})` : ""}${parent ? `\nPart of: ${parent}` : ""}${retry}`;
  return { system, prompt };
}

export function buildQuizPrompt(
  node: { name: string; definition: string | null },
  parent: string | null,
  difficulty: number,
  count: number,
  personaName: string,
): Prompt {
  const system = `You write short probes that check what ${personaName} knows. Each probe is one English sentence asking whether they could explain or do something specific about a topic, at a given depth on this scale: ${SCALE}. A probe at depth d should be easy for someone at d and hard for someone at d − 1. Test understanding, never dates, names or trivia.`;
  const prompt = `Topic: ${node.name}${node.definition ? ` (${node.definition})` : ""}${parent ? `\nPart of: ${parent}` : ""}
Depth: ${difficulty}
Write ${count} probe${count === 1 ? "" : "s"}.`;
  return { system, prompt };
}

export function buildGradePrompt(question: string, difficulty: number, answer: string, personaName: string): Prompt {
  const system = `You grade a one-line answer ${personaName} gave to a knowledge probe at depth ${difficulty} (${SCALE}). Pass it if it shows the understanding the probe asks for at that depth, however briefly or informally it is worded. Fail it if it is wrong, empty, or only restates the question.`;
  return { system, prompt: `Probe: ${question}\nAnswer: ${answer}` };
}
