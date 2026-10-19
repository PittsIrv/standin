import type { Topic } from "@standin/schema";

export interface Prompt {
  system: string;
  prompt: string;
}

/** The current tree, one node per line, so the model places new topics against what exists. */
export function outline(topics: Topic[], parentOf: Map<string, string>): string {
  const name = new Map(topics.map((t) => [t.id, t.name]));
  return topics
    .map((t) => {
      const parent = parentOf.get(t.id);
      return `- ${t.name}${parent ? ` (part of: ${name.get(parent)})` : ""}${t.definition ? `: ${t.definition}` : ""}`;
    })
    .join("\n");
}

export function buildPlacePrompt(newTopics: string[], tree: string, personaName: string): Prompt {
  const system = `You organize the knowledge tree of ${personaName}'s "standin", an AI that talks as them. Each node is a topic, and each edge says a topic is part of a broader one ("consensus" is part of "distributed systems"). The tree is general knowledge, not a judgment of what ${personaName} knows.

For each new topic:
- If it means the same as an existing node (a synonym or an abbreviation), merge it: from = the new topic, into = the existing node.
- Otherwise place it under the most specific node it is part of. If no existing node fits, name a new parent and give that parent a one-line definition (parentDefinition); otherwise parentDefinition is null.
- Give every placed topic a one-line definition of what it is.
Never place a topic under itself or under one of its own parts. Leave out topics you cannot place sensibly.`;
  const prompt = `Existing tree:
${tree || "(empty)"}

New topics:
${newTopics.map((t) => `- ${t}`).join("\n")}`;
  return { system, prompt };
}

export function buildSeedPrompt(background: string, personaName: string): Prompt {
  const system = `You seed the knowledge tree of ${personaName}'s "standin" from their background. Given one statement about their degree program, school, or job role, name the field and the core topics a person with this background would have covered: required for everyone with it, not electives (about 5–10). Give each a one-line definition. Use broad, standard names ("Algorithms", "Operating systems").`;
  return { system, prompt: `Background: ${background}` };
}
