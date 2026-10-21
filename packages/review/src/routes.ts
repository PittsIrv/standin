import { queuePlace, reviewQueue } from "@standin/compaction";
import type { FinishReport } from "@standin/knowledge";
import { Rating } from "@standin/schema";
import { z } from "zod";
import { nextCard, queueCard } from "./cards.ts";
import type { Route, ReviewServerOptions } from "./server.ts";

const Id = z.string().min(1).max(64);

/** The review page's JSON API, beyond status and finish. */
export function registerRoutes(o: ReviewServerOptions, route: Route, _finish: () => Promise<FinishReport>): void {
  const { session, store, config } = o;

  // ---- the session -----------------------------------------------------------
  route("GET", "/api/card", async () => ({ card: await nextCard(session, store, config), warnings: session.warnings.splice(0) }));
  route("POST", "/api/rate", ({ body }) => {
    const b = z.object({ responseId: Id, rating: Rating }).parse(body);
    return session.rate(b.responseId, b.rating);
  });
  route("POST", "/api/answer", ({ body }) => {
    const b = z.object({ responseId: Id, text: z.string().trim().min(1).max(4000) }).parse(body);
    session.answer(b.responseId, b.text);
  });
  route("POST", "/api/judge", ({ body }) => {
    const b = z.object({ responseId: Id, gap: z.boolean() }).parse(body);
    session.judgeMiss(b.responseId, b.gap);
  });
  route("POST", "/api/claim", ({ body }) => {
    const b = z.object({ claimNodeId: Id, choice: z.enum(["keep", "lower"]) }).parse(body);
    session.decideClaim(b.claimNodeId, b.choice);
  });

  // ---- the review queue: the same decisions (and decision log) as the CLI ---------
  route("POST", "/api/decide", ({ body }) => {
    const b = z.object({ id: Id, decision: z.enum(["approve", "reject", "keep", "expire"]), statement: z.string().trim().min(1).max(1000).optional() }).parse(body);
    const id = store.getMemory(b.id).id;
    const place = queuePlace(store, config, id);
    const itemKind = b.decision === "keep" || b.decision === "expire" ? "still-true" : "memory";
    const m =
      b.decision === "approve"
        ? store.approve(id, { statement: b.statement })
        : b.decision === "reject"
          ? store.reject(id)
          : b.decision === "keep"
            ? store.keepCurrent(id)
            : store.expire(id, "no longer true", "person");
    store.recordQueueDecision({ itemId: m.id, itemKind, ...place, decision: b.decision });
    return m;
  });
  route("GET", "/api/queue", () => ({ items: reviewQueue(store, config).map((i) => queueCard(store, i)) }));
}
