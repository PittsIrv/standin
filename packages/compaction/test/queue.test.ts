import { describe, expect, it } from "vitest";
import { buildExtractionPrompt, reviewQueue } from "../src/index.ts";
import { config, FakeClock, obs, tempStore } from "./helpers.ts";

function setup() {
  const { store, clock } = tempStore();
  const seed = (text: string) => store.addObservation(obs(text)).id;
  const ins = (statement: string, extra: Record<string, unknown> = {}, sources = [seed(`obs: ${statement}`)]) =>
    store.insertMemory(
      { kind: "fact", statement, tier: 1, isCurrentState: false, attrs: {}, ...extra } as never,
      { sourceObservationIds: sources, entityIds: [], actor: "compaction" },
    );
  return { store, clock: clock as FakeClock, seed, ins };
}

describe("reviewQueue", () => {
  it("orders contradictions, still-true cards, updates, then new; more sources first, then oldest", () => {
    const { store, clock, seed, ins } = setup();
    const reading = ins("I'm currently reading Solaris.", { isCurrentState: true });
    store.approve(reading.id);
    const base = ins("I live in Pittsburgh.");
    store.approve(base.id);
    const city = ins("I mostly code in Python.");
    store.approve(city.id);
    clock.current = new Date(clock.current.getTime() + 121 * 86_400_000);

    const newOne = ins("I like poker.");
    const newTwo = ins("I like chess.", {}, [seed("chess a"), seed("chess b")]);
    const update = ins("I mostly code in Rust.", { supersedesId: city.id });
    const conflict = ins("I live in Boston.", { conflictsWithId: base.id });
    const newOlder = ins("I like Go.");

    const items = reviewQueue(store, config);
    expect(items.map((i) => [i.group, i.memory.id])).toEqual([
      ["contradiction", conflict.id],
      ["still-true", reading.id],
      ["update", update.id],
      ["new", newTwo.id],
      ["new", newOne.id],
      ["new", newOlder.id],
    ]);
    expect(items[0]!.kind).toBe("memory");
    expect(items[1]!.kind).toBe("still-true");
    expect(items[3]!.sources.distinct).toBe(2);
  });

  it("shows a stale memory with a pending update only as the update", () => {
    const { store, clock, ins } = setup();
    const reading = ins("I'm currently reading Solaris.", { isCurrentState: true });
    store.approve(reading.id);
    clock.current = new Date(clock.current.getTime() + 121 * 86_400_000);
    const update = ins("I'm currently reading Dune.", { isCurrentState: true, supersedesId: reading.id });
    expect(reviewQueue(store, config).map((i) => [i.group, i.memory.id])).toEqual([["update", update.id]]);
  });
});

describe("extraction prompt", () => {
  it("asks for English memories", () => {
    const { store } = tempStore();
    const o = store.addObservation(obs("I like poker."));
    const { system, prompt } = buildExtractionPrompt(o, "Lin Qiao");
    expect(system).toContain("in English");
    expect(system).not.toContain("language of the source text");
    expect(prompt).not.toContain("language:");
  });
});
