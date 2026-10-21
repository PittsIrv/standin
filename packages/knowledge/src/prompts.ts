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
      if (t.rootKey) return `- ${t.name} [root]`;
      return `- ${t.name} [${t.label}]${parent ? ` (part of: ${name.get(parent)})` : ""}${t.definition ? `: ${t.definition}` : ""}`;
    })
    .join("\n");
}

export function buildPlacePrompt(newNodes: string[], tree: string, personaName: string): Prompt {
  const system = `You organize the world tree of ${personaName}'s "standin", an AI that talks as them. The tree has six fixed roots:
- Knowledge: fields and topics (general knowledge, not a judgment of what ${personaName} knows)
- Work: projects, roles, organizations, things built
- Background: education, origin, path
- People: people in their life, by role
- Views: opinions, values, how they think
- Life: pets, places, hobbies, routines
Each edge says a node is part of a broader one ("consensus" is part of "distributed systems"; "Miso" is part of "Pets"). Each new node is listed with its label in brackets.

For each new node:
- If it means the same as an existing node (a synonym or an abbreviation), merge it: from = the new node, into = the existing node.
- Otherwise place it under the most specific existing node it belongs to, or directly under a root. If nothing fits, name a new parent: give it a one-line definition (parentDefinition), a label (parentLabel: topic for a field of knowledge, otherwise the closest of project, org, place, person, work, pet, other), and the root it goes under (root: knowledge, work, background, people, views or life). When the parent already exists, parentDefinition is null and parentLabel and root are ignored.
- Give every placed node a one-line definition of what it is.
Never place a node under itself or under one of its own parts. Leave out nodes you cannot place sensibly.`;
  const prompt = `Existing tree:
${tree || "(empty)"}

New topics:
${newNodes.map((t) => `- ${t}`).join("\n")}`;
  return { system, prompt };
}

export function buildSeedPrompt(background: string, personaName: string): Prompt {
  const system = `You seed the knowledge tree of ${personaName}'s "standin" from their background. Given one statement about their degree program, school, or job role, name the field and the core topics a person with this background would have covered: required for everyone with it, not electives (about 5–10). Give each a one-line definition. Use broad, standard names ("Algorithms", "Operating systems").`;
  return { system, prompt: `Background: ${background}` };
}
