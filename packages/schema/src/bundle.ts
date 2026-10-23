import { z } from "zod";
import { MemoryKind, Register, RootKey, Tier } from "./records.ts";

/** How much a Knowledge node may be explained, worked out when the bundle is built (publish spec §2). */
export const BundleAnswer = z.object({
  mode: z.enum(["explain", "brief", "decline"]),
  depth: z.number().int().min(0).max(4).nullable(),
  /** `guess`: a confident hypothesis, never something the person said; it is spoken hedged. */
  via: z.enum(["own", "inherited", "guess"]).nullable(),
});
export type BundleAnswer = z.infer<typeof BundleAnswer>;

export const BundleNode = z.object({
  id: z.string(),
  name: z.string(),
  aliases: z.array(z.string()),
  definition: z.string().nullable(),
  examples: z.array(z.string()),
  /** The root this node is under; a root node carries its own key. */
  root: RootKey.nullable(),
  /** Its parent in the bundle; null for a root or an unplaced node. */
  parent: z.string().nullable(),
  /** Knowledge nodes only. */
  answer: BundleAnswer.nullable(),
});
export type BundleNode = z.infer<typeof BundleNode>;

export const BundleMemory = z.object({
  id: z.string(),
  statement: z.string(),
  kind: MemoryKind,
  tier: Tier.refine((t) => t <= 2, "only tiers 1–2 are published"),
  /** The nodes in the bundle it lives on or names, its home first. */
  nodes: z.array(z.string()),
  validUntil: z.iso.datetime().nullable(),
});
export type BundleMemory = z.infer<typeof BundleMemory>;

export const BundleExemplar = z.object({ id: z.string(), text: z.string(), register: Register });
export type BundleExemplar = z.infer<typeof BundleExemplar>;

/**
 * Everything a public visitor's turn may use, and nothing else (publish spec §2). The public server reads only this.
 * `version` is 0 for a draft that was never saved.
 */
export const Bundle = z.object({
  format: z.literal(1),
  version: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  persona: z.object({ name: z.string().min(1) }),
  nodes: z.array(BundleNode),
  related: z.array(z.tuple([z.string(), z.string()])),
  memories: z.array(BundleMemory),
  exemplars: z.array(BundleExemplar),
});
export type Bundle = z.infer<typeof Bundle>;
