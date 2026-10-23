import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedLLM, type GenerateObjectRequest } from "@standin/llm";
import { readCurrent } from "@standin/publish";
import type { Store } from "@standin/store";
import { describe, expect, it } from "vitest";
import { served } from "./helpers.ts";

/** Flags any item mentioning a physio. */
const screen = () =>
  new ScriptedLLM((req: GenerateObjectRequest<unknown>) => ({
    flags: req.prompt.split("\n").flatMap((l, i) => (/physio/.test(l) ? [{ item: i + 1, reason: "health: a treatment" }] : [])),
  }));

function fact(store: Store, nodeName: string, root: "life" | "work", statement: string) {
  const n = store.ensureNode(nodeName, "topic");
  store.addEdge({ from: n.id, to: store.root(root).id, kind: "part_of", source: "placement" });
  const o = store.addObservation({ sourceKind: "manual", sourceRef: "t", authorRole: "self", text: statement, occurredAt: "2026-09-01T00:00:00.000Z" });
  const m = store.insertMemory({ kind: "fact", statement, tier: 1, isCurrentState: false, attrs: {} } as never, { sourceObservationIds: [o.id], entityIds: [n.id], actor: "compaction", homeNodeId: n.id });
  store.approve(m.id);
  return m;
}

async function publishing() {
  const dir = join(mkdtempSync(join(tmpdir(), "standin-pubtab-")), "published");
  const s = await served({
    setup: (w) => {
      fact(w.store, "Pets", "life", "I have two cats.");
      fact(w.store, "Routines", "life", "I see a physio every week.");
    },
    extra: (w) => ({ publish: { store: w.store, dir, screen: screen(), personaName: "Lin", speakAt: 0.8, batch: 20 } }),
  });
  return { ...s, dir };
}

describe("the Publish tab (publish spec §4)", () => {
  it("shows what would change and what is held, then publishes version 1 without the held item", async () => {
    const { server, api, dir } = await publishing();
    const r = await api("/api/publish");
    expect(r.status).toBe(200);
    expect(r.json!.current).toBeNull();
    expect(r.json!.findings).toEqual([]);
    expect(r.json!.held).toEqual([expect.objectContaining({ kind: "memory", label: "I see a physio every week.", reason: "health: a treatment" })]);
    expect(r.json!.changes.map((c: { label: string }) => c.label)).toContain("I have two cats.");
    expect(r.json!).not.toHaveProperty("bundle");
    const p = await api("/api/publish", {});
    expect(p.json).toMatchObject({ version: 1, counts: { memories: 1 } });
    expect(JSON.stringify(readCurrent(dir))).not.toMatch(/physio/);
    expect((await api("/api/publish")).json!.versions).toEqual([expect.objectContaining({ version: 1, memories: 1 })]);
    await server.finish();
  });

  it("Keep lets a held item through; Hide re-tiers it", async () => {
    const { server, api, w } = await publishing();
    const { held } = (await api("/api/publish")).json!;
    expect((await api("/api/publish/decide", { key: held[0].key, decision: "hide" })).status).toBe(200);
    expect(w.store.getMemory(held[0].id).tier).toBe(3);
    expect((await api("/api/publish")).json!.held).toEqual([]);
    expect((await api("/api/publish/decide", { key: "memory:../../etc", decision: "keep" })).status).toBe(400);
    await server.finish();
  });

  it("previews a rollback, then saves it as a new version; an unknown version is 404", async () => {
    const { server, api } = await publishing();
    await api("/api/publish", {});
    await api("/api/publish", {});
    const preview = await api("/api/publish/rollback/1");
    expect(preview.json).toMatchObject({ current: { version: 2 }, findings: [] });
    expect((await api("/api/publish/rollback", { version: 1 })).json).toMatchObject({ version: 3 });
    expect((await api("/api/publish/rollback/9")).status).toBe(404);
    await server.finish();
  });

  it("is unavailable without publishing set up", async () => {
    const { server, api } = await served();
    expect((await api("/api/publish")).status).toBe(409);
    await server.finish();
  });
});
