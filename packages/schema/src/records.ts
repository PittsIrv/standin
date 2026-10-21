import { z } from "zod";

const IsoTime = z.iso.datetime();

export const Tier = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export type Tier = z.infer<typeof Tier>;

/** How the person relates to an observation. `exposed` never becomes knowledge. */
export const AuthorRole = z.enum(["self", "engaged", "exposed"]);
export type AuthorRole = z.infer<typeof AuthorRole>;

export const SourceKind = z.enum([
  "interview",
  "checkin",
  "manual",
  "slack",
  "github",
  "website",
  "gdrive",
  "claude-memory",
  "chatgpt-memory",
  "muse-paste",
  "chatgpt-export",
  "claude-export",
  "demo",
  "probe",
]);
export type SourceKind = z.infer<typeof SourceKind>;

export const COMPACTION_RESULTS = ["processed", "skipped_exposed", "failed"] as const;
export const CompactionResult = z.enum(COMPACTION_RESULTS);
export type CompactionResult = z.infer<typeof CompactionResult>;

const NonBlank = z.string().refine((s) => s.trim().length > 0, "must not be blank");

const LETTER = /\p{L}/gu;
const LATIN = /\p{Script=Latin}/gu;

/** True unless more than half of the text's letters are outside the Latin script. Text with no letters passes. */
export function isMostlyLatin(text: string): boolean {
  const letters = text.match(LETTER)?.length ?? 0;
  if (letters === 0) return true;
  const latin = text.match(LATIN)?.length ?? 0;
  return latin * 2 >= letters;
}

