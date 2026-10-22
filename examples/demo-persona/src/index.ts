import { readFileSync } from "node:fs";
import { ScriptedLLM, type GenerateObjectRequest } from "@standin/llm";
import { defaultRoot, type EntityKind, type ObservationInput } from "@standin/schema";
import { EXTRACTIONS, GAME_SEED, HYPOTHESES, PLACEMENTS, RECONCILIATIONS, RL_SEED, SEED, SPLITS } from "./fixtures.ts";

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

/** The demo's expansion: its hand-written split, or no parts (so the walk stops there); no prerequisites. */
function expansion(topic: string) {
  const parts = SPLITS[topic] ?? [];
  return { components: parts.map(([name, definition, level, examples]) => ({ name, definition, level, examples })), prerequisites: [] };
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

/** The demo's reading of a source section: one statement per sentence or line, quoting itself, with a keyword kind. */
function intro(prompt: string) {
  const text = /<source>\n([\s\S]*)\n<\/source>/.exec(prompt)?.[1] ?? "";
  const kindOf = (s: string) =>
    /\b(PhD|master'?s|BS|BA|degree|student|studied|university)\b/i.test(s)
      ? "education"
      : /\b(paper|published|publication)\b/i.test(s)
        ? "publication"
        : /\b(built|build|engine|bot|project)\b/i.test(s)
          ? "project"
          : /\b(intern|engineer|researcher|research|work(ed)? (at|on)|job)\b/i.test(s)
            ? "occupation"
            : /\b(cats?|dogs?|advisor|friend|partner)\b/i.test(s)
              ? "relationship"
              : /\b(every|usually|weekends?)\b/i.test(s)
                ? "routine"
                : "experience";
  // A bullet is one fact, and so is a sentence; title lines with no full stop (a role, then its organization) run together.
  const facts: string[] = [];
  let open: string | null = null;
  const close = () => {
    if (open !== null) facts.push(open);
    open = null;
  };
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    if (/^[-*•]\s/.test(line)) {
      close();
      facts.push(line.replace(/^[-*•]\s*/, ""));
      continue;
    }
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      open = open === null ? sentence : `${open}\n${sentence}`;
      if (/[.!?]$/.test(sentence)) close();
    }
  }
  close();
  const statements = facts
    .filter((s) => s.length > 3 && !/^\[removed\]/.test(s))
    .map((s) => ({ statement: s.replace(/\s+/g, " "), quote: s, kind: kindOf(s), current: /\b(now|currently|present)\b/i.test(s) }));
  return { statements };
}

type DemoSeed = { field: { name: string; definition: string; examples: string[]; depth: number; reason: string }; core: DemoSeed["field"][]; evidence: string };

/** The demo's seeding: each numbered fact matches a keyword seed (a degree, game AI, RL or robotics work), merged by concept. */
function seed(prompt: string) {
  const concepts = new Map<string, { name: string; definition: string; examples: string[]; depth: number; reason: string; partOf: string | null; evidence: { fact: number; type: string }[] }>();
  for (const m of prompt.matchAll(/^\[(\d+)\] (?:\([^)]*\) )?(.*)$/gm)) {
    const fact = Number(m[1]);
    const statement = m[2]!;
    const pick: DemoSeed | null = /reinforcement|\bRL\b|robot/i.test(statement)
      ? RL_SEED
      : /\bgames?\b|\bGo\b|chess|poker|board/i.test(statement)
        ? GAME_SEED
        : /master|degree|student|bachelor|PhD|computer science|\bCS\b/i.test(statement)
          ? SEED
          : null;
    if (!pick) continue;
    for (const [c, partOf] of [[pick.field, null], ...pick.core.map((c) => [c, pick.field.name] as const)] as const) {
      const have = concepts.get(c.name) ?? { ...c, partOf, evidence: [] };
      have.evidence.push({ fact, type: pick.evidence });
      concepts.set(c.name, have);
    }
  }
  return { concepts: [...concepts.values()] };
}

const wordsOf = (text: string) => new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3).map((w) => w.replace(/s$/, "")));

