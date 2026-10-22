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

/**
 * Background seeding over numbered facts (intro-sources spec §5): each concept with the guess about it (depth 1–4,
 * clamped in code), its reason, what it includes, where it goes (another concept in the answer, or null for the
 * Knowledge root), and the facts it rests on with the type of evidence each gives.
 */
export const SeedSchema = z.object({
  concepts: z
    .array(
      z.object({
        name: z.string(),
        definition: z.string(),
        examples: z.array(z.string()).default([]),
        depth: z.number().default(SEED_DEPTH),
        reason: z.string().default(""),
        partOf: z.string().nullable().default(null),
        evidence: z.array(z.object({ fact: z.number(), type: z.string() })).default([]),
      }),
    )
    .default([]),
});

/** One section read into statements; `kind` is checked against FactKind in code, so an unknown one becomes a label. */
export const IntroSchema = z.object({
  statements: z
    .array(
      z.object({
        statement: z.string(),
        quote: z.string(),
        kind: z.string().default("other"),
        kindLabel: z.string().nullable().default(null),
        start: z.string().nullable().default(null),
        end: z.string().nullable().default(null),
        current: z.boolean().default(false),
      }),
    )
    .default([]),
});
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

/** For each numbered concept, the id of one subfield from its own candidates, or null when none fits (anchors spec). */
export const AnchorSchema = z.object({
  anchors: z.array(z.object({ concept: z.number().int(), subfield: z.string().nullable() })).default([]),
});

/** Questions to the person about gaps, each on a numbered node (questions spec §1). */
export const QuestionSchema = z.object({
  questions: z.array(z.object({ node: z.number().int(), question: z.string() })).default([]),
});
