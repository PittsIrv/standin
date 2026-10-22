import { randomBytes } from "node:crypto";
import { loadSnapshot, words } from "@standin/knowledge";
import type { LLM } from "@standin/llm";
import type { AnswerState } from "@standin/schema";
import type { Store } from "@standin/store";
import type { Tracer } from "@standin/trace";
import { awaken, candidates, type Awakened, type Limits } from "./awaken.ts";
import { codeCheck } from "./check.ts";
import { buildCheckPrompt, buildRoutePrompt, buildSpeakPrompt, type ContextItem } from "./prompts.ts";
import { CheckSchema, RouteSchema, SpeakSchema, type CheckOut } from "./schemas.ts";

export interface TurnDeps {
  store: Store;
  /** The `answer` role: routes the question and writes the reply. */
  answer: LLM;
  /** The `check` role: confirms the reply's claims against its citations. */
  check: LLM;
  tracer: Tracer;
  personaName: string;
  speakAt: number;
  limits: Limits;
}

export type NotOnRecordReason = "nothing" | "competence" | "check";

/** "Show your work": what the turn looked at and decided (architecture §8). */
export interface Work {
  candidates: string[];
  seeds: Awakened["seeds"];
  context: { id: string; text: string; node: string; kind: ContextItem["kind"] }[];
  filtered: Awakened["filtered"];
  exemplars: number;
  /** The speaker's own reply when a check rejected it, so the person can see what was stopped. */
  rejected: string | null;
  checks: { code: string | null; model: CheckOut | string | null };
  modelCalls: number;
  costUsd: number;
  ms: number;
}

export interface Reply {
  text: string;
  state: AnswerState;
  /** Why a reply is not on record; null otherwise. */
  reason: NotOnRecordReason | null;
  cites: { id: string; statement: string; node: string }[];
  general: boolean;
  work: Work;
  traceId: string;
}

/** The fixed replies: nothing private can reach them (answering spec §3). */
export const TEMPLATES = {
  deflected: () => "That's something I keep private, so I won't go into it here. If it matters, ask me directly.",
  notOnRecord: (reason: NotOnRecordReason) =>
    reason === "competence"
      ? "That's outside what I know well, so I'd rather not explain it as me. Ask me directly if you want my take."
      : "I'm not sure I've told my standin about that. Best to ask me directly.",
};

/** Approved writing of the person's, most like the question first, each cut to `chars` (answering spec §6). */
function exemplars(store: Store, question: string, n: number, chars: number): string[] {
  if (n === 0) return [];
  const asked = new Set(words(question));
  return store
    .listExemplars({ status: "approved" })
    .map((e, i) => ({ text: e.text, score: words(e.text).filter((w) => asked.has(w)).length, i }))
    .sort((a, b) => b.score - a.score || b.i - a.i)
    .slice(0, n)
    .map((e) => (e.text.length > chars ? `${e.text.slice(0, chars).trimEnd()}…` : e.text));
}

/** The context the speaker sees: memories, how well each explainable concept is known, and confident guesses. */
function contextItems(a: Awakened, t: ReturnType<typeof loadSnapshot>): ContextItem[] {
  const items: ContextItem[] = a.memories.map((m) => ({ id: m.id, text: m.statement, node: m.nodeName, kind: m.kind }));
  const cited = new Set(a.memories.map((m) => m.id));
  for (const s of a.seeds) {
    if (!s.knowledge || s.mode === null || s.mode === "decline") continue;
    const lit = t.approved.get(s.id);
    if (lit && cited.has(lit.memoryId)) continue;
    const depth = t.stated.get(s.id) ?? lit?.depth ?? t.confirmedHypotheses.get(s.id);
    if (depth !== undefined) items.push({ id: `node:${s.id}`, text: `I know ${s.name} at level ${depth} of 4 (1 basic, 4 expert).`, node: s.name, kind: "lighting" });
  }
  for (const h of a.hypotheses)
    items.push({ id: `guess:${h.nodeId}`, text: `I probably know ${h.name} at level ${h.depth} of 4 (a guess, not something I said: hedge it).`, node: h.name, kind: "guess" });
  return items;
}

/**
 * One visitor turn, as a visitor would get it (answering spec §2): route, awaken, filter, decide the state, speak,
 * check in code, check with a model, and fall back to "not on record" if either check rejects the reply.
 */
