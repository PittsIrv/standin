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

const core = (name: string, definition: string, examples: string[], depth: number, reason: string) => ({ name, definition, examples, depth, reason });

/** The `map` role's background seeding for Lin Qiao's master's program (and any degree, in the demo). */
export const SEED = {
  field: core("Computer science", "The study of computation and its applications.", ["algorithms", "systems", "machine learning", "theory"], 2, "a CS master's degree covers the field"),
  core: [
    core("Algorithms", "Designing and analyzing step-by-step procedures.", ["sorting", "graph algorithms", "dynamic programming"], 2, "a required course in a CS master's"),
    core("Systems", "How computers, operating systems and networks work.", ["operating systems", "networking", "concurrency"], 2, "a required course in a CS master's"),
    core("Machine learning", "Learning models from data.", ["supervised learning", "neural networks", "reinforcement learning"], 2, "a core area of a CS master's"),
    core("Theory of computation", "What can be computed, and how efficiently.", ["automata", "computability", "complexity classes"], 2, "a required course in a CS master's"),
    core("Software engineering", "Building and maintaining software.", ["version control", "testing", "software design"], 2, "a required course in a CS master's"),
  ],
  evidence: "background" as const,
};

/** The demo's seeding for game-AI work. */
export const GAME_SEED = {
  field: core("Game AI", "Programs that play games.", ["game-tree search", "Monte Carlo tree search", "self-play"], 3, "you build AIs for games"),
  core: [
    core("Monte Carlo tree search", "Search guided by random playouts.", ["UCT", "rollouts", "progressive widening"], 3, "the search behind most modern game engines"),
    core("Self-play training", "Agents that learn by playing themselves.", ["AlphaZero", "policy iteration", "replay buffers"], 3, "how game engines like yours are trained"),
    core("Reinforcement learning", "Learning to act from rewards.", ["Markov decision processes", "Q-learning", "policy gradients"], 2, "self-play training is reinforcement learning"),
  ],
  evidence: "work" as const,
};

