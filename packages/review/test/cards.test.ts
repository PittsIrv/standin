import { describe, expect, it } from "vitest";
import { served } from "./helpers.ts";

const decisions = (w: { store: { db: { prepare: (s: string) => { all: () => unknown[] } } } }) =>
  w.store.db.prepare("SELECT item_id, item_kind, queue_group AS grp, position, decision FROM queue_decisions ORDER BY rowid").all() as Record<string, unknown>[];

describe("concept cards over HTTP", () => {
  it("opens with the introduction, reads it, stores what you confirm, then asks its guesses", async () => {
    const { w, server, api } = await served({ intro: true });
    expect((await api("/api/card")).json!.card).toEqual({ type: "intro" });
    expect((await api("/api/intro/text", { text: "" })).status).toBe(400);
    const src = (await api("/api/intro/text", { text: "I research robotics. Email me at me@example.com." })).json!;
    expect(src).toMatchObject({ kind: "intro", ref: "your introduction", contactsRemoved: 1 });
    const read = (await api("/api/intro/read", {})).json!;
    expect(read.groups[0].statements.map((s: { statement: string }) => s.statement)).toEqual(["I research robotics."]);
    expect(read.contacts).toBe(1);
    expect(w.store.listMemories({})).toEqual([]);
    const edited = { ...read.groups[0].statements[0], statement: "I research robot learning." };
    expect((await api("/api/intro/confirm", { statements: [edited] })).json).toEqual({ saved: 1, dropped: [] });
    expect(w.store.listMemories({ status: "approved" }).map((m) => [m.statement, m.attrs])).toEqual([
      ["I research robot learning.", { background: true, kind: "occupation", quote: "I research robotics." }],
    ]);
    expect((await api("/api/intro/sources")).json!.sources).toEqual([]);
    expect((await api("/api/card")).json!.card).toMatchObject({ type: "card", card: { reason: "guess", topic: "F", why: "your introduction says so" } });
    await server.finish();
  });

  it("shows at most 40 statements across all sources, and says how many more there were", async () => {
    const { server, api } = await served({ intro: true });
    const lines = Array.from({ length: 30 }, (_, i) => `I worked on project number ${i}.`);
    await api("/api/intro/text", { text: lines.join(" ") });
    await api("/api/intro/text", { text: lines.map((l) => l.replace("project", "paper")).join(" ") });
    const read = (await api("/api/intro/read", {})).json!;
    expect(read.groups.map((g: { statements: unknown[] }) => g.statements.length)).toEqual([30, 10]);
    expect(read.overLimit).toBe(20);
    await server.finish();
  });

  it("reads uploaded files, and refuses ones it can't read or that are too large", async () => {
    const { server, api } = await served({ intro: true });
    const b64 = (s: string) => Buffer.from(s).toString("base64");
    expect((await api("/api/intro/file", { name: "cv.md", data: b64("# CV\nI build robots.") })).json).toMatchObject({ kind: "file", ref: "cv.md" });
    const png = await api("/api/intro/file", { name: "me.png", data: b64("x") });
    expect([png.status, png.json!.error]).toEqual([422, "me.png: only PDF, Word (.docx), Markdown and plain-text files can be read."]);
    expect((await api("/api/intro/file", { name: "big.txt", data: "A".repeat(15 * 1024 * 1024) })).status).toBe(413);
    expect((await api("/api/intro/text", { text: "A".repeat(70_000) })).status).toBe(413);
    await server.finish();
  });

  it("joins lines a file broke mid-sentence, so the model reads (and the standin keeps) whole sentences", async () => {
    const { w, server, api } = await served({ intro: true });
    await api("/api/intro/file", { name: "cv.txt", data: Buffer.from("I built tools to analyze bias in\nAI-generated images. I led a\nteam of four.").toString("base64") });
    const read = (await api("/api/intro/read", {})).json!;
    await api("/api/intro/confirm", { statements: read.groups[0].statements });
    expect(w.store.db.prepare("SELECT text FROM observations WHERE source_kind = 'file'").get()).toEqual({ text: "I built tools to analyze bias in AI-generated images. I led a team of four." });
    await server.finish();
  });

  it("reads your website, then only the same-site pages you pick", async () => {
    const pages: Record<string, string> = {
      "https://lin.example/": `<html><head><title>Lin</title></head><body><article><p>I build AIs for board games.</p></article><a href="/about">About</a><a href="https://elsewhere.example/">x</a></body></html>`,
      "https://lin.example/about": `<html><head><title>About</title></head><body><article><p>I studied computer science.</p></article></body></html>`,
    };
    const fetchOptions = {
      fetch: async (url: string) => (pages[url] ? new Response(pages[url], { headers: { "content-type": "text/html" } }) : new Response("", { status: 404 })),
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    };
    const { server, api } = await served({ intro: true, fetchOptions });
    const site = (await api("/api/intro/site", { url: "lin.example" })).json!;
    expect(site.source).toMatchObject({ kind: "website", ref: "https://lin.example/" });
    expect(site.links).toEqual([{ url: "https://lin.example/about", title: "About" }]);
    expect((await api("/api/intro/pages", { urls: ["https://elsewhere.example/"] })).status).toBe(422);
    expect((await api("/api/intro/pages", { urls: ["not a url"] })).status).toBe(422);
    expect((await api("/api/intro/pages", { urls: ["https://lin.example/about"] })).json!.sources).toHaveLength(1);
    const read = (await api("/api/intro/read", {})).json!;
    expect(read.groups.map((g: { ref: string }) => g.ref)).toEqual(["https://lin.example/", "https://lin.example/about"]);
    expect((await api("/api/intro/site", { url: "http://lin.example/" })).status).toBe(422);
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

describe("questions over HTTP", () => {
  it("asks an open question once the knowledge cards run out, reads the answer, and stores what you confirm", async () => {
    let qid = "";
    const { w, server, api } = await served({
      setup: (w) => {
        const pets = w.store.ensureNode("Pets", "pet");
        w.store.addEdge({ from: pets.id, to: w.store.root("life").id, kind: "part_of", source: "placement" });
        qid = w.store.addQuestion({ nodeId: pets.id, text: "What are your cats' names?" }).id;
      },
    });
    expect((await api("/api/card")).json!.card).toEqual({ type: "question", question: { questionId: qid, text: "What are your cats' names?", node: "Pets", path: ["Life"] } });
    expect((await api("/api/question/read", { questionId: qid, text: "" })).status).toBe(400);
    const read = (await api("/api/question/read", { questionId: qid, text: "They are Miso and Tofu." })).json!;
    expect(read.statements.map((s: { statement: string }) => s.statement)).toEqual(["They are Miso and Tofu."]);
    expect((await api("/api/question/confirm", { questionId: qid, statements: read.statements })).json).toEqual({ saved: 1, dropped: [] });
    expect(w.store.getQuestion(qid).status).toBe("answered");
    expect((await api("/api/card")).json!.card).toEqual({ type: "done" });
    await server.finish();
  });

  it("puts a question off for the session, or dismisses it for good", async () => {
    const ids: string[] = [];
    const { w, server, api } = await served({
      setup: (w) => {
        for (const name of ["Pets", "Kite"]) {
          const n = w.store.ensureNode(name, name === "Pets" ? "pet" : "project");
          w.store.addEdge({ from: n.id, to: w.store.root(name === "Pets" ? "life" : "work").id, kind: "part_of", source: "placement" });
          ids.push(w.store.addQuestion({ nodeId: n.id, text: `About ${name}?` }).id);
        }
      },
    });
    await api("/api/question/skip", { questionId: ids[0] });
    expect((await api("/api/card")).json!.card.question.questionId).toBe(ids[1]);
    await api("/api/question/dismiss", { questionId: ids[1] });
    expect((await api("/api/card")).json!.card).toEqual({ type: "done" });
    expect(w.store.listQuestions({}).map((q) => q.status)).toEqual(["open", "dismissed"]);
    await server.finish();
  });
});
