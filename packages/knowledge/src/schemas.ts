import { EntityKind, EvidenceKind, RawScore, RootKey } from "@standin/schema";
import { z } from "zod";
import { SEED_DEPTH } from "./lighting.ts";

export const PlaceSchema = z.object({
  merges: z.array(z.object({ from: z.string(), into: z.string() })),
  placements: z.array(
    z.object({
      topic: z.string(),
      parent: z.string(),
      parentDefinition: z.string().nullable(),
      /** Used only when the parent is new: its label, and the root it goes under. */
      parentLabel: EntityKind.default("topic"),
      root: RootKey.default("knowledge"),
      definition: z.string(),
    }),
  ),
});
export type Place = z.infer<typeof PlaceSchema>;

/** A seeded concept: what it includes, and the guess about it (depth 1–4, clamped in code) with its reason. */
const SeedConcept = z.object({
  name: z.string(),
  definition: z.string(),
  examples: z.array(z.string()).default([]),
  depth: z.number().default(SEED_DEPTH),
  reason: z.string().default(""),
});
export const SeedSchema = z.object({
  /** Null when the statement implies no field of knowledge (having two cats). */
  field: SeedConcept.nullable(),
  core: z.array(SeedConcept).default([]),
  /** `work` for jobs, research and projects; `background` for education and everything else. */
  evidence: z.enum(["background", "work"]).default("background"),
});

export const IntroSchema = z.object({ statements: z.array(z.string()) });
export type Seed = z.infer<typeof SeedSchema>;

export const HomeSchema = z.object({
  homes: z.array(
    z.object({
      memoryId: z.string(),
      /** An existing node's name, or the name of the node to create. */
      node: z.string(),
      /** Set only to create the node: under which existing node or root, with what label. */
      newNode: z.object({ parent: z.string(), label: EntityKind, definition: z.string() }).nullable(),
    }),
  ),
});
export type Home = z.infer<typeof HomeSchema>;

export const SplitSchema = z.object({
  children: z.array(z.object({ name: z.string(), label: EntityKind, definition: z.string(), memoryIds: z.array(z.string()) })),
});
export type Split = z.infer<typeof SplitSchema>;

export const HypothesizeSchema = z.object({
  hypotheses: z.array(
    z.object({
      node: z.string(),
      depth: z.number().int(),
      rawScore: RawScore,
      kind: EvidenceKind,
      /** Node names from something established to this node. */
      path: z.array(z.string()),
      reason: z.string(),
    }),
  ),
  /** Nodes whose open guess no longer holds. */
  withdraw: z.array(z.string()),
});
export type Hypothesize = z.infer<typeof HypothesizeSchema>;
