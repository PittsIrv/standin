import { queuePlace, reviewQueue } from "@standin/compaction";
import { loadSnapshot, MAX_INTRO_STATEMENTS, nodeDetail, treeNodes, type FinishReport } from "@standin/knowledge";
import { EntityKind, ROOTS } from "@standin/schema";
import { NameTakenError } from "@standin/store";
import { z } from "zod";
import { nextCard, queueCard } from "./cards.ts";
import type { Route, ReviewServerOptions } from "./server.ts";

const Id = z.string().min(1).max(64);

/** The review page's JSON API, beyond status and finish. */
export function registerRoutes(o: ReviewServerOptions, route: Route, _finish: () => Promise<FinishReport>): void {
  const { session, store, config } = o;

  // ---- the session -----------------------------------------------------------
  route("GET", "/api/card", async () => ({ card: await nextCard(session, store, config), warnings: session.warnings.splice(0) }));
  route("POST", "/api/answer", ({ body }) => {
    const b = z.object({ responseId: Id, answer: z.union([z.number().int().min(0).max(4), z.literal("wouldnt_say")]) }).parse(body);
    session.answer(b.responseId, b.answer);
  });
  route("POST", "/api/skip", ({ body }) => {
    const b = z.object({ parentId: Id }).parse(body);
    store.getTopic(b.parentId);
    session.skipRest(b.parentId);
  });
  const IntroText = z.string().trim().min(1).max(4000);
  route("POST", "/api/intro/read", async ({ body }) => {
    const b = z.object({ text: IntroText }).parse(body);
    return { statements: await session.readIntro(b.text) };
  });
  route("POST", "/api/intro/confirm", ({ body }) => {
    const b = z.object({ text: IntroText, statements: z.array(z.string().max(300)).max(MAX_INTRO_STATEMENTS) }).parse(body);
    return session.introduce(b.text, b.statements);
  });
  route("POST", "/api/intro/skip", () => {
    session.skipIntro();
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

  // ---- the forest: see it, and edit it directly ---------------------------------
  const snapshot = () => loadSnapshot(store, { brierWindow: config.hypotheses.brierWindow });
  route("GET", "/api/forest", () => ({
    roots: ROOTS.map((r) => ({ key: r.key, name: r.name, id: store.root(r.key).id })),
    nodes: treeNodes(snapshot(), { all: true }),
    links: store.listEdges().filter((e) => e.kind !== "part_of"),
  }));
  route("GET", "/api/node/:id", ({ id }) => {
    store.getTopic(id);
    return nodeDetail(store, snapshot(), id);
  });
  const Name = z.string().trim().min(1).max(120);
  route("POST", "/api/tree/rename", ({ body }) => {
    const b = z.object({ nodeId: Id, name: Name }).parse(body);
    return store.renameTopic(b.nodeId, b.name);
  });
  route("POST", "/api/tree/describe", ({ body }) => {
    const b = z.object({ nodeId: Id, definition: z.string().max(500).nullable(), examples: z.array(z.string().max(120)).max(12) }).parse(body);
    return store.describeTopic(b.nodeId, b);
  });
  route("POST", "/api/tree/move", ({ body }) => {
    const b = z.object({ nodeId: Id, parentId: Id.nullable() }).parse(body);
    return store.moveTopic(b.nodeId, b.parentId) ?? { ok: true };
  });
  route("POST", "/api/tree/add", ({ body }) => {
    const b = z.object({ parentId: Id, name: Name, label: EntityKind }).parse(body);
    store.getTopic(b.parentId);
    if (store.findEntity({ name: b.name, kind: b.label })) throw new NameTakenError(b.name);
    return store.transaction(() => {
      const node = store.ensureNode(b.name, b.label);
      store.moveTopic(node.id, b.parentId);
      return store.getTopic(node.id);
    });
  });
  route("POST", "/api/tree/delete-node", ({ body }) => {
    const b = z.object({ nodeId: Id }).parse(body);
    return store.deleteTopic(b.nodeId);
  });
  route("POST", "/api/tree/delete-edge", ({ body }) => {
    const b = z.object({ edgeId: Id }).parse(body);
    store.deleteEdge(b.edgeId);
  });
  route("POST", "/api/fact/move", ({ body }) => {
    const b = z.object({ memoryId: Id, nodeId: Id }).parse(body);
    store.getTopic(b.nodeId);
    return store.setHome(b.memoryId, b.nodeId);
  });

  // ---- boundaries ("wouldn't say"), with undo ------------------------------------
  route("GET", "/api/boundaries", () => ({ boundaries: session.boundaries() }));
  route("POST", "/api/boundaries/undo", ({ body }) => {
    const b = z.object({ nodeId: Id }).parse(body);
    session.undoBoundary(b.nodeId);
  });
}
