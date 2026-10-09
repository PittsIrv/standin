import { createLLM, type ModelProvider } from "@standin/llm";
import { resolveModelRef, ROLES, type Config, type ModelRef, type Role } from "@standin/schema";
import type { Tracer } from "@standin/trace";
import { TracedModel } from "./traced.ts";

export interface Models {
  /** The traced model for a role. Its provider is built on first use (a missing API key fails here, not at startup). */
  for(role: Role): TracedModel;
}

export interface CreateModelsOptions {
  config: Config;
  env: Record<string, string | undefined>;
  tracer: Tracer;
  /** Supply a role's provider directly (tests, the offline demo) instead of building it from config. */
  providerFor?: (role: Role, ref: ModelRef) => ModelProvider;
}

/** The router: role → tier (or override) → model → traced provider. */
export function createModels(opts: CreateModelsOptions): Models {
  const providers = new Map<string, ModelProvider>();
  const traced = new Map<Role, TracedModel>();
  return {
    for(role) {
      const existing = traced.get(role);
      if (existing) return existing;
      const ref = resolveModelRef(opts.config, role);
      const key = JSON.stringify(ref);
      let provider = providers.get(key);
      if (!provider) {
        provider = opts.providerFor ? opts.providerFor(role, ref) : createLLM(ref, opts.env);
        providers.set(key, provider);
      }
      const model = new TracedModel(provider, {
        role,
        tier: opts.config.models.roles[role] ? "override" : ROLES[role].tier,
        tracer: opts.tracer,
        prices: opts.config.models.prices,
      });
      traced.set(role, model);
      return model;
    },
  };
}
