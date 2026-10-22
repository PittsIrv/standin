import { describe, expect, it } from "vitest";
import { BlockedUrlError, fetchPage } from "../src/index.ts";

const HTML = `<!doctype html><html><head><title>Lin Qiao</title></head><body>
<nav><a href="/about">About</a> <a href="/projects#top">Projects</a> <a href="https://other.example/x">Elsewhere</a></nav>
<article><h1>Lin Qiao</h1><p>I build AIs for board games. My latest engine, Kite, plays a Go variant.</p>
<p>Before that I built Lantern Bot, a card-game bot, and studied computer science.</p></article></body></html>`;

const site = (pages: Record<string, { status?: number; body?: string; location?: string }>) => async (url: string | URL | Request) => {
  const p = pages[String(url)];
  if (!p) return new Response("not found", { status: 404 });
  return new Response(p.body ?? "", { status: p.status ?? 200, headers: p.location ? { location: p.location } : { "content-type": "text/html" } });
};
const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];

describe("fetchPage", () => {
  it("keeps the main text and lists same-site links", async () => {
    const page = await fetchPage("https://lin.example/", { fetch: site({ "https://lin.example/": { body: HTML } }), lookup: publicDns });
    expect(page.title).toBe("Lin Qiao");
    expect(page.text).toContain("I build AIs for board games.");
    expect(page.text).not.toContain("Elsewhere");
    expect(page.links.map((l) => l.url)).toEqual(["https://lin.example/about", "https://lin.example/projects"]);
  });

  it("refuses http, private addresses, and redirects to another host or a private one", async () => {
    await expect(fetchPage("http://lin.example/", { fetch: site({}), lookup: publicDns })).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(fetchPage("https://127.0.0.1/", { fetch: site({}), lookup: publicDns })).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(fetchPage("https://intranet.example/", { fetch: site({}), lookup: async () => [{ address: "10.0.0.5", family: 4 }] })).rejects.toBeInstanceOf(BlockedUrlError);
    const away = site({ "https://lin.example/": { status: 302, location: "https://evil.example/" } });
    await expect(fetchPage("https://lin.example/", { fetch: away, lookup: publicDns })).rejects.toBeInstanceOf(BlockedUrlError);
    let calls = 0;
    const rebinding = async () => (calls++ === 0 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "192.168.1.1", family: 4 }]);
    const hop = site({ "https://lin.example/": { status: 301, location: "/home" }, "https://lin.example/home": { body: HTML } });
    await expect(fetchPage("https://lin.example/", { fetch: hop, lookup: rebinding })).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it("follows a same-site redirect", async () => {
    const hop = site({ "https://lin.example/": { status: 301, location: "/home" }, "https://lin.example/home": { body: HTML } });
    expect((await fetchPage("https://lin.example/", { fetch: hop, lookup: publicDns })).url).toBe("https://lin.example/home");
  });
});
