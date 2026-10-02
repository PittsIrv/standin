import { EntityKind, Lang, MemoryKind, Register } from "@standin/schema";
import { z } from "zod";

/** What the model returns for one observation. Kind-specific attributes are flattened for structured output. */
export const ExtractionSchema = z.object({
  memories: z.array(
    z.object({
      kind: MemoryKind,
      statement: z.string(),
      lang: Lang,
      entities: z.array(z.object({ name: z.string(), kind: EntityKind })),
      suggestedTier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      validFrom: z.string().nullable(),
      validUntil: z.string().nullable(),
      isCurrentState: z.boolean(),
      competence: z.object({ domain: z.string(), depth: z.number() }).nullable(),
      stance: z.object({ topic: z.string(), strength: z.number() }).nullable(),
    }),
  ),
  exemplars: z.array(z.object({ text: z.string(), register: Register })),
});
export type Extraction = z.infer<typeof ExtractionSchema>;
export type ExtractedMemory = Extraction["memories"][number];

export const ReconcileAction = z.enum(["new", "duplicate", "update", "contradiction"]);
export type ReconcileAction = z.infer<typeof ReconcileAction>;

export const ReconcileSchema = z.object({
  action: ReconcileAction,
  targetId: z.string().nullable(),
  reason: z.string(),
});
export type Reconcile = z.infer<typeof ReconcileSchema>;
