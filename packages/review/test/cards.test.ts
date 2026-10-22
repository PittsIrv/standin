import { describe, expect, it } from "vitest";
import { queued } from "../../knowledge/test/session-helpers.ts";
import { served } from "./helpers.ts";

const decisions = (w: { store: { db: { prepare: (s: string) => { all: () => unknown[] } } } }) =>
  w.store.db.prepare("SELECT item_id, item_kind, queue_group AS grp, position, decision FROM queue_decisions ORDER BY rowid").all() as Record<string, unknown>[];

describe("session cards", () => {
  it("shows the same probe on reload, and refuses a second rating", async () => {
    const { server, api } = await served({ setup: (w) => w.claim("Rust", 3) });
    const a = await api("/api/card");
    const b = await api("/api/card");
    expect(a.json!.card.type).toBe("probe");
    expect(b.json!.card.probe.responseId).toBe(a.json!.card.probe.responseId);
    const id = a.json!.card.probe.responseId;
    expect((await api("/api/rate", { responseId: id, rating: "know" })).status).toBe(200);
    const again = await api("/api/rate", { responseId: id, rating: "no_idea" });
    expect(again.status).toBe(409);
    await server.finish();
  });

  it("walks the fixed order: spot-check, miss, follow-up, keep or lower, the queue, done", async () => {
    // Probe 1: not held out, then a spot-check. Everything after: not held out, no spot-check.
    const { w, server, api } = await served({
      rng: queued([0.99, 0.0]),
      setup: (w) => {
        w.claim("Rust", 2);
        const o = w.store.addObservation({ sourceKind: "interview", sourceRef: "q", authorRole: "self", text: "cats", occurredAt: "2026-09-01T00:00:00.000Z" });
        w.store.insertMemory({ kind: "fact", statement: "I have two cats.", tier: 1, isCurrentState: false, attrs: {} }, { sourceObservationIds: [o.id], entityIds: [], actor: "compaction" });
      },
    });
    const card = async () => (await api("/api/card")).json!.card;

    let c = await card();
    expect(c.type).toBe("probe");
    expect((await api("/api/rate", { responseId: c.probe.responseId, rating: "know" })).json).toEqual({ spotCheck: true });
    c = await card();
    expect(c).toMatchObject({ type: "spot-check", check: { question: expect.any(String) } });
    await api("/api/answer", { responseId: c.check.responseId, text: "Ownership moves values between owners." });

    c = await card();
    expect(c.type).toBe("probe");
    await api("/api/rate", { responseId: c.probe.responseId, rating: "no_idea" });
    c = await card();
    expect(c).toMatchObject({ type: "miss", miss: { reason: "no_idea" } });
    await api("/api/judge", { responseId: c.miss.responseId, gap: true });

    c = await card();
    expect(c).toMatchObject({ type: "probe", probe: { kind: "followup", difficulty: 1 } });
    await api("/api/rate", { responseId: c.probe.responseId, rating: "know" });
    c = await card();
    expect(c).toMatchObject({ type: "claim", decision: { claimed: 2 } });
    await api("/api/claim", { claimNodeId: c.decision.claimNodeId, choice: "lower" });

    c = await card();
    expect(c).toMatchObject({ type: "proposal", item: { statement: "I have two cats.", stillTrue: false, group: "new" } });
    const approved = await api("/api/decide", { id: c.item.id, decision: "approve", statement: "I have two cats, Miso and Tofu." });
    expect(approved.json).toMatchObject({ status: "approved", statement: "I have two cats, Miso and Tofu." });
    expect(decisions(w as never)).toEqual([expect.objectContaining({ item_id: c.item.id, item_kind: "memory", grp: "new", position: 0, decision: "approve" })]);

    expect((await card()).type).toBe("done");
    await server.finish();
  });

  it("rejects proposals and expires still-true memories through decide, logging both", async () => {
    const { w, server, api, base } = await served({
      setup: (w) => {
        const o = w.store.addObservation({ sourceKind: "interview", sourceRef: "q", authorRole: "self", text: "x", occurredAt: "2026-09-01T00:00:00.000Z" });
        const job = w.store.insertMemory({ kind: "fact", statement: "I currently work at a lab.", tier: 1, isCurrentState: true, attrs: {} }, { sourceObservationIds: [o.id], entityIds: [], actor: "compaction" });
        w.store.approve(job.id);
        w.clock.tick(200 * 86_400);
        w.store.insertMemory({ kind: "fact", statement: "I like jazz.", tier: 1, isCurrentState: false, attrs: {} }, { sourceObservationIds: [o.id], entityIds: [], actor: "compaction" });
      },
    });
    expect(base).toBeTruthy();
    const still = (await api("/api/card")).json!.card;
    expect(still).toMatchObject({ type: "proposal", item: { stillTrue: true } });
    expect((await api("/api/decide", { id: still.item.id, decision: "expire" })).json).toMatchObject({ status: "expired" });
    const fresh = (await api("/api/card")).json!.card;
    expect((await api("/api/decide", { id: fresh.item.id, decision: "reject" })).json).toMatchObject({ status: "rejected" });
    expect(decisions(w as never).map((d) => [d.item_kind, d.decision])).toEqual([
      ["still-true", "expire"],
      ["memory", "reject"],
    ]);
    await server.finish();
  });
});
