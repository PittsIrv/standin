import { describe, expect, it } from "vitest";
import {
  ALLOWED_TRANSITIONS,
  Memory,
  ObservationInput,
  TERMINAL_STATUSES,
  isId,
  newId,
  isMostlyLatin,
  parseConfig,
} from "../src/index.ts";

const baseMemory = {
  id: "mem_0123456789ab",
  kind: "fact",
  statement: "I interned at a data team in summer 2025.",
  tier: 1,
  status: "proposed",
  validFrom: null,
  validUntil: null,
  isCurrentState: false,
  affirmed: false,
  supersedesId: null,
  conflictsWithId: null,
  recordedAt: "2026-10-01T00:00:00.000Z",
  decidedAt: null,
  lastCorroboratedAt: "2026-10-01T00:00:00.000Z",
  attrs: {},
};

describe("ids", () => {
  it("formats ids as prefix + 12 hex chars", () => {
    const id = newId("mem");
    expect(id).toMatch(/^mem_[0-9a-f]{12}$/);
    expect(isId("mem", id)).toBe(true);
    expect(isId("obs", id)).toBe(false);
  });

  it("generates distinct ids", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId("obs")));
    expect(ids.size).toBe(1000);
  });
});

describe("Memory", () => {
  it("accepts a valid fact", () => {
    expect(Memory.parse(baseMemory).kind).toBe("fact");
  });

  it("rejects tier 5", () => {
    expect(() => Memory.parse({ ...baseMemory, tier: 5 })).toThrow();
  });

  it("rejects competence depth outside 0..4", () => {
    expect(() =>
      Memory.parse({ ...baseMemory, kind: "competence", attrs: { domain: "game theory", depth: 7 } }),
    ).toThrow();
    expect(
      Memory.parse({ ...baseMemory, kind: "competence", attrs: { domain: "game theory", depth: 4 } }).attrs,
    ).toEqual({ domain: "game theory", depth: 4 });
  });

  it("requires a topic on stance attrs", () => {
    expect(() => Memory.parse({ ...baseMemory, kind: "stance", attrs: { strength: 3 } })).toThrow();
  });
});

describe("ObservationInput", () => {
  it("rejects whitespace-only text", () => {
    expect(() =>
      ObservationInput.parse({
        sourceKind: "manual",
        sourceRef: "cli",
        authorRole: "self",
        text: "   \n\t ",
        occurredAt: "2026-10-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("defaults meta to an empty object", () => {
    const o = ObservationInput.parse({
      sourceKind: "interview",
      sourceRef: "interview-01",
      authorRole: "self",
      text: "I like poker.",
      occurredAt: "2026-10-01T00:00:00.000Z",
    });
    expect(o.meta).toEqual({});
  });

  it("rejects mostly non-Latin text with the English-only message", () => {
    const r = ObservationInput.safeParse({
      sourceKind: "manual",
      sourceRef: "cli",
      authorRole: "self",
      text: "我从小跟外公下围棋，所以后来做游戏AI一点也不意外。",
      occurredAt: "2026-10-01T00:00:00.000Z",
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe("standin is English-only for now");
  });
});

describe("isMostlyLatin", () => {
  it("accepts English with a few non-Latin words", () => {
    expect(isMostlyLatin("I learned Go (围棋) from my grandfather")).toBe(true);
  });
  it("rejects a mostly Chinese sentence", () => {
    expect(isMostlyLatin("我从小跟外公下围棋，所以后来做游戏AI一点也不意外。")).toBe(false);
  });
  it("accepts text with no letters", () => {
    expect(isMostlyLatin("12345 🎲")).toBe(true);
  });
});

describe("config", () => {
  it("fills every default", () => {
    const c = parseConfig({ persona: { name: "X" } });
    expect(c).toEqual({
      persona: { name: "X" },
      compaction: { batchSize: 20 },
      models: {
        tiers: {
          small: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
          medium: { provider: "anthropic", model: "claude-sonnet-5-5" },
          large: { provider: "anthropic", model: "claude-opus-5-5" },
        },
        roles: {},
        prices: {},
      },
      tracing: {},
      consolidation: { freshnessDays: 120 },
    });
  });

  it("ignores keys from configs written before the simplification", () => {
    const c = parseConfig({
      persona: { name: "X", languages: ["en", "zh"] },
      consolidation: { retentionDays: 90, freshnessDays: 120, currentStateHalfLifeDays: 90 },
      review: { weeklyCap: 25 },
    });
    expect(c.persona).toEqual({ name: "X" });
    expect(c.consolidation).toEqual({ freshnessDays: 120 });
    expect(c.consolidation.purgeAfterDays).toBeUndefined();
    expect("review" in c).toBe(false);
  });
});

describe("lifecycle tables", () => {
  it("only lets proposed memories be approved or rejected", () => {
    expect(ALLOWED_TRANSITIONS.proposed).toEqual(["approved", "rejected"]);
    expect(ALLOWED_TRANSITIONS.approved).toEqual(["superseded", "expired", "retracted"]);
    for (const s of TERMINAL_STATUSES) expect(ALLOWED_TRANSITIONS[s]).toEqual([]);
  });
});
