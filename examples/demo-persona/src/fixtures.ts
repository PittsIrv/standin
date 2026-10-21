import type { EntityKind, RootKey } from "@standin/schema";

// Hand-written model outputs for the demo persona, so the full pipeline runs offline and in CI.
// Keyed by observation text (extraction) and by candidate statement (reconciliation).

type Kind = "fact" | "competence" | "stance" | "negative";

interface Candidate {
  kind?: Kind;
  statement: string;
  entities?: { name: string; kind: EntityKind }[];
  suggestedTier?: 1 | 2 | 3;
  isCurrentState?: boolean;
  competence?: { domain: string; depth: number };
  stance?: { topic: string; strength: number };
  background?: boolean;
}

function x(memories: Candidate[], exemplars: { text: string; register: "casual" | "formal" }[] = []) {
  return {
    memories: memories.map((m) => ({
      kind: m.kind ?? "fact",
      statement: m.statement,
      entities: m.entities ?? [],
      suggestedTier: m.suggestedTier ?? 1,
      validFrom: null,
      validUntil: null,
      isCurrentState: m.isCurrentState ?? false,
      competence: m.competence ?? null,
      stance: m.stance ?? null,
      background: m.background ?? false,
    })),
    exemplars,
  };
}

const python = { name: "Python", kind: "topic" as const };
const lantern = { name: "Lantern", kind: "work" as const };

export const EXTRACTIONS: Record<string, ReturnType<typeof x>> = {
  "User prefers Python for all projects. User is learning Japanese.": x([
    { kind: "stance", statement: "I prefer Python for all my projects.", entities: [python], stance: { topic: "programming languages", strength: 3 } },
    { statement: "I'm learning Japanese.", suggestedTier: 2, isCurrentState: true, entities: [{ name: "Japanese", kind: "topic" }] },
  ]),
  "I'm Lin Qiao, a second-year master's student at Riverside Institute of Technology. I build AIs for board games — mostly Go variants and a card game called Lantern. I'm currently working on a self-play trainer for Lantern.":
    x(
      [
        {
          statement: "I'm a second-year master's student at Riverside Institute of Technology.",
          isCurrentState: true,
          background: true,
          entities: [{ name: "Riverside Institute of Technology", kind: "org" }],
        },
        { statement: "I build AIs for board games." },
        { kind: "competence", statement: "I'm strong at building game-playing AI.", competence: { domain: "game-playing AI", depth: 3 } },
        { statement: "I'm currently working on a self-play trainer for Lantern.", isCurrentState: true, entities: [lantern] },
      ],
      [{ text: "I build AIs for board games — mostly Go variants and a card game called Lantern.", register: "casual" }],
    ),
  "I grew up playing Go with my grandfather, so building game AI was no surprise. Honestly, my grasp of reinforcement learning theory isn't deep; it's mostly engineering experience.": x(
    [
      { statement: "I grew up playing Go with my grandfather.", suggestedTier: 2, entities: [{ name: "Go", kind: "topic" }] },
      {
        kind: "competence",
        statement: "My grasp of reinforcement learning theory isn't deep; it's mostly engineering experience.",
        competence: { domain: "reinforcement learning theory", depth: 2 },
      },
    ],
    [{ text: "Honestly, my grasp of reinforcement learning theory isn't deep; it's mostly engineering experience.", register: "casual" }],
  ),
  "I've never been to Japan, even though half my favorite games come from there. And I don't really know anything about chess engines — people assume I do.":
    x([
      { kind: "negative", statement: "I've never been to Japan.", suggestedTier: 2, entities: [{ name: "Japan", kind: "place" }] },
      { kind: "negative", statement: "I don't know much about chess engines.", entities: [{ name: "chess engines", kind: "topic" }] },
    ]),
  "ok hot take: MCTS with a decent value net beats pure self-play from scratch for small teams. fight me 😅": x(
    [
      {
        kind: "stance",
        statement: "For small teams, MCTS with a decent value net beats pure self-play from scratch.",
        stance: { topic: "MCTS vs self-play", strength: 4 },
      },
    ],
    [{ text: "ok hot take: MCTS with a decent value net beats pure self-play from scratch for small teams. fight me 😅", register: "casual" }],
  ),
  "These days I write most of my game engines in Rust, not Python. Python's fine for the training scripts though.": x([
    {
      kind: "stance",
      statement: "I write most of my game engines in Rust rather than Python.",
      entities: [python, { name: "Rust", kind: "topic" }],
      stance: { topic: "programming languages", strength: 4 },
    },
  ]),
  "Lin Qiao builds AIs for board games. Projects: Lantern Bot, a self-play agent for the card game Lantern.": x([
    { statement: "I build AIs for board games." },
    { statement: "I built Lantern Bot, a self-play agent for the card game Lantern.", entities: [{ name: "Lantern Bot", kind: "project" }] },
  ]),
  "Update: the Lantern trainer is done. Now I'm working on a Go-variant engine called Kite.": x([
    { statement: "I'm currently working on a Go-variant engine called Kite.", isCurrentState: true, entities: [{ name: "Kite", kind: "project" }, lantern] },
  ]),
  "I'd rather not discuss my salary publicly; feel free to email me about it.": x([
    { statement: "I'd rather not discuss my salary publicly; people can email me about it.", suggestedTier: 3, entities: [{ name: "salary", kind: "topic" }] },
  ]),
};

