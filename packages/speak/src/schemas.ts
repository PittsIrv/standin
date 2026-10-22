import { z } from "zod";

/** The router's pick: candidate numbers from the list it was shown, best first. */
export const RouteSchema = z.object({ seeds: z.array(z.number().int()) });

export const SpeakSchema = z.object({
  reply: z.string(),
  state: z.enum(["grounded", "inferred", "not_on_record"]),
  /** The ids of the context items the reply rests on. */
  cites: z.array(z.string()),
  /** The reply used general knowledge beyond the context. */
  general: z.boolean(),
});
export type SpeakOut = z.infer<typeof SpeakSchema>;

export const CheckSchema = z.object({ supported: z.boolean(), unsupported: z.array(z.string()) });
export type CheckOut = z.infer<typeof CheckSchema>;