export const ObservationInput = z.object({
  sourceKind: SourceKind,
  sourceRef: z.string().min(1),
  authorRole: AuthorRole,
  text: NonBlank.refine(isMostlyLatin, "standin is English-only for now"),
  occurredAt: IsoTime,
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type ObservationInput = z.input<typeof ObservationInput>;

export const Observation = z.object({
  id: z.string(),
  sourceKind: SourceKind,
  sourceRef: z.string(),
  authorRole: AuthorRole,
  /** Null once purged by consolidation; the hash and pointers remain. */
  text: z.string().nullable(),
  contentHash: z.string(),
  occurredAt: IsoTime,
  ingestedAt: IsoTime,
  compactedAt: IsoTime.nullable(),
  compactionResult: CompactionResult.nullable(),
  purgedAt: IsoTime.nullable(),
  meta: z.record(z.string(), z.unknown()),
});
export type Observation = z.infer<typeof Observation>;

export const EntityKind = z.enum(["project", "org", "place", "person", "work", "topic", "pet", "other"]);
export type EntityKind = z.infer<typeof EntityKind>;

/** The six fixed roots of the world tree; everything else grows under them. */
export const RootKey = z.enum(["knowledge", "work", "background", "people", "views", "life"]);
export type RootKey = z.infer<typeof RootKey>;

export const ROOTS: readonly { key: RootKey; name: string }[] = [
  { key: "knowledge", name: "Knowledge" },
  { key: "work", name: "Work" },
  { key: "background", name: "Background" },
  { key: "people", name: "People" },
  { key: "views", name: "Views" },
  { key: "life", name: "Life" },
];

/** Where a node with this label goes when nothing better is known. */
export function defaultRoot(label: EntityKind): RootKey {
  switch (label) {
    case "topic":
      return "knowledge";
    case "project":
    case "org":
    case "work":
      return "work";
    case "person":
      return "people";
    default:
      return "life";
  }
}

export const Entity = z.object({
  id: z.string(),
  kind: EntityKind,
  name: z.string().min(1),
  aliases: z.array(z.string()),
});
export type Entity = z.infer<typeof Entity>;

export const MemoryKind = z.enum(["fact", "competence", "stance", "negative"]);
export type MemoryKind = z.infer<typeof MemoryKind>;

export const MemoryStatus = z.enum(["proposed", "approved", "rejected", "superseded", "expired", "retracted"]);
export type MemoryStatus = z.infer<typeof MemoryStatus>;

export const Depth = z.number().int().min(0).max(4);
/** Where a node's lighting came from: a claim, a rule's inference, probes, or a concept-card answer (`stated`). */
export const DepthBasis = z.enum(["claimed", "predicted", "probed", "stated"]);
export type DepthBasis = z.infer<typeof DepthBasis>;

/** A competence memory lights a topic node. `basis` is set on proposals the knowledge map writes; a claim has none. */
export const CompetenceAttrs = z.object({
  domain: z.string().min(1),
  depth: Depth,
  basis: DepthBasis.optional(),
  reasons: z.array(z.string()).optional(),
});
/** `background`: a fact stating the person's degree program, school, or job role; it seeds the knowledge tree. */
export const FactAttrs = z.object({ background: z.boolean().optional() });
export const StanceAttrs = z.object({ topic: z.string().min(1), strength: z.number().int().min(1).max(5) });
export const EmptyAttrs = z.object({});

const memoryBase = {
  id: z.string(),
  statement: NonBlank,
  tier: Tier,
  status: MemoryStatus,
  validFrom: IsoTime.nullable(),
  validUntil: IsoTime.nullable(),
  /** "Currently ..." memories expire unless re-corroborated. */
  isCurrentState: z.boolean(),
  /** True once the person approved it themselves. */
  affirmed: z.boolean(),
  supersedesId: z.string().nullable(),
  conflictsWithId: z.string().nullable(),
  recordedAt: IsoTime,
  decidedAt: IsoTime.nullable(),
  lastCorroboratedAt: IsoTime,
  /** The most specific node this memory is about: where it lives in the world tree. */
  homeNodeId: z.string().nullable().default(null),
};

export const Memory = z.discriminatedUnion("kind", [
  z.object({ ...memoryBase, kind: z.literal("fact"), attrs: FactAttrs }),
  z.object({ ...memoryBase, kind: z.literal("negative"), attrs: EmptyAttrs }),
  z.object({ ...memoryBase, kind: z.literal("competence"), attrs: CompetenceAttrs }),
  z.object({ ...memoryBase, kind: z.literal("stance"), attrs: StanceAttrs }),
]);
export type Memory = z.infer<typeof Memory>;
export type MemoryAttrs = Memory["attrs"];

export const ExemplarStatus = z.enum(["proposed", "approved", "rejected"]);
export type ExemplarStatus = z.infer<typeof ExemplarStatus>;

export const Register = z.enum(["casual", "formal"]);
export type Register = z.infer<typeof Register>;

export const Exemplar = z.object({
  id: z.string(),
  observationId: z.string(),
  text: z.string(),
  register: Register,
  status: ExemplarStatus,
  contentHash: z.string(),
  recordedAt: IsoTime,
  decidedAt: IsoTime.nullable(),
});
export type Exemplar = z.infer<typeof Exemplar>;

export const Actor = z.enum(["compaction", "person", "consolidation", "map"]);
export type Actor = z.infer<typeof Actor>;

export const MemoryEvent = z.object({
  id: z.string(),
  memoryId: z.string(),
  fromStatus: MemoryStatus.nullable(),
  toStatus: MemoryStatus,
  at: IsoTime,
  actor: Actor,
  note: z.string().nullable(),
});
export type MemoryEvent = z.infer<typeof MemoryEvent>;

/** (standin answer, person's correction) pairs, which later become preference-tuning data. */
export const PreferencePair = z.object({
  id: z.string(),
  question: z.string(),
  standinAnswer: z.string(),
  personAnswer: z.string(),
  createdAt: IsoTime,
});
export type PreferencePair = z.infer<typeof PreferencePair>;

export const TERMINAL_STATUSES = ["rejected", "superseded", "expired", "retracted"] as const satisfies readonly MemoryStatus[];

export const ALLOWED_TRANSITIONS: Record<MemoryStatus, readonly MemoryStatus[]> = {
  proposed: ["approved", "rejected"],
  approved: ["superseded", "expired", "retracted"],
  rejected: [],
  superseded: [],
  expired: [],
  retracted: [],
};

/** A node of the world tree: an entity plus its tree-only fields. */
export const Topic = z.object({
  id: z.string(),
  name: z.string(),
  aliases: z.array(z.string()),
  /** What kind of thing the node is; informational only. */
  label: EntityKind,
  /** Set only on the six root nodes. */
  rootKey: RootKey.nullable(),
  /** Created by expansion and not yet touched by the person, a claim or a probe: hidden from the tree view. */
  frontier: z.boolean(),
  /** As a part of its parent: how advanced it is (1 basic – 4 expert); decides which answers walk down to it. */
  partLevel: Depth.nullable().default(null),
  /** The person said "that's enough here": no more of its parts are asked. */
  walkStopped: z.boolean().default(false),
  definition: z.string().nullable(),
  /** The concrete things the concept covers, shown on its card as "Includes". */
  examples: z.array(z.string()).default([]),
  expandedAt: IsoTime.nullable(),
  /** The background fact that seeded this topic, if any. */
  seedMemoryId: z.string().nullable(),
  /** A tier-3 boundary: the standin deflects on this node and its branch. */
  boundaryTier: Tier.nullable(),
  deletedAt: IsoTime.nullable(),
});
export type Topic = z.infer<typeof Topic>;

export const EdgeKind = z.enum(["part_of", "requires", "related"]);
export type EdgeKind = z.infer<typeof EdgeKind>;

export const TopicEdge = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  kind: EdgeKind,
  source: z.enum(["expansion", "placement", "seeding", "person"]),
  createdAt: IsoTime,
  deletedAt: IsoTime.nullable(),
});
export type TopicEdge = z.infer<typeof TopicEdge>;