export async function answerTurn(deps: TurnDeps, question: string): Promise<Reply> {
  const { store, tracer, limits } = deps;
  const started = Date.now();
  const work: Work = { candidates: [], seeds: [], context: [], filtered: [], exemplars: 0, rejected: null, checks: { code: null, model: null }, modelCalls: 0, costUsd: 0, ms: 0 };
  let traceId = "";
  const reply = await tracer.run("ask", { "standin.ask.chars": question.length }, async (run) => {
    traceId = run.traceId;
    const done = (r: Omit<Reply, "work" | "traceId">) => {
      run.setAttributes({ "standin.ask.state": r.state, "standin.ask.reason": r.reason });
      return r;
    };
    const notOnRecord = (reason: NotOnRecordReason) => done({ text: TEMPLATES.notOnRecord(reason), state: "not_on_record", reason, cites: [], general: false });

    // 1. Route.
    const cands = candidates(store, question, limits.candidates);
    work.candidates = cands.map((c) => c.name);
    if (cands.length === 0) return notOnRecord("nothing");
    const listed = cands.map((topic) => ({ topic, place: topic.rootKey ? "a root" : `in ${store.rootOf(topic.id) ?? "no tree yet"}` }));
    const routed = await deps.answer.generateObject({ ...buildRoutePrompt(question, listed), schema: RouteSchema, purpose: "route" });
    const seedIds = [...new Set(routed.seeds.filter((n) => n >= 1 && n <= cands.length).map((n) => cands[n - 1]!.id))].slice(0, limits.seeds);
    if (seedIds.length === 0) return notOnRecord("nothing");

    // 2–3. Awaken and filter.
    const t = loadSnapshot(store);
    const a = await tracer.span("ask.awaken", {}, async () => awaken(store, question, seedIds, { budget: limits.awakenBudget, speakAt: deps.speakAt, snapshot: t }));
    work.seeds = a.seeds;
    work.filtered = a.filtered;

    // 4. The state, decided in code where it can be.
    if (a.seeds.some((s) => s.boundary)) return done({ text: TEMPLATES.deflected(), state: "deflected", reason: null, cites: [], general: false });
    const items = contextItems(a, t);
    work.context = items;
    const generalAllowed = a.seeds.some((s) => s.knowledge && (s.mode === "explain" || s.mode === "brief"));
    if (items.length === 0 && !generalAllowed) return notOnRecord(a.seeds.every((s) => s.knowledge) ? "competence" : "nothing");

    // 5. Speak.
    const canary = `cnry_${randomBytes(6).toString("hex")}`;
    const examples = exemplars(store, question, limits.exemplars, limits.exemplarChars);
    work.exemplars = examples.length;
    const out = await deps.answer.generateObject({
      ...buildSpeakPrompt({ personaName: deps.personaName, question, seeds: a.seeds, items, exemplars: examples, canary, generalAllowed }),
      schema: SpeakSchema,
      purpose: "speak",
    });
    if (out.state === "not_on_record") return notOnRecord("nothing");

    // 6. Check in code.
    const byId = new Map(items.map((i) => [i.id, i]));
    const reject = (why: string) => {
      work.rejected = out.reply;
      run.setAttribute("standin.ask.rejected", why);
      return notOnRecord("check");
    };
    work.checks.code = codeCheck(out, {
      allowed: new Set(byId.keys()),
      inferable: items.some((i) => i.kind === "guess" || i.kind === "stance"),
      generalAllowed,
      canary,
      hidden: a.hidden,
    });
    if (work.checks.code) return reject(work.checks.code);

    // 7. Check with a model; a failed call counts as a rejection.
    const cited = out.cites.map((id) => byId.get(id)!);
    try {
      work.checks.model = await deps.check.generateObject({ ...buildCheckPrompt({ personaName: deps.personaName, reply: out.reply, cited, generalAllowed }), schema: CheckSchema, purpose: "check" });
    } catch (err) {
      work.checks.model = `check failed: ${err instanceof Error ? err.message : String(err)}`;
      return reject(work.checks.model);
    }
    if (!work.checks.model.supported || work.checks.model.unsupported.length > 0) return reject(`unsupported: ${work.checks.model.unsupported.join("; ")}`);

    return done({ text: out.reply, state: out.state, reason: null, cites: cited.map((i) => ({ id: i.id, statement: i.text, node: i.node })), general: out.general });
  });
  const summary = store.listRuns({ kind: "ask", limit: 5 }).find((r) => r.traceId === traceId);
  work.modelCalls = summary?.modelCalls ?? 0;
  work.costUsd = summary?.costUsd ?? 0;
  work.ms = Date.now() - started;
  return { ...reply, work, traceId };
}
