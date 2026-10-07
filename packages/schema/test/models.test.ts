import { describe, expect, it } from "vitest";
import { DEFAULT_TIER_MODELS, isPrivateAddress, parseConfig, resolveModelRef, ROLES, type Role } from "../src/index.ts";

const base = { persona: { name: "X" } };

describe("roles", () => {
  it("every role has a known tier, a zone and a purpose", () => {
    for (const [role, def] of Object.entries(ROLES)) {
      expect(DEFAULT_TIER_MODELS[def.tier], role).toBeTruthy();
      expect(["private", "public"]).toContain(def.zone);
      expect(def.purpose.trim(), role).not.toBe("");
    }
    expect(ROLES.extract.tier).toBe("large");
    expect(ROLES.reconcile.tier).toBe("small");
    expect(ROLES.answer.zone).toBe("public");
  });
});

describe("models config", () => {
  it("resolves a role through its tier, unless the role is overridden", () => {
    const c = parseConfig({
      ...base,
      models: {
        tiers: { small: "claude-haiku-4-5-20251001" },
        roles: { reconcile: { provider: "openai-compatible", model: "qwen3:8b", baseURL: "http://localhost:11434/v1" } },
      },
    });
    expect(resolveModelRef(c, "extract")).toEqual({ provider: "anthropic", model: "claude-opus-5-5" });
    expect(resolveModelRef(c, "screen")).toEqual({ provider: "anthropic", model: "claude-haiku-4-5-20251001" });
    expect(resolveModelRef(c, "reconcile")).toMatchObject({ provider: "openai-compatible", model: "qwen3:8b" });
    // The stored (object) form re-parses to the same config.
    expect(parseConfig(JSON.parse(JSON.stringify(c)))).toEqual(c);
  });

  it("refuses a local model for a public role and names the fix", () => {
    const local = { provider: "openai-compatible", model: "qwen3:8b", baseURL: "http://localhost:11434/v1" };
    let message = "";
    try {
      parseConfig({ ...base, models: { tiers: { small: local } } });
    } catch (err) {
      message = String(err);
    }
    expect(message).toContain("models.roles.answer");
    expect(message).toContain("localhost");
    expect(() => parseConfig({ ...base, models: { tiers: { small: local }, roles: { answer: "claude-haiku-4-5-20251001" } } })).not.toThrow();
    expect(() => parseConfig({ ...base, models: { roles: { answer: local } } })).toThrow(/models\.roles\.answer/);
  });

  it("rejects unknown roles, missing baseURLs and key-looking apiKeyEnv values", () => {
    expect(() => parseConfig({ ...base, models: { roles: { summarize: "m" } } })).toThrow();
    expect(() => parseConfig({ ...base, models: { tiers: { large: { provider: "openai-compatible", model: "q" } } } })).toThrow(/baseURL/);
    expect(() => parseConfig({ ...base, models: { tiers: { large: { model: "m", apiKeyEnv: "sk-ant-oops key" } } } })).toThrow();
  });

  it("validates prices and tracing", () => {
    const c = parseConfig({
      ...base,
      models: { prices: { "qwen3:8b": { inputPerMTok: 0, outputPerMTok: 0 } } },
      tracing: { otlp: { endpoint: "http://localhost:4318/v1/traces", headersEnv: "OTLP_HEADERS" } },
    });
    expect(c.tracing.otlp).toEqual({ endpoint: "http://localhost:4318/v1/traces", headersEnv: "OTLP_HEADERS", exportContent: false });
    expect(() => parseConfig({ ...base, models: { prices: { m: { inputPerMTok: -1, outputPerMTok: 0 } } } })).toThrow();
    expect(() => parseConfig({ ...base, tracing: { otlp: { endpoint: "not a url" } } })).toThrow();
    expect(() => parseConfig({ ...base, tracing: { otlp: { endpoint: "http://x/v1/traces", headersEnv: "bad name" } } })).toThrow();
  });
});

describe("isPrivateAddress", () => {
  it.each([
    "http://localhost:11434/v1",
    "http://127.0.0.1",
    "http://127.8.9.10:8000",
    "http://[::1]:8000",
    "http://10.0.0.5",
    "http://172.20.1.1",
    "http://192.168.1.2",
    "http://box.local",
    "http://LOCALHOST",
  ])("%s is private", (url) => expect(isPrivateAddress(url)).toBe(true));

  it.each(["https://api.together.xyz/v1", "http://172.32.0.1", "http://11.0.0.1", "https://localhost.example.com"])("%s is public", (url) =>
    expect(isPrivateAddress(url)).toBe(false),
  );
});

// Compile-time check: Role is the union of role names.
const _role: Role = "judge";
void _role;
