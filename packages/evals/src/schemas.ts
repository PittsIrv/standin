import { z } from "zod";

/** Questions written for listed items; `forbidden` holds exact phrases of a private item (empty otherwise). */
export const CaseSchema = z.object({ cases: z.array(z.object({ item: z.number().int(), question: z.string(), forbidden: z.array(z.string()) })) });

/** For each expected fact, whether the reply conveys it; and claims about the person the cited facts don't state. */
export const JudgeSchema = z.object({ mentions: z.array(z.boolean()), unsupported: z.array(z.string()) });
export type Judged = z.infer<typeof JudgeSchema>;