/** A part of a lit branch the person doesn't know as deeply: answered at `level` instead. */
export const Gap = z.object({
  id: z.string(),
  nodeId: z.string(),
  claimNodeId: z.string().nullable(),
  level: Depth,
  status: z.enum(["open", "kept", "lowered"]),
  source: z.enum(["stated", "probe"]),
  memoryId: z.string().nullable(),
  /** The probe response the person judged a gap, for gaps found by probing. */
  responseId: z.string().nullable().default(null),
  createdAt: IsoTime,
});
export type Gap = z.infer<typeof Gap>;

export const Rating = z.enum(["know", "roughly", "no_idea", "wouldnt_say"]);
export type Rating = z.infer<typeof Rating>;

/** Held-out probes are test items: `fixed` never feeds the map, `rotating` only once released. */
export const Holdout = z.enum(["none", "fixed", "rotating"]);
export type Holdout = z.infer<typeof Holdout>;

export const AnswerModeName = z.enum(["explain", "brief", "decline"]);
export type AnswerModeName = z.infer<typeof AnswerModeName>;

/** `card` is a concept card; the others are quiz probes from before concept cards, kept so old rows still read. */
export const ProbeKind = z.enum(["claim", "followup", "foundation", "discovery", "hypothesis", "card"]);
export type ProbeKind = z.infer<typeof ProbeKind>;

export const Probe = z.object({
  id: z.string(),
  nodeId: z.string(),
  /** For claim checks and their follow-ups: the claimed node being checked. */
  checkOf: z.string().nullable(),
  kind: ProbeKind,
  difficulty: Depth.min(1),
  question: NonBlank,
  holdout: Holdout,
  createdAt: IsoTime,
  releasedAt: IsoTime.nullable(),
  /** For a hypothesis probe: the hypothesis it tests. */
  hypothesisId: z.string().nullable().default(null),
});
export type Probe = z.infer<typeof Probe>;

export const ProbeResponse = z.object({
  id: z.string(),
  probeId: z.string(),
  sessionId: z.string(),
  shownAt: IsoTime,
  /** The standin's answer mode for the node, recorded when shown and before the rating. */
  predictedMode: AnswerModeName,
  rating: Rating.nullable(),
  answeredAt: IsoTime.nullable(),
  spotCheck: z.enum(["none", "requested", "answered"]),
  spotCheckAnswer: z.string().nullable(),
  observationId: z.string().nullable(),
  grade: z.enum(["pass", "fail"]).nullable(),
  gradeReason: z.string().nullable(),
  gradeBatchId: z.string().nullable(),
  /** The person's judgment of a miss. */
  judged: z.enum(["gap", "not_gap"]).nullable(),
  /** For a hypothesis probe: its calibrated probability and the prior-only one, stored when shown. */
  predictedP: z.number().nullable().default(null),
  priorP: z.number().nullable().default(null),
  /** For a concept card: the level the person gave (0–4); null for "wouldn't say" or a quiz probe. */
  level: Depth.nullable().default(null),
});
export type ProbeResponse = z.infer<typeof ProbeResponse>;

export const EvidenceKind = z.enum(["background", "part", "prerequisite", "work", "other"]);
export type EvidenceKind = z.infer<typeof EvidenceKind>;
export const RawScore = z.enum(["low", "medium", "high"]);
export type RawScore = z.infer<typeof RawScore>;
/** A settled hypothesis's outcome (confirmed or refuted) is read from its probe responses, so a late grade can flip it. */
export const HypothesisStatus = z.enum(["open", "settled", "withdrawn"]);
export type HypothesisStatus = z.infer<typeof HypothesisStatus>;

/** "Probably knows {node} at {depth}": a guess with its evidence, verified by probes. Knowledge nodes only. */
export const Hypothesis = z.object({
  id: z.string(),
  nodeId: z.string(),
  depth: Depth.min(1),
  rawScore: RawScore,
  kind: EvidenceKind,
  /** Node ids from an established node to this one (at most 2 hops). */
  path: z.array(z.string()).min(1),
  reason: z.string(),
  status: HypothesisStatus,
  createdAt: IsoTime,
  settledAt: IsoTime.nullable(),
});
export type Hypothesis = z.infer<typeof Hypothesis>;

export const ReviewSession = z.object({
  id: z.string(),
  startedAt: IsoTime,
  endedAt: IsoTime.nullable(),
  /** Questions planned; 0 means no cap (a concept-card session runs until nothing is left). */
  size: z.number().int().nonnegative(),
});
export type ReviewSession = z.infer<typeof ReviewSession>;
