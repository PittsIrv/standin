// Hand-written model outputs for the demo persona, so the full pipeline runs offline and in CI.
// Keyed by observation text (extraction) and by candidate statement (reconciliation).

type Kind = "fact" | "competence" | "stance" | "negative";
type EntityKind = "project" | "org" | "place" | "person" | "work" | "topic";

interface Candidate {
  kind?: Kind;
  statement: string;
  lang?: "en" | "zh";
  entities?: { name: string; kind: EntityKind }[];
  suggestedTier?: 1 | 2 | 3;
  isCurrentState?: boolean;
  competence?: { domain: string; depth: number };
  stance?: { topic: string; strength: number };
}

function x(memories: Candidate[], exemplars: { text: string; register: "casual" | "formal" }[] = []) {
  return {
    memories: memories.map((m) => ({
      kind: m.kind ?? "fact",
      statement: m.statement,
      lang: m.lang ?? "en",
      entities: m.entities ?? [],
      suggestedTier: m.suggestedTier ?? 1,
      validFrom: null,
      validUntil: null,
      isCurrentState: m.isCurrentState ?? false,
      competence: m.competence ?? null,
      stance: m.stance ?? null,
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
        { statement: "I'm a second-year master's student at Riverside Institute of Technology.", isCurrentState: true, entities: [{ name: "Riverside Institute of Technology", kind: "org" }] },
        { statement: "I build AIs for board games." },
        { kind: "competence", statement: "I'm strong at building game-playing AI.", competence: { domain: "game-playing AI", depth: 3 } },
        { statement: "I'm currently working on a self-play trainer for Lantern.", isCurrentState: true, entities: [lantern] },
      ],
      [{ text: "I build AIs for board games — mostly Go variants and a card game called Lantern.", register: "casual" }],
    ),
  "我从小跟外公下围棋，所以后来做游戏AI一点也不意外。说实话，我对强化学习的理论了解得不算深，更多是工程上的经验。": x(
    [
      { statement: "我从小跟外公下围棋。", lang: "zh", suggestedTier: 2, entities: [{ name: "围棋", kind: "topic" }] },
      { kind: "competence", statement: "我对强化学习理论了解不算深，更多是工程经验。", lang: "zh", competence: { domain: "强化学习理论", depth: 2 } },
    ],
    [{ text: "说实话，我对强化学习的理论了解得不算深，更多是工程上的经验。", register: "casual" }],
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
  "工资的事情我不太想公开讨论，可以直接邮件问我。": x([
    { statement: "我不想公开讨论工资，想了解可以直接邮件问我。", lang: "zh", suggestedTier: 3, entities: [{ name: "薪资", kind: "topic" }] },
  ]),
};

/** Candidate statement → [action, statement of the existing memory it targets]. Anything else is new. */
export const RECONCILIATIONS: Record<string, ["duplicate" | "update" | "contradiction", string]> = {
  "I build AIs for board games.": ["duplicate", "I build AIs for board games."],
  "I write most of my game engines in Rust rather than Python.": ["contradiction", "I prefer Python for all my projects."],
  "I'm currently working on a Go-variant engine called Kite.": ["update", "I'm currently working on a self-play trainer for Lantern."],
};
