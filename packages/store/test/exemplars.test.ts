import { describe, expect, it } from "vitest";
import { InvalidTransitionError } from "../src/index.ts";
import { obs, tempStore } from "./helpers.ts";

describe("exemplars", () => {
  it("dedupes by normalized content, including against rejected ones", () => {
    const { store } = tempStore();
    const o = store.addObservation(obs());
    const a = store.insertExemplar({ observationId: o.id, text: "lol that hand was brutal", lang: "en", register: "casual" });
    expect(a?.status).toBe("proposed");
    expect(store.insertExemplar({ observationId: o.id, text: " lol  that hand was brutal ", lang: "en", register: "casual" })).toBeNull();
    store.rejectExemplar(a!.id);
    expect(store.insertExemplar({ observationId: o.id, text: "lol that hand was brutal", lang: "en", register: "casual" })).toBeNull();
  });

  it("approves and lists by status", () => {
    const { store } = tempStore();
    const o = store.addObservation(obs());
    const a = store.insertExemplar({ observationId: o.id, text: "说实话我也不太确定", lang: "zh", register: "casual" })!;
    store.approveExemplar(a.id);
    expect(store.listExemplars({ status: "approved" }).map((e) => e.id)).toEqual([a.id]);
    expect(() => store.approveExemplar(a.id)).toThrow(InvalidTransitionError);
  });
});
