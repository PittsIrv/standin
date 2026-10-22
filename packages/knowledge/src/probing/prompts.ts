import type { Prompt } from "../prompts.ts";

export function buildExpandPrompt(
  node: { name: string; definition: string | null },
  parent: string | null,
  personaName: string,
  problems: string[] = [],
): Prompt {
  const system = `You grow the knowledge tree of ${personaName}'s "standin". Split one concept into its parts, the way a good course or textbook divides it.
- Give 3–7 parts that don't overlap and that together cover the concept.
- Name each part by what it contains ("Network flow and matching"), never by how hard it is or as a bucket: no "advanced", "basics", "fundamentals", "introduction", "intermediate", "other" or "general" in a name.
- Give each part a one-line definition, 3–5 examples (the concrete methods, results, tools or problems it covers, e.g. "max-flow/min-cut", "Ford–Fulkerson", "bipartite matching"), and a level for how advanced it is: 1 basic (anyone who has heard of the concept knows it), 2 working knowledge, 3 strong, 4 expert. The level carries the difficulty, so the name doesn't have to.
- Also give the concept's main prerequisites (what someone must know first), each with a one-line definition.
Use broad, standard names. Never list the concept itself, a synonym of it, or anything it is part of.`;
  const retry = problems.length > 0 ? `\n\nProblems with your last answer, fix them:\n${problems.map((p) => `- ${p}`).join("\n")}` : "";
  const prompt = `Topic: ${node.name}${node.definition ? ` (${node.definition})` : ""}${parent ? `\nPart of: ${parent}` : ""}${retry}`;
  return { system, prompt };
}
