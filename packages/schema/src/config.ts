import { z } from "zod";
import { Lang } from "./records.ts";
import { DEFAULT_TIER_MODELS, isPrivateAddress, ROLE_NAMES, ROLES, type ModelTier, type Role } from "./roles.ts";

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

const EnvVarName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

export const Price = z.object({
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
  cacheReadPerMTok: z.number().nonnegative().optional(),
  cacheWritePerMTok: z.number().nonnegative().optional(),
});
export type Price = z.infer<typeof Price>;

const tierRef = (tier: ModelTier) => ModelRef.prefault(DEFAULT_TIER_MODELS[tier]);

const Models = z
  .object({
    tiers: z.object({ small: tierRef("small"), medium: tierRef("medium"), large: tierRef("large") }).prefault({}),
    /** Per-role overrides; anything not listed uses its tier's model. */
    roles: z.partialRecord(z.enum(ROLE_NAMES), ModelRef).default({}),
    /** USD per million tokens, overriding the built-in table (prices change). */
    prices: z.record(z.string().min(1), Price).default({}),
  })
  .prefault({})
  .superRefine((models, ctx) => {
    for (const role of ROLE_NAMES) {
      if (ROLES[role].zone !== "public") continue;
      const override = models.roles[role];
      const ref = override ?? models.tiers[ROLES[role].tier];
      if (ref.baseURL && isPrivateAddress(ref.baseURL)) {
        const via = override ? `models.roles.${role}` : `models.tiers.${ROLES[role].tier}`;
        ctx.addIssue({
          code: "custom",
          path: ["roles", role],
          message:
            `public role "${role}" would use ${ref.model} at ${ref.baseURL} (via ${via}), but the public agent runs on Cloudflare ` +
            `and can't reach a private network. Set models.roles.${role} to a hosted model, e.g. "${DEFAULT_TIER_MODELS[ROLES[role].tier]}".`,
        });
      }
    }
  });

const Tracing = z
  .object({
    otlp: z
      .object({
        /** e.g. http://localhost:4318/v1/traces (Jaeger, Phoenix) or a Langfuse OTLP endpoint. */
        endpoint: z.url(),
        /** Env var holding extra headers as "key=value,key2=value2" (auth tokens stay out of config). */
        headersEnv: EnvVarName.optional(),
        /** Prompts and outputs leave the machine only when this is true. */
        exportContent: z.boolean().default(false),
      })
      .optional(),
  })
  .prefault({});

export const Config = z.object({
  persona: z.object({
    name: z.string().min(1),
    languages: z.array(Lang).min(1).default(["en"]),
  }),
  compaction: z.object({ batchSize: z.number().int().positive().default(20) }).prefault({}),
  models: Models,
  tracing: Tracing,
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

/** The model a role uses: its override if set, else its tier's model. */
export function resolveModelRef(config: Config, role: Role): ModelRef {
  return config.models.roles[role] ?? config.models.tiers[ROLES[role].tier];
}
