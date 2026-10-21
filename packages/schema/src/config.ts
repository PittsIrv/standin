import { z } from "zod";
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
  persona: z.object({ name: z.string().min(1) }),
  compaction: z.object({ batchSize: z.number().int().positive().default(20) }).prefault({}),
  models: Models,
  tracing: Tracing,
  consolidation: z
    .object({
      /** When set, `consolidate` purges raw and trace text older than this. Otherwise only `standin purge` does. */
      purgeAfterDays: z.number().positive().optional(),
      /** A current-state memory not mentioned for this long gets a "Still true?" card. */
      freshnessDays: z.number().positive().default(120),
    })
    .prefault({}),
  tree: z
    .object({
      /** A node with more approved home facts than this is split into children. A starting value, tuned by experiment. */
      splitAt: z.number().int().positive().default(12),
    })
    .prefault({}),
  /** Starting values, tuned by experiment (world-tree spec §5). */
  hypotheses: z
    .object({
      /** A probable node is spoken (hedged) only at or above this probability. */
      speakAt: z.number().min(0).max(1).default(0.8),
      /** An evidence cell this unreliable stops being proposed… */
      dropBelow: z.number().min(0).max(1).default(0.3),
      /** …once it has at least this many outcomes. */
      dropAfter: z.number().int().positive().default(10),
      /** Held-out answers the Brier safeguard looks back over. */
      brierWindow: z.number().int().positive().default(20),
      /** The most pseudo-counts a loaded default-reliability file may add per cell. */
      priorCap: z.number().positive().default(10),
    })
    .prefault({}),
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
