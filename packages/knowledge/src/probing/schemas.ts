import { z } from "zod";

export const ExpandSchema = z.object({
  /** `level` is how advanced each part is (1 basic – 4 expert); checked by `checkSplit`, not here. */
  components: z.array(z.object({ name: z.string(), definition: z.string(), level: z.number() })),
  prerequisites: z.array(z.object({ name: z.string(), definition: z.string() })),
});

export const QuizSchema = z.object({ probes: z.array(z.object({ question: z.string() })) });

export const GradeSchema = z.object({ grade: z.enum(["pass", "fail"]), reason: z.string() });
