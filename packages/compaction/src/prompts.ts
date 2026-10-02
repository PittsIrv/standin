import type { Memory, Observation } from "@standin/schema";
import type { ExtractedMemory } from "./schemas.ts";

export interface Prompt {
  system: string;
  prompt: string;
}

const AI_MEMORY_SOURCES = new Set(["claude-memory", "chatgpt-memory", "muse-paste"]);

export function buildExtractionPrompt(o: Observation, personaName: string): Prompt {
  const n = personaName;
  const system = `You maintain the memory of a "standin": an AI that talks to other people as ${n}. You read one observation (something ${n} said or wrote, or something written about them) and extract atomic memories about ${n}.

Rules:
- Extract only claims about ${n} that the text directly supports. Do not infer beyond it. If nothing qualifies, return empty lists.
- Write each memory as one first-person sentence in ${n}'s voice ("I ..."), in the language of the source text.
- One claim per memory. Split compound sentences.
- Kinds:
  - fact: something that happened or is true about ${n}.
  - competence: a skill or domain ${n} has demonstrated or explicitly claims. Set competence.depth from 0 to 4 (0 none, 1 aware of it, 2 working knowledge, 3 strong, 4 expert). Never infer competence from merely being around a topic.
  - stance: an opinion or preference ${n} holds. Set stance.topic and stance.strength from 1 (mild) to 5 (strong).
  - negative: something ${n} explicitly says they don't know, haven't done, or don't do.
  Set competence and stance to null for other kinds.
- isCurrentState: true for present-tense situations that will go stale ("currently reading", "working on", "living in").
- validFrom / validUntil: ISO-8601 dates only when the text states or clearly implies them; otherwise null.
- entities: the named projects, organizations, places, works (books, papers, games), public figures, and topics the memory is about.
- suggestedTier: 1 if already public or harmless (work, projects, published writing, public interests); 2 for ordinary personal details that are fine to share in conversation; 3 for sensitive topics: compensation, immigration or visa status, health, relationships, family, private individuals, confidential employer information, unpublished research results, or a location more specific than a city.
- If the source is another AI's memory of ${n}, treat each item as an unverified claim. Extract it, but do not make it sound more certain than the source.
- exemplars: up to 3 short verbatim excerpts (at most 280 characters each) that show how ${n} naturally talks, only when ${n} wrote the text. Copy them exactly. Skip boilerplate.`;

  const aiNote = AI_MEMORY_SOURCES.has(o.sourceKind) ? " (another AI's memory of the person)" : "";
  const prompt = `Observation ${o.id}
source: ${o.sourceKind}${aiNote} (${o.sourceRef}); author role: ${o.authorRole}; language: ${o.lang}; occurred: ${o.occurredAt}

<observation>
${o.text ?? ""}
</observation>`;
  return { system, prompt };
}

export function buildReconcilePrompt(candidate: ExtractedMemory, neighbors: Memory[], personaName: string): Prompt {
  const system = `You keep ${personaName}'s memory store consistent. Compare a new candidate memory with existing memories and choose one action:
- duplicate: an existing memory already says the same thing, possibly worded differently or in another language. targetId is that memory's id.
- update: the candidate is a newer version of a state an existing memory describes (a different book being read, a project's status changing). targetId is the memory it replaces.
- contradiction: the candidate conflicts with an existing memory, and the conflict is not clearly a change over time. targetId is the conflicting memory.
- new: none of the above. targetId is null.
When unsure, choose new.`;

  const lines = neighbors.map(
    (m) =>
      `[${m.id}] status=${m.status} kind=${m.kind} current=${m.isCurrentState} validFrom=${m.validFrom ?? "-"} recorded=${m.recordedAt}\n    ${m.statement}`,
  );
  const prompt = `candidate: ${candidate.statement}
candidate kind: ${candidate.kind}; current state: ${candidate.isCurrentState}

existing memories:
${lines.join("\n")}`;
  return { system, prompt };
}
