import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@standin/store";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/main.ts";

function harness() {
  const home = join(mkdtempSync(join(tmpdir(), "standin-cli-")), "home");
  const out: string[] = [];
  const err: string[] = [];
  let interrupt: (() => void) | null = null;
  const run = (...argv: string[]) =>
    runCli(argv, {
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      env: { STANDIN_HOME: home },
      sleep: async () => {},
      onInterrupt: (h) => {
        interrupt = h;
        return () => (interrupt = null);
      },
    });
  const claim = () => {
    const store = openStore({ path: join(home, "standin.db") });
    const o = store.addObservation({ sourceKind: "interview", sourceRef: "i", authorRole: "self", text: "rust", occurredAt: "2026-09-01T00:00:00.000Z" });
    const m = store.insertMemory(
      { kind: "competence", statement: "I know Rust well.", tier: 1, isCurrentState: false, attrs: { domain: "Rust", depth: 3 } },
      { sourceObservationIds: [o.id], entityIds: [store.ensureTopic("Rust").id], actor: "compaction" },
    );
    store.approve(m.id);
    store.close();
  };
  const pageUrl = async () => {
    await vi.waitFor(() => expect(out.join("\n")).toMatch(/Review page: http/), { timeout: 5000 });
    return new URL(/Review page: (\S+)/.exec(out.join("\n"))![1]!);
  };
  return { home, out, err, run, claim, pageUrl, interrupt: () => interrupt?.() };
}

const call = async (url: URL, path: string, body?: unknown) => {
  const res = await fetch(new URL(path, url.origin), {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-Standin-Token": url.searchParams.get("t")!, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await res.json()) as Record<string, any>;
};

describe("standin review", () => {
  it("runs a session in the page and finishes from it", async () => {
    const h = harness();
    await h.run("init", "--name", "T");
    h.claim();
    const done = h.run("review", "--demo-llm", "--port", "0");
    const url = await h.pageUrl();
    expect(url.hostname).toBe("127.0.0.1");
    expect((await call(url, "/api/card")).card.type).toBe("intro");
    await call(url, "/api/intro/text", { text: "I build AIs for board games. I have two cats." });
    const { groups } = await call(url, "/api/intro/read", {});
    expect(groups[0].statements.map((s: { statement: string; kind: string }) => [s.statement, s.kind])).toEqual([
      ["I build AIs for board games.", "project"],
      ["I have two cats.", "relationship"],
    ]);
    expect(await call(url, "/api/intro/confirm", { statements: groups[0].statements })).toEqual({ saved: 2, dropped: [] });
    const { card } = await call(url, "/api/card");
    expect(card).toMatchObject({ type: "card", card: { reason: "guess", why: expect.any(String) } });
    expect(card.card.examples.length).toBeGreaterThanOrEqual(3);
    await call(url, "/api/answer", { responseId: card.card.responseId, answer: 0 });
    await call(url, "/api/finish", {});
    expect(await done).toBe(0);
    expect(h.out.join("\n")).toMatch(/Stopped: answered 1 card, settled 1 guess\. The next review picks up where you left off\./);
  });

  it("finishes the session on Ctrl-C", async () => {
    const h = harness();
    await h.run("init", "--name", "T");
    h.claim();
    const done = h.run("review", "--demo-llm", "--port", "0");
    await h.pageUrl();
    h.interrupt();
    expect(await done).toBe(0);
    expect(h.out.join("\n")).toContain("Stopped:");
    const store = openStore({ path: join(h.home, "standin.db") });
    expect(store.listSessions().every((s) => s.endedAt !== null)).toBe(true);
    store.close();
  });

  it("rejects a bad --port", async () => {
    const h = harness();
    await h.run("init", "--name", "T");
    expect(await h.run("review", "--port", "abc")).toBe(1);
    expect(h.err.join("\n")).toContain("--port must be a port number");
  });
});
