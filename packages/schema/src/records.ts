import { z } from "zod";

const IsoTime = z.iso.datetime();

export const Tier = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export type Tier = z.infer<typeof Tier>;

export const Lang = z.enum(["en", "zh", "mixed", "other"]);
export type Lang = z.infer<typeof Lang>;

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
]);
export type SourceKind = z.infer<typeof SourceKind>;

export const COMPACTION_RESULTS = ["processed", "skipped_exposed", "failed"] as const;
export const CompactionResult = z.enum(COMPACTION_RESULTS);
export type CompactionResult = z.infer<typeof CompactionResult>;

const NonBlank = z.string().refine((s) => s.trim().length > 0, "must not be blank");

export const ObservationInput = z.object({
  sourceKind: SourceKind,
  sourceRef: z.string().min(1),
  authorRole: AuthorRole,
  lang: Lang,
  text: NonBlank,
  occurredAt: IsoTime,
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type ObservationInput = z.input<typeof ObservationInput>;

export const Observation = z.object({
  id: z.string(),
  sourceKind: SourceKind,
  sourceRef: z.string(),
  authorRole: AuthorRole,
  lang: Lang,
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

export const EntityKind = z.enum(["project", "org", "place", "person", "work", "topic"]);
export type EntityKind = z.infer<typeof EntityKind>;

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

export const CompetenceAttrs = z.object({ domain: z.string().min(1), depth: z.number().int().min(0).max(4) });
export const StanceAttrs = z.object({ topic: z.string().min(1), strength: z.number().int().min(1).max(5) });
export const EmptyAttrs = z.object({});

const memoryBase = {
  id: z.string(),
  statement: NonBlank,
  lang: Lang,
  tier: Tier,
  status: MemoryStatus,
  confidence: z.number().min(0).max(1),
  salience: z.number().min(0),
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
};

export const Memory = z.discriminatedUnion("kind", [
  z.object({ ...memoryBase, kind: z.literal("fact"), attrs: EmptyAttrs }),
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
  lang: Lang,
  register: Register,
  status: ExemplarStatus,
  contentHash: z.string(),
  recordedAt: IsoTime,
  decidedAt: IsoTime.nullable(),
});
export type Exemplar = z.infer<typeof Exemplar>;

export const Actor = z.enum(["compaction", "person", "consolidation"]);
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
  lang: Lang,
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
