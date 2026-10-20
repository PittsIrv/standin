import { z } from "zod";

export const ExpandSchema = z.object({
  components: z.array(z.object({ name: z.string(), definition: z.string() })),
  prerequisites: z.array(z.object({ name: z.string(), definition: z.string() })),
});

export const QuizSchema = z.object({ probes: z.array(z.object({ question: z.string() })) });

export const GradeSchema = z.object({ grade: z.enum(["pass", "fail"]), reason: z.string() });
