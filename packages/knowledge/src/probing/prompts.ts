import type { Prompt } from "../prompts.ts";

const SCALE = "0 doesn't know · 1 aware of it · 2 working knowledge · 3 strong · 4 expert";

export function buildExpandPrompt(node: { name: string; definition: string | null }, parent: string | null, personaName: string): Prompt {
  const system = `You grow the knowledge tree of ${personaName}'s "standin". Expand one topic into what it is made of. Give 4–8 components: the standard parts a course or textbook would cover, each with a one-line definition. Also give the topic's main prerequisites (what someone must know first), each with a one-line definition. Use broad, standard names. Never list the topic itself, or anything it is part of.`;
  const prompt = `Topic: ${node.name}${node.definition ? ` (${node.definition})` : ""}${parent ? `\nPart of: ${parent}` : ""}`;
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
