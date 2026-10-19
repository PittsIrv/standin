import { z } from "zod";

export const PlaceSchema = z.object({
  merges: z.array(z.object({ from: z.string(), into: z.string() })),
  placements: z.array(
    z.object({ topic: z.string(), parent: z.string(), parentDefinition: z.string().nullable(), definition: z.string() }),
  ),
});
export type Place = z.infer<typeof PlaceSchema>;

export const SeedSchema = z.object({
  field: z.object({ name: z.string(), definition: z.string() }),
  core: z.array(z.object({ name: z.string(), definition: z.string() })),
});
export type Seed = z.infer<typeof SeedSchema>;