/** The demo speaker: the context items that share a word with the question (or all of them), said plainly. */
function speak(prompt: string) {
  const asked = wordsOf(/^Question: (.*)$/m.exec(prompt)?.[1] ?? "");
  const items = [...prompt.matchAll(/^\[([^\]]+)\] \((\w+), [^)]*\) (.*)$/gm)].map((m) => ({ id: m[1]!, kind: m[2]!, text: m[3]! }));
  if (items.length === 0) return { reply: "", state: "not_on_record", cites: [], general: false };
  const hits = items.filter((i) => [...wordsOf(i.text)].some((w) => asked.has(w)));
  const use = hits.length ? hits : items;
  const guessOnly = use.every((i) => i.kind === "guess");
  return {
    reply: guessOnly ? `I haven't said much about this, but ${use.map((i) => i.text.replace(/ \(a guess.*$/, ".")).join(" ")}` : use.map((i) => i.text).join(" "),
    state: guessOnly ? "inferred" : "grounded",
    cites: use.map((i) => i.id),
    general: false,
  };
}

/** A ScriptedLLM that answers with the demo persona's hand-written fixtures. */
export function demoLLM(): ScriptedLLM {
  return new ScriptedLLM((req: GenerateObjectRequest<unknown>) => {
    if (req.purpose === "extract") {
      return EXTRACTIONS[observationText(req.prompt)] ?? { memories: [], exemplars: [] };
    }
    if (req.purpose === "seed") return seed(req.prompt);
    if (req.purpose === "intro") return intro(req.prompt);
    // Questions: how a project turned out, or what the pets in a node's facts are called.
    if (req.purpose === "question")
      return {
        questions: req.prompt.split(/\n(?=\[\d+\])/).flatMap((block) => {
          const head = /^\[(\d+)\] (.+) \((\w+), in \w+\)$/m.exec(block);
          if (!head) return [];
          const node = Number(head[1]);
          const pet = /\b(cats|dogs|cat|dog)\b/i.exec(block)?.[1]?.toLowerCase();
          if (pet) return [{ node, question: pet.endsWith("s") ? `What are your ${pet}' names?` : `What is your ${pet}'s name?` }];
          return head[3] === "project" ? [{ node, question: `How did ${head[2]} turn out?` }] : [];
        }),
      };
    // Anchoring: the best-ranked candidate, which the code lists first.
    if (req.purpose === "anchor")
      return { anchors: [...req.prompt.matchAll(/^\[(\d+)\][^\n]*\n {2}(\d+) /gm)].map((m) => ({ concept: Number(m[1]), subfield: m[2]! })) };
    // Answering: route to the best-ranked candidate, speak from the context items that share a word with the question.
    if (req.purpose === "route") return { seeds: /^\[1\]/m.test(req.prompt) ? [1] : [] };
    if (req.purpose === "speak") return speak(req.prompt);
    if (req.purpose === "check") return { supported: true, unsupported: [] };
    // Evals: plain questions from each item; a reply conveys a fact when it holds the fact's longer words.
    if (req.purpose === "case")
      return {
        cases: [...req.prompt.matchAll(/^\[(\d+)\] (?:\(([^)]*)\) )?(.*)$/gm)].map((m) => ({
          item: Number(m[1]),
          question: m[2] ? `What else can you tell me about ${m[2]}?` : `Is it true that ${m[3]!.replace(/\.$/, "").replace(/^I'm\b/, "you're").replace(/^I've\b/, "you've").replace(/^I\b/, "you").replace(/\bmy\b/gi, "your")}?`,
          forbidden: /private/.test(req.system) ? [m[3]!.replace(/\.$/, "").split(" ").slice(-2).join(" ")] : [],
        })),
      };
    if (req.purpose === "judge") {
      const reply = (/^Reply:\n([\s\S]*?)\n\nCited facts:/m.exec(req.prompt)?.[1] ?? "").toLowerCase();
      const expected = [...(req.prompt.split("Expected:\n")[1] ?? "").matchAll(/^\[\d+\] (.*)$/gm)].map((m) => m[1]!);
      return { mentions: expected.map((e) => [...wordsOf(e)].every((w) => reply.includes(w))), unsupported: [] };
    }
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
