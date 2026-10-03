import { z } from "zod";
import { Lang } from "./records.ts";

const ModelObject = z
  .object({
    provider: z.enum(["anthropic", "openai-compatible"]).default("anthropic"),
    model: z.string().min(1),
    /** Required for openai-compatible, e.g. http://localhost:11434/v1 for Ollama. */
    baseURL: z.url().optional(),
    /** The name of the env var holding the API key. The key itself never goes in config. */
    apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
    structuredOutput: z.enum(["json_schema", "json_object"]).optional(),
  })
  .refine((m) => m.provider !== "openai-compatible" || m.baseURL, { message: "openai-compatible models need a baseURL", path: ["baseURL"] });

/** A model choice: a bare string means an Anthropic model id. */
export const ModelRef = z.union([z.string().min(1).transform((model) => ModelObject.parse({ model })), ModelObject]);
export type ModelRef = z.infer<typeof ModelRef>;

export const Config = z.object({
  persona: z.object({
    name: z.string().min(1),
    languages: z.array(Lang).min(1).default(["en"]),
  }),
  compaction: z
    .object({
      /** Reads each observation and extracts memories: the expensive, quality-critical call. */
      model: ModelRef.prefault("claude-opus-5-5"),
      /** Short classification of a candidate against similar memories. Defaults to `model`. */
      reconcileModel: ModelRef.optional(),
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
