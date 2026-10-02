import { z } from "zod";
import { Lang } from "./records.ts";

export const Config = z.object({
  persona: z.object({
    name: z.string().min(1),
    languages: z.array(Lang).min(1).default(["en"]),
  }),
  compaction: z
    .object({
      model: z.string().min(1).default("claude-opus-5-5"),
      batchSize: z.number().int().positive().default(20),
    })
    .prefault({}),
  consolidation: z
    .object({
      retentionDays: z.number().positive().default(90),
      freshnessDays: z.number().positive().default(120),
      currentStateHalfLifeDays: z.number().positive().default(90),
    })
    .prefault({}),
  review: z.object({ weeklyCap: z.number().int().positive().default(25) }).prefault({}),
});
export type Config = z.infer<typeof Config>;
export type ConfigInput = z.input<typeof Config>;

export function parseConfig(raw: unknown): Config {
  return Config.parse(raw);
}
