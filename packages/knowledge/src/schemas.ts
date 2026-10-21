import { EntityKind, RootKey } from "@standin/schema";
import { z } from "zod";

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

export const SeedSchema = z.object({
  field: z.object({ name: z.string(), definition: z.string() }),
  core: z.array(z.object({ name: z.string(), definition: z.string() })),
});
export type Seed = z.infer<typeof SeedSchema>;