/** The demo's seeding for research in reinforcement learning or robotics. */
export const RL_SEED = {
  field: core("Machine learning", "Learning models from data.", ["supervised learning", "neural networks", "reinforcement learning"], 3, "your research is in machine learning"),
  core: [
    core("Reinforcement learning", "Learning to act from rewards.", ["Markov decision processes", "Q-learning", "policy gradients"], 3, "you research reinforcement learning"),
    core("Neural networks", "Models built from layers of learned functions.", ["backpropagation", "transformers", "SGD and Adam"], 3, "modern RL research runs on neural networks"),
    core("Probability and statistics", "Reasoning about uncertainty and data.", ["random variables", "expectation", "Bayes' rule"], 2, "RL is built on probability"),
  ],
  evidence: "work" as const,
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

type Part = [name: string, definition: string, level: number, examples: string[]];
/** The demo's splits: concrete parts, named by content, each with what it includes. Other concepts have no parts in the demo. */
export const SPLITS: Record<string, Part[]> = {
  Algorithms: [
    ["Sorting and searching", "Putting data in order and finding things in it.", 1, ["quicksort", "mergesort", "binary search", "heaps"]],
    ["Graph algorithms", "Exploring and optimizing over graphs.", 2, ["BFS and DFS", "Dijkstra's algorithm", "minimum spanning trees", "topological sort"]],
    ["Dynamic programming", "Solving problems by combining answers to overlapping subproblems.", 2, ["knapsack", "edit distance", "longest common subsequence", "memoization"]],
    ["Network flow and matching", "Maximum flows and matchings in graphs.", 3, ["max-flow/min-cut", "Ford–Fulkerson", "bipartite matching", "Hungarian algorithm"]],
    ["Randomized and approximation algorithms", "Algorithms that use chance, or settle for near-optimal answers.", 4, ["randomized quicksort", "Karger's min cut", "set cover approximation", "PTAS"]],
  ],
  "Graph algorithms": [
    ["Graph traversal", "Visiting every node of a graph in a systematic order.", 1, ["breadth-first search", "depth-first search", "connected components"]],
    ["Shortest paths", "Finding the cheapest route between nodes.", 2, ["Dijkstra's algorithm", "Bellman–Ford", "A* search", "Floyd–Warshall"]],
    ["Spanning trees", "Connecting all nodes at the lowest total cost.", 2, ["Kruskal's algorithm", "Prim's algorithm", "union–find"]],
    ["Strongly connected components", "Groups of nodes that can all reach each other.", 3, ["Tarjan's algorithm", "Kosaraju's algorithm", "condensation graphs"]],
  ],
  Systems: [
    ["Processes and threads", "How an operating system runs many programs at once.", 1, ["scheduling", "context switches", "fork and exec"]],
    ["Memory management", "How programs get and share memory.", 2, ["virtual memory", "paging", "caches", "garbage collection"]],
    ["Concurrency control", "Keeping shared data correct under parallel access.", 2, ["locks", "race conditions", "deadlock", "atomics"]],
    ["Networking", "How computers talk to each other.", 2, ["TCP/IP", "sockets", "HTTP", "DNS"]],
    ["Distributed systems", "Many machines acting as one system.", 4, ["consensus (Raft, Paxos)", "replication", "CAP theorem", "clock synchronization"]],
  ],
  "Machine learning": [
    ["Supervised learning", "Learning to predict labels from examples.", 1, ["linear regression", "logistic regression", "decision trees", "train/test split"]],
    ["Neural networks", "Models built from layers of learned functions.", 2, ["backpropagation", "convolutional networks", "transformers", "SGD and Adam"]],
    ["Reinforcement learning", "Learning to act from rewards.", 2, ["Markov decision processes", "Q-learning", "policy gradients", "exploration vs. exploitation"]],
    ["Probabilistic models", "Models that reason with uncertainty.", 3, ["Bayesian inference", "Gaussian mixtures", "hidden Markov models", "variational inference"]],
    ["Learning theory", "When and why learning works.", 4, ["PAC learning", "VC dimension", "generalization bounds", "bias–variance tradeoff"]],
  ],
  "Reinforcement learning": [
    ["Rewards and returns", "What the agent is trying to maximize.", 1, ["reward signals", "discounting", "episodes"]],
    ["Value-based methods", "Learning how good states and actions are.", 2, ["Q-learning", "DQN", "temporal-difference learning"]],
    ["Policy-gradient methods", "Learning the policy directly.", 3, ["REINFORCE", "actor–critic", "PPO"]],
    ["Model-based RL and planning", "Learning a model of the world and planning with it.", 3, ["Dyna", "MuZero", "Monte Carlo tree search"]],
    ["Distributed and asynchronous RL", "Training agents across many workers at once.", 4, ["A3C", "IMPALA", "Ape-X"]],
  ],
  "Theory of computation": [
    ["Automata and regular languages", "Simple machines and the patterns they recognize.", 1, ["finite automata", "regular expressions", "pumping lemma"]],
    ["Computability", "What computers can and cannot solve at all.", 2, ["Turing machines", "the halting problem", "reductions"]],
    ["Complexity classes", "How hard problems are to solve.", 3, ["P vs NP", "NP-completeness", "PSPACE"]],
    ["Approximation hardness", "How close to optimal we can hope to get.", 4, ["PCP theorem", "inapproximability", "unique games conjecture"]],
  ],
  "Software engineering": [
    ["Version control", "Tracking and sharing changes to code.", 1, ["git", "branches", "pull requests"]],
    ["Testing", "Checking that software does what it should.", 2, ["unit tests", "integration tests", "test-driven development"]],
    ["Software design", "Structuring code so it can grow.", 2, ["modules and interfaces", "design patterns", "refactoring"]],
    ["Reliability in production", "Keeping software running for real users.", 3, ["monitoring", "incident response", "continuous deployment"]],
  ],
  "Game AI": [
    ["Game-tree search", "Looking ahead through possible moves.", 1, ["minimax", "alpha–beta pruning", "iterative deepening"]],
    ["Monte Carlo tree search", "Search guided by random playouts.", 2, ["UCT", "rollouts", "progressive widening"]],
    ["Evaluation functions", "Scoring a position without searching further.", 2, ["handcrafted features", "value networks", "endgame tables"]],
    ["Self-play training", "Agents that learn by playing themselves.", 3, ["AlphaZero", "policy iteration", "replay buffers"]],
    ["Imperfect-information games", "Games where players hide information.", 4, ["counterfactual regret minimization", "poker bots", "information sets"]],
  ],
  "Programming languages": [
    ["Types", "Classifying values to catch mistakes.", 1, ["static vs. dynamic typing", "generics", "type inference"]],
    ["Memory and ownership", "Who owns data, and when it is freed.", 2, ["garbage collection", "Rust's borrow checker", "reference counting"]],
    ["Compilers", "Turning source code into running programs.", 3, ["parsing", "intermediate representations", "optimization passes"]],
    ["Language semantics", "What programs mean, precisely.", 4, ["operational semantics", "lambda calculus", "type soundness"]],
  ],
};
