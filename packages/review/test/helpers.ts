import type { FetchOptions } from "@standin/intake";
import { parseConfig } from "@standin/schema";
import { startReviewServer, type ReviewServer } from "../src/index.ts";
import { world } from "../../knowledge/test/session-helpers.ts";

export const config = parseConfig({ persona: { name: "Lin Qiao" } });

/** A temp instance with a scripted session behind a review server on a free port. */
export async function served(o: Parameters<typeof world>[0] & { setup?: (w: ReturnType<typeof world>) => void; fetchOptions?: FetchOptions } = {}) {
  const w = world(o);
  o.setup?.(w);
  const session = await w.start();
  const server: ReviewServer = await startReviewServer({ session, store: w.store, config, port: 0, fetchOptions: o.fetchOptions });
  const base = `http://127.0.0.1:${server.port}`;
  const api = async (path: string, body?: unknown, token: string | null = server.token) => {
    const res = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(token ? { "X-Standin-Token": token } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: text ? (JSON.parse(text) as Record<string, unknown> & { [k: string]: any }) : null };
  };
  const page = (query: string) => fetch(`${base}/${query}`);
  return { w, session, server, base, api, page };
}
