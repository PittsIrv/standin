import { describe, expect, it } from "vitest";
import { served } from "./helpers.ts";

const decisions = (w: { store: { db: { prepare: (s: string) => { all: () => unknown[] } } } }) =>
  w.store.db.prepare("SELECT item_id, item_kind, queue_group AS grp, position, decision FROM queue_decisions ORDER BY rowid").all() as Record<string, unknown>[];

describe("concept cards over HTTP", () => {
  it("opens with the introduction, reads it, stores what you confirm, then asks its guesses", async () => {
    const { w, server, api } = await served({ intro: true });
    expect((await api("/api/card")).json!.card).toEqual({ type: "intro" });
    expect((await api("/api/intro/read", { text: "" })).status).toBe(400);
    const read = await api("/api/intro/read", { text: "I research robotics. I have two cats." });
    expect(read.json!.statements).toEqual(["I research robotics.", "I have two cats."]);
    expect(w.store.listMemories({})).toEqual([]);
    const done = await api("/api/intro/confirm", { text: "I research robotics. I have two cats.", statements: ["I research robot learning.", ""] });
    expect(done.json).toEqual({ saved: 1, dropped: [] });
    expect(w.store.listMemories({ status: "approved" }).map((m) => m.statement)).toEqual(["I research robot learning."]);
    expect((await api("/api/card")).json!.card).toMatchObject({ type: "card", card: { reason: "guess", topic: "F", why: "your introduction says so" } });
    await server.finish();
  });

  it("skips the introduction for good when asked", async () => {
    const { w, server, api } = await served({ intro: true });
    expect((await api("/api/intro/skip", {})).status).toBe(200);
    expect((await api("/api/card")).json!.card).toEqual({ type: "done" });
    expect(w.store.getKv("intro.skipped")).not.toBeNull();
    await server.finish();
  });

  it("shows the same card on reload, and refuses a second answer", async () => {
    const { server, api } = await served({ setup: (w) => w.guess("Algorithms", 2) });
    const a = await api("/api/card");
    const b = await api("/api/card");
    expect(a.json!.card).toMatchObject({ type: "card", card: { reason: "guess", topic: "Algorithms" } });
    expect(b.json!.card.card.responseId).toBe(a.json!.card.card.responseId);
    const id = a.json!.card.card.responseId;
    expect((await api("/api/answer", { responseId: id, answer: 4 })).status).toBe(200);
    expect((await api("/api/answer", { responseId: id, answer: 1 })).status).toBe(409);
    expect((await api("/api/answer", { responseId: id, answer: 7 })).status).toBe(400);
    await server.finish();
  });

  it("walks a guess, its parts, skips the rest, then the queue, then done", async () => {
    const { w, server, api } = await served({
      setup: (w) => {
        w.guess("Algorithms", 2);
        const o = w.store.addObservation({ sourceKind: "interview", sourceRef: "q", authorRole: "self", text: "cats", occurredAt: "2026-09-01T00:00:00.000Z" });
        w.store.insertMemory({ kind: "fact", statement: "I have two cats.", tier: 1, isCurrentState: false, attrs: {} }, { sourceObservationIds: [o.id], entityIds: [], actor: "compaction" });
      },
    });
    const card = async () => (await api("/api/card")).json!.card;
    let c = await card();
    await api("/api/answer", { responseId: c.card.responseId, answer: 2 });
    c = await card();
    expect(c.card).toMatchObject({ reason: "part", parent: "Algorithms", topic: "Algorithms one" });
    await api("/api/answer", { responseId: c.card.responseId, answer: 0 });
    c = await card();
    expect(c.card.topic).toBe("Algorithms three");
    expect((await api("/api/skip", { parentId: c.card.parentId })).status).toBe(200);
    await api("/api/answer", { responseId: c.card.responseId, answer: 4 });
    c = await card();
    expect(c).toMatchObject({ type: "proposal", item: { statement: "I have two cats." } });
    await api("/api/decide", { id: c.item.id, decision: "approve" });
    expect(decisions(w as never)).toEqual([expect.objectContaining({ item_kind: "memory", grp: "new", decision: "approve" })]);
    expect((await card()).type).toBe("done");
    await server.finish();
  });

  it("offers keep or lower after a claim's parts are rated below it", async () => {
    const { server, api } = await served({ setup: (w) => w.claim("Rust", 2) });
    const levels: Record<string, number> = { "Rust one": 0, "Rust three": 4, "Rust two": 4 };
    let c = (await api("/api/card")).json!.card;
    while (c.type === "card") {
      await api("/api/answer", { responseId: c.card.responseId, answer: levels[c.card.topic] });
      c = (await api("/api/card")).json!.card;
    }
    expect(c).toMatchObject({ type: "keep-lower", decision: { topic: "Rust", claimed: 2 } });
    await api("/api/claim", { claimNodeId: c.decision.claimNodeId, choice: "keep" });
    expect((await api("/api/card")).json!.card.type).toBe("done");
    await server.finish();
  });
});
