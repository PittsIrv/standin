import { describe, expect, it } from "vitest";
import { obs, tempStore } from "./helpers.ts";

describe("observations", () => {
  it("is idempotent on identical content", () => {
    const { store } = tempStore();
    const a = store.addObservation(obs());
    const b = store.addObservation(obs({ sourceRef: "other-ref", text: "  I build   board-game AIs. " }));
    expect(b.id).toBe(a.id);
    expect(a.id).toMatch(/^obs_[0-9a-f]{12}$/);
  });

  it("rejects whitespace-only text", () => {
    const { store } = tempStore();
    expect(() => store.addObservation(obs({ text: "  \n " }))).toThrow();
  });

  it("stamps ingestedAt from the clock", () => {
    const { store, clock } = tempStore();
    const o = store.addObservation(obs());
    expect(o.ingestedAt).toBe(clock.now().toISOString());
    expect(o.compactedAt).toBeNull();
  });

  it("lists uncompacted observations oldest first and supports retrying failures", () => {
    const { store } = tempStore();
    const late = store.addObservation(obs({ text: "late", occurredAt: "2026-09-10T00:00:00.000Z" }));
    const early = store.addObservation(obs({ text: "early", occurredAt: "2026-09-01T00:00:00.000Z" }));
    expect(store.uncompactedObservations(10).map((o) => o.id)).toEqual([early.id, late.id]);

    store.markCompacted(early.id, "processed");
    store.markCompacted(late.id, "failed");
    expect(store.uncompactedObservations(10)).toEqual([]);
    expect(store.uncompactedObservations(10, { retryFailed: true }).map((o) => o.id)).toEqual([late.id]);
  });

  it("persists across reopen", async () => {
    const { store, path, clock } = tempStore();
    const o = store.addObservation(obs({ lang: "zh", text: "我喜欢扑克。", meta: { channel: "poker" } }));
    store.close();
    const { openStore } = await import("../src/index.ts");
    const again = openStore({ path, clock });
    expect(again.getObservation(o.id)).toEqual(o);
  });
});

describe("entities", () => {
  it("resolves case- and width-insensitively within a kind", () => {
    const { store } = tempStore();
    const a = store.resolveEntity({ name: "Dealer's Choice", kind: "project" });
    const b = store.resolveEntity({ name: "dealers choice", kind: "project" });
    const c = store.resolveEntity({ name: "Dealer's Choice", kind: "org" });
    expect(b.id).toBe(a.id);
    expect(c.id).not.toBe(a.id);
  });

  it("matches on aliases", () => {
    const { store } = tempStore();
    const a = store.resolveEntity({ name: "Carnegie Mellon University", kind: "org", aliases: ["CMU", "卡内基梅隆"] });
    expect(store.resolveEntity({ name: "cmu", kind: "org" }).id).toBe(a.id);
    expect(store.resolveEntity({ name: "卡内基梅隆", kind: "org" }).id).toBe(a.id);
  });
});