/** Candidate statement → [action, statement of the existing memory it targets]. Anything else is new. */
export const RECONCILIATIONS: Record<string, ["duplicate" | "update" | "contradiction", string]> = {
  "I build AIs for board games.": ["duplicate", "I build AIs for board games."],
  "I write most of my game engines in Rust rather than Python.": ["contradiction", "I prefer Python for all my projects."],
  "I'm currently working on a Go-variant engine called Kite.": ["update", "I'm currently working on a self-play trainer for Lantern."],
};

/** The `map` role's background seeding for Lin Qiao's master's program. */
export const SEED = {
  field: { name: "Computer science", definition: "The study of computation and its applications." },
  core: [
    { name: "Algorithms", definition: "Designing and analyzing step-by-step procedures." },
    { name: "Systems", definition: "How computers, operating systems and networks work." },
    { name: "Machine learning", definition: "Learning models from data." },
    { name: "Theory of computation", definition: "What can be computed, and how efficiently." },
    { name: "Software engineering", definition: "Building and maintaining software." },
  ],
};

/**
 * Demo node → [parent, parent definition (null if it exists), node definition, root for a new parent, label for a new parent].
 * The last two default to the Knowledge root and `topic`.
 */
export const PLACEMENTS: Record<string, [string, string | null, string, RootKey?, EntityKind?]> = {
  Python: ["Programming languages", "Languages for writing software.", "A general-purpose programming language."],
  Rust: ["Programming languages", "Languages for writing software.", "A systems programming language."],
  "reinforcement learning theory": ["Machine learning", null, "The mathematics of learning from rewards."],
  "chess engines": ["Game AI", "Programs that play games.", "Programs that play chess."],
  "game-playing AI": ["Game AI", "Programs that play games.", "AI that plays games."],
  Japanese: ["Languages", "Human languages.", "The language of Japan."],
  Go: ["Board games", "Games played on a board.", "An abstract strategy board game."],
  salary: ["Personal matters", "Private details about the person.", "Pay."],
  Kite: ["Projects", "Things Lin built.", "A Go engine.", "work", "other"],
  "Lantern Bot": ["Projects", "Things Lin built.", "A card-game bot.", "work", "other"],
  Lantern: ["Writing", "Things Lin wrote.", "An essay.", "work", "other"],
  "Riverside Institute of Technology": ["Education", "Where Lin studied.", "Lin's university.", "background", "other"],
  Japan: ["Places", "Places in Lin's life.", "A country Lin lived in.", "life", "other"],
};

/** The demo's guesses: one sound, one the guards refuse (chess engines already has a stated gap). */
export const HYPOTHESES = {
  hypotheses: [
    { node: "Game AI", depth: 2, rawScore: "medium", kind: "part", path: ["game-playing AI", "Game AI"], reason: "game-playing AI is part of Game AI" },
    { node: "chess engines", depth: 2, rawScore: "low", kind: "part", path: ["game-playing AI", "Game AI", "chess engines"], reason: "a sibling of game-playing AI" },
  ],
  withdraw: [],
};
