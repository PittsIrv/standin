import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { BlockedUrlError, FetchFailedError, TooLargeError } from "./errors.ts";
import { fileToText } from "./files.ts";
import { LIMITS } from "./text.ts";

type Lookup = (host: string) => Promise<{ address: string; family: number }[]>;
export interface FetchOptions {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  lookup?: Lookup;
}
export interface Page {
  url: string;
  title: string;
  text: string;
  /** Same-site pages it links to, for the person to tick. */
  links: { url: string; title: string }[];
}

const MAX_REDIRECTS = 3;
const MAX_LINKS = 50;

/** True for an address anyone on the internet could reach: never loopback, private, link-local, shared or multicast. */
export function isPublicAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (mapped) return isPublicAddress(mapped);
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
  }
  if (isIP(ip) === 6) {
    const x = ip.toLowerCase();
    return !(x === "::" || x === "::1" || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith("ff"));
  }
  return false;
}

async function checkUrl(raw: string, lookup: Lookup): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError(`${raw} isn't a web address.`);
  }
  if (url.protocol !== "https:") throw new BlockedUrlError("Only https:// addresses can be read.");
  if (url.username || url.password) throw new BlockedUrlError("Addresses with a login in them can't be read.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host).catch(() => [])).map((a) => a.address);
  if (addresses.length === 0) throw new BlockedUrlError(`${host} couldn't be found.`);
  if (!addresses.every(isPublicAddress)) throw new BlockedUrlError(`${host} is a private address; only public websites can be read.`);
  return url;
}

async function readCapped(res: Response, limit: number, what: string): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new TooLargeError(`That ${what} is over ${Math.round(limit / 1024 / 1024)} MB.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

const BLOCKS = new Set(["ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT", "FIGCAPTION", "FIGURE", "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "OL", "P", "PRE", "SECTION", "TABLE", "TD", "TH", "TR", "UL"]);

/** An element's text with a line break around every block and at every <br>, so neighboring blocks never run together. */
function blockText(root: { childNodes: ArrayLike<unknown> }): string {
  let out = "";
  const walk = (node: { nodeType: number; nodeName: string; textContent: string | null; childNodes: ArrayLike<unknown> }) => {
    if (node.nodeType === 3) out += node.textContent ?? "";
    else if (node.nodeName === "BR") out += "\n";
    else if (node.nodeType === 1) {
      const block = BLOCKS.has(node.nodeName);
      if (block) out += "\n";
      for (const child of Array.from(node.childNodes)) walk(child as typeof node);
      if (block) out += "\n";
    }
  };
  for (const child of Array.from(root.childNodes)) walk(child as Parameters<typeof walk>[0]);
  return out
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * One page of the person's own website, as text (spec §3): https, public addresses only (checked again on every
 * redirect, which must stay on the same host), 2 MB and 10 s. The main text comes from Readability; links are the
 * same-site pages it points to. The text is data for a model, never instructions.
 */
export async function fetchPage(raw: string, o: FetchOptions = {}): Promise<Page> {
  const lookup: Lookup = o.lookup ?? ((host) => dnsLookup(host, { all: true }));
  const doFetch = o.fetch ?? ((url, init) => fetch(url, init));
  let url = await checkUrl(raw, lookup);
  const host = url.hostname;
  let res: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    res = await doFetch(url.href, { redirect: "manual", signal: AbortSignal.timeout(LIMITS.pageTimeoutMs), headers: { "user-agent": "standin (reading a page its owner asked for)" } }).catch((err: unknown) => {
      throw new FetchFailedError(`${url.href} couldn't be read: ${err instanceof Error ? err.message : String(err)}`);
    });
    if (res.status < 300 || res.status >= 400) break;
    const location = res.headers.get("location");
    if (!location) break;
    const next = await checkUrl(new URL(location, url).href, lookup);
    if (next.hostname !== host) throw new BlockedUrlError(`${url.href} redirects to another site (${next.hostname}); only the site you gave is read.`);
    url = next;
    res = null;
  }
  if (!res || res.status >= 300) throw new FetchFailedError(`${url.href} answered ${res?.status ?? "with too many redirects"}.`);
  const type = res.headers.get("content-type") ?? "text/html";
  const name = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? url.hostname);
  // A linked PDF (a résumé, a paper) is read through its text layer, like an uploaded file.
  if (type.startsWith("application/pdf")) {
    const { text } = await fileToText(name.toLowerCase().endsWith(".pdf") ? name : `${name}.pdf`, await readCapped(res, LIMITS.fileBytes, "PDF"));
    return { url: url.href, title: name, text, links: [] };
  }
  if (!/text\/(html|plain)|application\/xhtml/.test(type)) throw new FetchFailedError(`${url.href} isn't a web page (${type}).`);
  const body = new TextDecoder("utf-8").decode(await readCapped(res, LIMITS.pageBytes, "page"));
  if (type.startsWith("text/plain")) return { url: url.href, title: name, text: body.trim(), links: [] };

  const { document } = parseHTML(body);
  const title = (document.querySelector("title")?.textContent ?? url.hostname).trim();
  const links = new Map<string, string>();
  for (const a of document.querySelectorAll("a[href]")) {
    let target: URL;
    try {
      target = new URL(a.getAttribute("href") ?? "", url);
    } catch {
      continue;
    }
    target.hash = "";
    if (target.protocol !== "https:" || target.hostname !== host || target.href === url.href || links.has(target.href)) continue;
    links.set(target.href, (a.textContent ?? "").trim() || target.pathname);
    if (links.size >= MAX_LINKS) break;
  }
  const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0], { charThreshold: 0 }).parse();
  const text = article?.content ? blockText(parseHTML(`<!doctype html><html><body>${article.content}</body></html>`).document.body) : blockText(document.body ?? { childNodes: [] });
  return { url: url.href, title, text, links: [...links].map(([u, t]) => ({ url: u, title: t })) };
}
