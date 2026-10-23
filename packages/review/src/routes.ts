import { assertNoSecret, clean, describeAll, scan } from "@standin/airlock";
import { queuePlace, reviewQueue } from "@standin/compaction";
import { loadSnapshot, MAX_INTRO_STATEMENTS, nodeDetail, treeNodes, type FinishReport } from "@standin/knowledge";
import { fetchPage, fileToText, IntakeError, LIMITS } from "@standin/intake";
import { EntityKind, FactKind, QuizRating, ROOTS } from "@standin/schema";
import { decideHeld, listVersions, preparePublish, prepareRollback, publish, rollback } from "@standin/publish";
import { answerTurn } from "@standin/speak";
import { NameTakenError } from "@standin/store";
import { z } from "zod";
import { nextCard, queueCard } from "./cards.ts";
import { UnavailableError, type Route, type ReviewServerOptions } from "./server.ts";

const Id = z.string().min(1).max(64);
/** A 10 MB file, base64-encoded, plus the JSON around it. */
const MAX_UPLOAD = Math.ceil((LIMITS.fileBytes * 4) / 3) + 4096;

/** The review page's JSON API, beyond status and finish. */
export function registerRoutes(o: ReviewServerOptions, route: Route, _finish: () => Promise<FinishReport>): void {
  const { session, store, config } = o;

  // ---- the session -----------------------------------------------------------
  route("GET", "/api/card", async () => ({ card: await nextCard(session, store, config, o.quiz), warnings: session.warnings.splice(0) }));
  route("POST", "/api/answer", ({ body }) => {
    const b = z.object({ responseId: Id, answer: z.union([z.number().int().min(0).max(4), z.literal("wouldnt_say")]) }).parse(body);
    session.answer(b.responseId, b.answer);
  });
  route("POST", "/api/skip", ({ body }) => {
    const b = z.object({ parentId: Id }).parse(body);
    store.getTopic(b.parentId);
    session.skipRest(b.parentId);
  });
  // ---- the introduction: sources wait in the session until the person confirms statements from them ----
  const site: { host: string | null; pages: number } = { host: null, pages: 0 };
  const fetchSite = async (url: string) => {
    if (site.pages >= LIMITS.sitePages) throw new IntakeError(`At most ${LIMITS.sitePages} pages of a website can be read.`);
    const page = await fetchPage(url, o.fetchOptions);
    site.pages++;
    return { page, source: session.addSource("website", page.url, `${page.title}\n\n${page.text}`) };
  };
  route("GET", "/api/intro/sources", () => ({ sources: session.introSources() }));
  route("POST", "/api/intro/text", ({ body }) => {
    const b = z.object({ text: z.string().trim().min(1).max(LIMITS.textChars) }).parse(body);
    return session.addSource("intro", "your introduction", b.text);
  });
  route(
    "POST",
    "/api/intro/file",
    async ({ body }) => {
      const b = z.object({ name: z.string().trim().min(1).max(200), data: z.string().max(Math.ceil((LIMITS.fileBytes * 4) / 3) + 4) }).parse(body);
      const { text } = await fileToText(b.name, Buffer.from(b.data, "base64"));
      if (!text.trim()) throw new IntakeError(`${b.name} has no text in it.`);
      return session.addSource("file", b.name, text.slice(0, LIMITS.textChars * 5));
    },
    { maxBody: MAX_UPLOAD },
  );
  route("POST", "/api/intro/site", async ({ body }) => {
    const b = z.object({ url: z.string().trim().min(1).max(2000) }).parse(body);
    const { page, source } = await fetchSite(b.url.includes("://") ? b.url : `https://${b.url}`);
    site.host = new URL(page.url).hostname;
    return { source, links: page.links };
  });
  route("POST", "/api/intro/pages", async ({ body }) => {
    const b = z.object({ urls: z.array(z.string().max(2000)).min(1).max(LIMITS.sitePages) }).parse(body);
    const added = [];
    for (const url of b.urls) {
      const host = URL.canParse(url) ? new URL(url).hostname : null;
      if (!site.host || host !== site.host) throw new IntakeError("Only pages of the website you added can be read.");
      added.push((await fetchSite(url)).source);
    }
    return { sources: added };
  });
  route("POST", "/api/intro/remove", ({ body }) => {
    session.removeSource(z.object({ sourceId: Id }).parse(body).sourceId);
  });
  route("POST", "/api/intro/read", () => session.readSources());
  const Confirmed = z.object({
    sourceId: Id,
    statement: z.string().max(500),
    quote: z.string().max(2000),
    kind: FactKind,
    kindLabel: z.string().max(60).nullable(),
    start: z.string().max(40).nullable(),
    end: z.string().max(40).nullable(),
    current: z.boolean(),
  });
  route("POST", "/api/intro/confirm", ({ body }) => {
    const b = z.object({ statements: z.array(Confirmed).max(MAX_INTRO_STATEMENTS * 2) }).parse(body);
    return session.introduce(b.statements);
  });
  route("POST", "/api/intro/skip", () => {
    session.skipIntro();
  });

  // ---- the personal-data guard: a draft checked as it's typed; nothing stored, no model (spec §3) ----
  route("POST", "/api/check", ({ body }) => {
    const { text } = z.object({ text: z.string().max(LIMITS.textChars) }).parse(body);
    const found = scan(text);
    return { findings: describeAll(text, found).map((d, i) => ({ ...d, start: found[i]!.start, end: found[i]!.end })) };
  });

  // ---- asking as a visitor, and the self-quiz (answering spec §4, §7) ----
  route("POST", "/api/ask", async ({ body }) => {
    const b = z.object({ question: z.string().trim().min(1).max(500) }).parse(body);
    const question = clean(b.question, "refuse").text; // it goes to a model and the trace
    if (!o.turn) throw new UnavailableError("Asking isn't available in this session.");
    return answerTurn(o.turn, question);
  });
  const deck = () => {
    if (!o.quiz) throw new UnavailableError("The self-quiz isn't available in this session.");
    return o.quiz;
  };
  route("POST", "/api/quiz/answer", ({ body }) => {
    const b = z.object({ caseId: z.string().min(1).max(200), answer: z.string().trim().min(1).max(LIMITS.textChars) }).parse(body);
    return deck().answer(b.caseId, clean(b.answer, "refuse").text, session.sessionId);
  });
  route("POST", "/api/quiz/rate", ({ body }) => {
    const b = z.object({ quizId: Id, rating: QuizRating }).parse(body);
    deck().rate(b.quizId, b.rating);
  });
  route("POST", "/api/quiz/skip", ({ body }) => {
    deck().skip(z.object({ caseId: z.string().min(1).max(200) }).parse(body).caseId);
  });

  // ---- questions about the person's life: answered like the introduction, put off, or dismissed ----
  const Question = z.object({ questionId: Id });
  const known = (id: string) => store.getQuestion(id);
  route("POST", "/api/question/read", ({ body }) => {
    const b = Question.extend({ text: z.string().trim().min(1).max(LIMITS.textChars) }).parse(body);
    known(b.questionId);
    return session.readAnswer(b.questionId, b.text);
  });
  route("POST", "/api/question/confirm", ({ body }) => {
    const b = Question.extend({ statements: z.array(Confirmed).max(MAX_INTRO_STATEMENTS) }).parse(body);
    known(b.questionId);
    return session.answerQuestion(b.questionId, b.statements);
  });
  route("POST", "/api/question/skip", ({ body }) => {
    const b = Question.parse(body);
    known(b.questionId);
    session.skipQuestion(b.questionId);
  });
  route("POST", "/api/question/dismiss", ({ body }) => {
    const b = Question.parse(body);
    known(b.questionId);
    session.dismissQuestion(b.questionId);
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
    assertNoSecret(b.name); // the store only cuts from node names, since models name nodes too
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

  // ---- publishing (publish spec §4) ---------------------------------------------------
  const pub = () => {
    if (!o.publish) throw new UnavailableError("Publishing isn't available in this session.");
    return o.publish;
  };
  const counts = (b: { memories: unknown[]; nodes: unknown[]; exemplars: unknown[] }) => ({ memories: b.memories.length, nodes: b.nodes.length, exemplars: b.exemplars.length });
  route("GET", "/api/publish", async () => {
    const d = pub();
    const p = await preparePublish(d);
    return { current: p.current, counts: counts(p.bundle), changes: p.changes, findings: p.findings, held: p.held, versions: listVersions(d.dir) };
  });
  const ItemKey = z.string().regex(/^(memory|node|exemplar):[\w-]{1,64}$/);
  route("POST", "/api/publish/decide", ({ body }) => {
    const b = z.object({ key: ItemKey, decision: z.enum(["keep", "hide"]) }).parse(body);
    decideHeld(store, b.key, b.decision);
  });
  route("POST", "/api/publish", async () => {
    const saved = await publish(pub());
    return { version: saved.version, counts: counts(saved) };
  });
  const Version = z.coerce.number().int().positive();
  route("GET", "/api/publish/rollback/:id", ({ id }) => {
    const p = prepareRollback(pub(), Version.parse(id));
    return { current: p.current, counts: counts(p.bundle), changes: p.changes, findings: p.findings };
  });
  route("POST", "/api/publish/rollback", ({ body }) => {
    const b = z.object({ version: Version }).parse(body);
    const saved = rollback(pub(), b.version);
    return { version: saved.version, counts: counts(saved) };
  });

  // ---- boundaries ("wouldn't say"), with undo ------------------------------------
  route("GET", "/api/boundaries", () => ({ boundaries: session.boundaries() }));
  route("POST", "/api/boundaries/undo", ({ body }) => {
    const b = z.object({ nodeId: Id }).parse(body);
    session.undoBoundary(b.nodeId);
  });
}
