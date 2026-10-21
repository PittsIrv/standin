import { z } from "zod";

export const ExpandSchema = z.object({
  /** `level` is how advanced each part is (1 basic – 4 expert); checked by `checkSplit`, not here. */
  components: z.array(z.object({ name: z.string(), definition: z.string(), level: z.number(), examples: z.array(z.string()).default([]) })),
  prerequisites: z.array(z.object({ name: z.string(), definition: z.string() })),
});
