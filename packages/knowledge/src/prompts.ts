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
  const system = `You seed the knowledge tree of ${personaName}'s "standin" from their background. Given one statement about their education, work or interests:
- Name the field of knowledge it implies, or set field to null when it implies none (owning a pet, a home town).
- Name the concepts the person very likely knows because of it (about 3–10): for a degree, its required core, not electives; for a job, research or project, what that work needs day to day.
- For the field and each concept give: a one-line definition; 3–5 examples of the concrete things it includes; a depth for how well they likely know it (1 heard of it, 2 used it, 3 know it well, 4 expert: current research or daily work → 3, a degree's core or a past course → 2, mentioned in passing → 1); and a one-line reason that cites the statement.
- Set evidence to "work" for a job, research or project, otherwise "background".
Use broad, standard names ("Algorithms", "Operating systems"). Never name anything about health, religion, sexuality, gender identity, politics, ethnicity or race, immigration status, finances, criminal history or trade-union membership.`;
  return { system, prompt: `Background: ${background}` };
}

export function buildIntroPrompt(text: string, personaName: string): Prompt {
  const system = `You read ${personaName}'s short introduction of themselves, written for their "standin" (an AI that will talk as them). Turn it into short first-person statements of fact about their background, one fact each, in their own words where you can: education (degree, field, school, year), roles and jobs, current work or research, things they built, and skills or interests they name. At most 12. Add nothing they didn't say. Leave out anything about health, religion, sexuality, gender identity, politics, ethnicity or race, immigration status, finances, criminal history or trade-union membership.`;
  return { system, prompt: `<introduction>\n${text}\n</introduction>` };
}

const ROOTS_TEXT = `The tree has six fixed roots: Knowledge (fields and topics), Work (projects, roles, organizations, things built), Background (education, origin, path), People (people in their life, by role), Views (opinions, values, how they think), and Life (pets, places, hobbies, routines).`;

export function buildHomePrompt(memories: { id: string; statement: string }[], tree: string, personaName: string): Prompt {
  const system = `You file ${personaName}'s memories into the world tree of their "standin", an AI that talks as them. ${ROOTS_TEXT}

Give each memory a home: the most specific node it is about.
- If an existing node fits, set node to its exact name and newNode to null.
- Otherwise name a new node and set newNode: its parent (an existing node or a root, by exact name), its label (topic for a field of knowledge, otherwise the closest of project, org, place, person, work, pet, other) and a one-line definition.
- Start coarse: one node for a group of things until a part has its own name ("Pets", not one node per pet, unless a pet is named).
Use each memory id exactly as given.`;
  const prompt = `Existing tree:
${tree || "(empty)"}

Memories:
${memories.map((m) => `[${m.id}] ${m.statement}`).join("\n")}`;
  return { system, prompt };
}

export function buildSplitPrompt(node: string, children: string[], memories: { id: string; statement: string }[], personaName: string): Prompt {
  const system = `You keep ${personaName}'s world tree tidy. A node holds memories; when parts of it have their own identity (a name, or clearly separate sub-subjects), they become child nodes. ${ROOTS_TEXT}

For the node below, propose children only for parts that have their own identity. List under each child the ids of the memories only about that part. Memories about the whole group stay on the node: leave them out. Reuse an existing child's exact name when it fits. If nothing should split, return no children.`;
  const prompt = `Node: ${node}
Existing children: ${children.length > 0 ? children.join(", ") : "(none)"}

Memories:
${memories.map((m) => `[${m.id}] ${m.statement}`).join("\n")}`;
  return { system, prompt };
}

export function buildHypothesizePrompt(o: {
  tree: string;
  facts: string[];
  open: string[];
  cells: string[];
  personaName: string;
}): Prompt {
  const system = `You predict what ${o.personaName} probably knows, for their "standin", an AI that talks as them. Each guess is checked later by asking ${o.personaName} a question, so a wrong guess costs little, but every guess needs evidence.

For each guess give: the Knowledge node (exact name from the tree), a depth (1 aware, 2 working knowledge, 3 strong, 4 expert), a raw score (low, medium or high: how sure you are), the kind of evidence (background: from their education or role; part: a node next to one they know, in the tree; prerequisite: something needed for what they know; work: from something they built or did; other), the path of node names from something established (marked [claimed], [probed], [gap] or [confirmed] below) to the guessed node, at most 2 steps along tree edges, and a one-line reason.
Rules:
- Never guess about health, religion, sexuality, gender identity, politics, ethnicity or race, immigration status, finances, criminal history or trade-union membership, even indirectly.
- Never start a path at an open guess, and never guess a node that is already established.
- Prefer few, well-supported guesses. Keep existing guesses that still hold (repeat them unchanged); list in withdraw any open guess that no longer holds.
- Evidence kinds that have often been wrong for this person (low reliability below) deserve lower scores or no guess.`;
  const prompt = `Knowledge tree (state in brackets):
${o.tree || "(empty)"}

What they've said about their background and work:
${o.facts.length > 0 ? o.facts.map((f) => `- ${f}`).join("\n") : "(nothing yet)"}

Open guesses:
${o.open.length > 0 ? o.open.map((f) => `- ${f}`).join("\n") : "(none)"}

Reliability so far (evidence kind:raw score → share confirmed, outcomes):
${o.cells.join("\n")}`;
  return { system, prompt };
}
