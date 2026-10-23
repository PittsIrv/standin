import { describe, expect, it } from "vitest";
import { served } from "./helpers.ts";

// Built at run time so no key-shaped string sits in the repo.
const TOKEN = "ghp_" + "aB3kQ9zX7mW2pL5vR8tY4nC6aB3kQ9zX7mW2".slice(0, 36);

describe("the personal-data guard on the review page", () => {
  it("checks a draft without storing anything: secrets with where they are, contacts as notes", async () => {
    const { w, server, api } = await served();
    const rows = () => w.store.db.prepare("SELECT (SELECT COUNT(*) FROM observations) + (SELECT COUNT(*) FROM spans) AS n").get();
    const before = rows();
    const text = `I'm Lin.\nmy token is ${TOKEN}, mail lin@example.edu`;
    const r = await api("/api/check", { text });
    expect(r.status).toBe(200);
    expect(r.json!.findings).toEqual([
      { label: "GitHub token", kind: "secret", line: 2, column: 13, context: "Lin. my token is •••, mail •••", start: 21, end: 61 },
      { label: "email address", kind: "contact", line: 2, column: 60, context: "token is •••, mail •••", start: 68, end: 83 },
    ]);
    expect(JSON.stringify(r.json)).not.toContain(TOKEN);
    expect((await api("/api/check", { text: "I study at CMU." })).json).toEqual({ findings: [] });
    expect(rows()).toEqual(before);
    await server.finish();
  });

  it("refuses typed text with a secret with 422 and the findings, on every way in", async () => {
    const { w, server, api } = await served();
    const node = w.store.ensureNode("Tools", "topic");
    for (const [path, body] of [
      ["/api/intro/text", { text: `token ${TOKEN}` }],
      ["/api/tree/rename", { nodeId: node.id, name: `Tools ${TOKEN}` }],
      ["/api/tree/add", { parentId: node.id, name: `Keys ${TOKEN}`, label: "topic" }],
    ] as const) {
      const r = await api(path, body);
      expect([path, r.status]).toEqual([path, 422]);
      expect(r.json!.error).toContain("GitHub token");
      expect(r.json!.findings).toEqual([expect.objectContaining({ label: "GitHub token", kind: "secret" })]);
      expect(JSON.stringify(r.json)).not.toContain(TOKEN.slice(4));
    }
    await server.finish();
  });

  it("refuses a secret in an Ask question or a quiz answer before any model call", async () => {
    const calls: string[] = [];
    const { server, api } = await served({
      extra: (w) => ({
        turn: { bundle: null as never, answer: { generateObject: async () => { calls.push("model"); throw new Error("no"); } } as never, check: null as never, tracer: null as never, limits: null as never },
        quiz: { answer: async () => { calls.push("quiz"); throw new Error("no"); }, agreement: () => ({}), left: () => 0 } as never,
      }),
    });
    expect((await api("/api/ask", { question: `is my key ${TOKEN} safe?` })).status).toBe(422);
    expect((await api("/api/quiz/answer", { caseId: "known:a", answer: `password: Hunter2!` })).status).toBe(422);
    expect(calls).toEqual([]);
    await server.finish();
  });
});
