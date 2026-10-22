import { describe, expect, it } from "vitest";
import { served } from "./helpers.ts";

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

describe("review server", () => {
  it("binds to 127.0.0.1 by default", async () => {
    const { server } = await served();
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=/);
    await server.finish();
  });

  it("serves the page only with the token in the URL", async () => {
    const { server, page } = await served();
    const ok = await page(`?t=${server.token}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toMatch(/^text\/html/);
    expect(ok.headers.get("content-security-policy")).toBe(CSP);
    expect(ok.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await ok.text();
    expect(html).toContain("<title>standin review</title>");
    expect(html).toContain("X-Standin-Token");
    expect(html).toContain('id="forest"');
    expect((await page("")).status).toBe(403);
    expect((await page("?t=wrong")).status).toBe(403);
    await server.finish();
  });

  it("requires the token header on the API, never the query string", async () => {
    const { server, api } = await served();
    expect((await api("/api/status", undefined, null)).status).toBe(403);
    expect((await api(`/api/status?t=${server.token}`, undefined, null)).status).toBe(403);
    expect((await api("/api/status", undefined, "nope")).status).toBe(403);
    expect((await api("/api/nowhere", undefined, null)).status).toBe(403);
    expect((await api("/api/nowhere")).status).toBe(404);
    const status = await api("/api/status");
    expect(status.status).toBe(200);
    expect(status.headers.get("cache-control")).toBe("no-store");
    expect(status.json).toMatchObject({ answered: 0, finished: false });
    await server.finish();
  });

  it("rejects malformed and oversized bodies and keeps serving", async () => {
    const { server, api } = await served();
    expect((await api("/api/finish", "{")).status).toBe(400);
    expect((await api("/api/finish", JSON.stringify({ pad: "x".repeat(70_000) }))).status).toBe(413);
    expect((await api("/api/status")).status).toBe(200);
    await server.finish();
  });

  it("finishes once, from either side, then closes", async () => {
    const { w, session, server, api, base } = await served();
    const viaHttp = await api("/api/finish", {});
    const direct = await server.finish();
    expect(viaHttp.status).toBe(200);
    expect(viaHttp.json!.report).toEqual(direct);
    expect(await server.closed).toEqual(direct);
    expect(w.store.listSessions().find((s) => s.id === session.sessionId)!.endedAt).not.toBeNull();
    await expect(fetch(`${base}/api/status`)).rejects.toThrow();
  });
});
