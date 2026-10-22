import { IntakeError, TooLargeError, type FetchOptions } from "@standin/intake";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { CardSession, FinishReport } from "@standin/knowledge";
import type { Config } from "@standin/schema";
import { AlreadyRatedError, CycleError, InvalidTransitionError, NameTakenError, NotFoundError, RootEditError, type Store } from "@standin/store";
import { ZodError } from "zod";

export interface ReviewServerOptions {
  session: CardSession;
  store: Store;
  config: Config;
  /** 127.0.0.1 unless the person asked for the local network (`--lan`). */
  host?: string;
  port?: number;
  token?: string;
  /** The probability a probable node needs before the standin speaks to it. */
  speakAt?: number;
  /** How websites are fetched for the introduction (tests inject a fake network). */
  fetchOptions?: FetchOptions;
}

export interface ReviewServer {
  /** The page's address, with the token. */
  url: string;
  host: string;
  port: number;
  token: string;
  /** Runs the session's finish step once (button or Ctrl-C), then closes the server. */
  finish(): Promise<FinishReport>;
  /** Resolves with the report once finished and closed. */
  closed: Promise<FinishReport>;
}

export interface RouteContext {
  body: unknown;
  /** The path segment after a route's trailing `:id`. */
  id: string;
}
export type Handler = (ctx: RouteContext) => unknown | Promise<unknown>;
/** `maxBody` raises the body limit for one route (file uploads). */
export type Route = (method: "GET" | "POST", path: string, handler: Handler, opts?: { maxBody?: number }) => void;

/** Bodies larger than this are refused (413), unless a route allows more. */
export const MAX_BODY = 65_536;

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
const API_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

class BodyError extends Error {
  constructor(readonly status: 400 | 413) {
    super(status === 413 ? "request body too large" : "request body is not valid JSON");
  }
}

function sameSecret(given: string | null | undefined, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new BodyError(413);
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new BodyError(400);
  }
}

function statusFor(err: unknown): number {
  if (err instanceof BodyError) return err.status;
  if (err instanceof TooLargeError) return 413;
  if (err instanceof IntakeError) return 422;
  if (err instanceof ZodError) return 400;
  if (err instanceof NotFoundError) return 404;
  if (err instanceof AlreadyRatedError || err instanceof InvalidTransitionError || err instanceof NameTakenError || err instanceof CycleError || err instanceof RootEditError)
    return 409;
  return 500;
}

/**
 * The local review page: one HTML page and a JSON API over the store and the session. Every request needs the
 * session's random token (the page in its URL, the API only in a header), so other pages in the browser can't call
 * it. Handlers run one at a time, so a double-submitted answer can't race itself.
 */
export async function startReviewServer(o: ReviewServerOptions, register?: (route: Route, finish: () => Promise<FinishReport>) => void): Promise<ReviewServer> {
  const token = o.token ?? randomBytes(32).toString("base64url");
  const host = o.host ?? "127.0.0.1";
  const page = readFileSync(new URL("./page.html", import.meta.url), "utf8");
  const routes = new Map<string, Handler>();
  const limits = new Map<string, number>();
  const route: Route = (method, path, handler, opts) => {
    routes.set(`${method} ${path}`, handler);
    if (opts?.maxBody) limits.set(`${method} ${path}`, opts.maxBody);
  };

  let lane: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => T | Promise<T>): Promise<T> => {
    const next = lane.then(fn);
    lane = next.catch(() => undefined);
    return next;
  };

  let finishing: Promise<FinishReport> | null = null;
  let report: FinishReport | null = null;
  let active = 0;
  let closing = false;
  let resolveClosed!: (r: FinishReport) => void;
  const closed = new Promise<FinishReport>((r) => (resolveClosed = r));
  /** Once finished, close as soon as no request is still being answered (so the one asking for the report gets it). */
  const maybeClose = () => {
    if (!report || active > 0 || closing) return;
    closing = true;
    const done = report;
    server.close(() => resolveClosed(done));
    server.closeAllConnections();
  };
  const finish = (): Promise<FinishReport> => {
    finishing ??= serial(() => o.session.finish()).then((r) => {
      report = r;
      setImmediate(maybeClose);
      return r;
    });
    return finishing;
  };

  route("GET", "/api/status", () => {
    const answered = o.store.listResponses({ sessionId: o.session.sessionId, rated: true }).length;
    return { sessionId: o.session.sessionId, answered, finished: finishing !== null };
  });
  route("POST", "/api/finish", async () => ({ report: await finish(), warnings: o.session.warnings.splice(0) }));
  register?.(route, finish);

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    active++;
    res.on("close", () => {
      active--;
      maybeClose();
    });
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, API_HEADERS);
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "GET" && url.pathname === "/") {
        if (!sameSecret(url.searchParams.get("t"), token)) return send(403, { error: "forbidden" });
        res.writeHead(200, PAGE_HEADERS);
        return res.end(page);
      }
      if (!sameSecret(req.headers["x-standin-token"] as string | undefined, token)) return send(403, { error: "forbidden" });
      const method = req.method === "POST" ? "POST" : "GET";
      const parts = url.pathname.split("/");
      const exact = routes.get(`${method} ${url.pathname}`);
      const withId = routes.get(`${method} ${parts.slice(0, -1).join("/")}/:id`);
      const handler = exact ?? withId;
      if (!handler) return send(404, { error: "not found" });
      const body = method === "POST" ? await readBody(req, limits.get(`${method} ${url.pathname}`) ?? MAX_BODY) : undefined;
      const result = await (url.pathname === "/api/finish" ? handler({ body, id: "" }) : serial(() => handler({ body, id: decodeURIComponent(parts.at(-1) ?? "") })));
      send(200, result ?? { ok: true });
    } catch (err) {
      send(statusFor(err), { error: err instanceof ZodError ? "invalid request" : err instanceof Error ? err.message : String(err) });
    }
  });

  await new Promise<void>((resolve) => server.listen(o.port ?? 0, host, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (o.port ?? 0);
  return { url: `http://${host}:${port}/?t=${token}`, host, port, token, finish, closed };
}
