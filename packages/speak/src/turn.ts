import type { LLM } from "@standin/llm";
import type { AnswerState, Bundle } from "@standin/schema";
import type { Tracer } from "@standin/trace";
import { awaken, candidates, terms, viewOf, type Awakened, type BundleView, type Limits } from "./awaken.ts";
import { codeCheck } from "./check.ts";
import { buildCheckPrompt, buildRoutePrompt, buildSpeakPrompt, type ContextItem } from "./prompts.ts";
import { CheckSchema, RouteSchema, SpeakSchema, type CheckOut } from "./schemas.ts";

export interface TurnDeps {
  /**
   * What a visitor may be told (publish spec §2): a published version, or a function that builds the draft, called
   * once per turn so a long-running caller answers from what is approved now.
   */
  bundle: Bundle | BundleView | (() => Bundle | BundleView);
  /** The `answer` role: routes the question and writes the reply. */
  answer: LLM;
  /** The `check` role: confirms the reply's claims against its citations. */
  check: LLM;
  tracer: Tracer;
  limits: Limits;
  /** The time, for memories that expire; defaults to the system clock. */
  now?: () => string;
  /** Model calls and cost of a finished trace, when the caller records them. */
  usage?: (traceId: string) => { modelCalls: number; costUsd: number } | null;
}

/** Why a reply is not on record; `error` when a model call failed (the visitor still gets a reply, never an error). */
export type NotOnRecordReason = "nothing" | "competence" | "check" | "error";

/** "Show your work": what the turn looked at and decided (architecture §8). */
export interface Work {
  candidates: string[];
  /** The router judged the question private (publish spec §3). */
  private: boolean;
  seeds: Awakened["seeds"];
  context: { id: string; text: string; node: string; kind: ContextItem["kind"] }[];
  filtered: Awakened["filtered"];
  exemplars: number;
  /** The speaker's own reply when a check rejected it, so the person can see what was stopped. */
  rejected: string | null;
  checks: { code: string | null; model: CheckOut | string | null };
  /** A failed route or speak call. */
  error: string | null;
  modelCalls: number;
  costUsd: number;
  ms: number;
}

export interface Reply {
  text: string;
  state: AnswerState;
  /** Why a reply is not on record or was refused as private; null otherwise. */
  reason: NotOnRecordReason | null;
  cites: { id: string; statement: string; node: string }[];
  general: boolean;
  work: Work;
  traceId: string;
}

/** The fixed replies (publish spec §3, decision 103): nothing private can reach them, and they never say why. */
export const TEMPLATES = {
  deflected: () => "Sorry, I can't tell you that.",
  notOnRecord: (_reason: NotOnRecordReason) => "I don't know.",
};

/** Approved writing of the person's, most like the question first, each cut to `chars` (answering spec §6). */
function exemplars(b: Bundle, question: string, n: number, chars: number): string[] {
  if (n === 0) return [];
  const asked = new Set(terms(question));
  return b.exemplars
    .map((e, i) => ({ text: e.text, score: terms(e.text).filter((w) => asked.has(w)).length, i }))
    .sort((a, b) => b.score - a.score || b.i - a.i)
    .slice(0, n)
    .map((e) => (e.text.length > chars ? `${e.text.slice(0, chars).trimEnd()}…` : e.text));
}

/**
 * The context the speaker sees: memories, how well each explainable concept is known, and confident guesses. A
 * private question gets memories only: no levels, no guesses.
 */
function contextItems(a: Awakened, v: BundleView, isPrivate: boolean): ContextItem[] {
  const items: ContextItem[] = a.memories.map((m) => ({ id: m.id, text: m.statement, node: m.nodeName, kind: m.kind }));
  if (isPrivate) return items;
  const lit = new Set(a.memories.filter((m) => m.kind === "competence").map((m) => m.nodeId));
  for (const s of a.seeds) {
    const answer = v.nodes.get(s.id)?.answer;
    if (!answer || answer.mode === "decline" || answer.via !== "own" || answer.depth === null || lit.has(s.id)) continue;
    items.push({ id: `node:${s.id}`, text: `I know ${s.name} at level ${answer.depth} of 4 (1 basic, 4 expert).`, node: s.name, kind: "lighting" });
  }
  for (const h of a.hypotheses)
    items.push({ id: `guess:${h.nodeId}`, text: `I probably know ${h.name} at level ${h.depth} of 4 (a guess, not something I said: hedge it).`, node: h.name, kind: "guess" });
  return items;
}

const canaryToken = () => `cnry_${[...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

/**
 * One visitor turn, as a visitor would get it (answering spec §2; publish spec §3): route and classify, awaken, decide
 * the state, speak, check in code, check with a model, and fall back to a template if either check rejects the reply.
 * A private question gets a published fact or "Sorry, I can't tell you that.", never "I don't know.", so the reply
 * doesn't depend on whether anything private exists.
 */
export async function answerTurn(deps: TurnDeps, question: string): Promise<Reply> {
  const { tracer, limits } = deps;
  const given = typeof deps.bundle === "function" ? deps.bundle() : deps.bundle;
  const v = given.nodes instanceof Map ? (given as BundleView) : viewOf(given as Bundle);
  const personaName = v.bundle.persona.name;
  const now = deps.now?.() ?? new Date().toISOString();
  const started = Date.now();
  const work: Work = { candidates: [], private: false, seeds: [], context: [], filtered: [], exemplars: 0, rejected: null, checks: { code: null, model: null }, error: null, modelCalls: 0, costUsd: 0, ms: 0 };
  let traceId = "";
  const reply = await tracer.run("ask", { "standin.ask.chars": question.length }, async (run) => {
    traceId = run.traceId;
    const done = (r: Omit<Reply, "work" | "traceId">) => {
      run.setAttributes({ "standin.ask.state": r.state, "standin.ask.reason": r.reason, "standin.ask.private": work.private });
      return r;
    };
    /** No answer: "I can't tell you" for a private question, "I don't know" for anything else. */
    const noAnswer = (reason: NotOnRecordReason) =>
      work.private
        ? done({ text: TEMPLATES.deflected(), state: "deflected", reason: null, cites: [], general: false })
        : done({ text: TEMPLATES.notOnRecord(reason), state: "not_on_record", reason, cites: [], general: false });
    /** A model call that fails ends the turn without an answer, with the error kept in `work`. */
    const call = async <T>(fn: () => Promise<T>): Promise<T | null> => {
      try {
        return await fn();
      } catch (err) {
        work.error = err instanceof Error ? err.message : String(err);
        run.setAttribute("standin.ask.error", work.error);
        return null;
      }
    };

    // 1. Route, and classify: this runs for every question, so every question is classified.
    const cands = candidates(v, question, now, limits.candidates);
    work.candidates = cands.map((c) => c.name);
    // A placed node always has its parent in the bundle, so a node with a root and no parent is a root.
    const listed = cands.map((node) => ({ node, place: node.parent === null && node.root ? "a root" : `in ${node.root ?? "no tree yet"}` }));
    const routed = await call(() => deps.answer.generateObject({ ...buildRoutePrompt(question, listed), schema: RouteSchema, purpose: "route" }));
    if (!routed) return noAnswer("error");
    work.private = routed.private;
    const seedIds = [...new Set(routed.seeds.filter((n) => n >= 1 && n <= cands.length).map((n) => cands[n - 1]!.id))].slice(0, limits.seeds);
    if (seedIds.length === 0) return noAnswer("nothing");

    // 2–3. Awaken.
    const a = await tracer.span("ask.awaken", {}, async () => awaken(v, question, seedIds, { budget: limits.awakenBudget, now }));
    work.seeds = a.seeds;
    work.filtered = a.filtered;

    // 4. The state, decided in code where it can be.
    const items = contextItems(a, v, work.private);
    work.context = items;
    const generalAllowed = !work.private && a.seeds.some((s) => s.knowledge && (s.mode === "explain" || s.mode === "brief"));
    if (items.length === 0 && !generalAllowed) return noAnswer(a.seeds.every((s) => s.knowledge) ? "competence" : "nothing");

    // 5. Speak.
    const canary = canaryToken();
    const examples = exemplars(v.bundle, question, limits.exemplars, limits.exemplarChars);
    work.exemplars = examples.length;
    const out = await call(() =>
      deps.answer.generateObject({
        ...buildSpeakPrompt({ personaName, question, seeds: a.seeds, items, exemplars: examples, canary, generalAllowed }),
        schema: SpeakSchema,
        purpose: "speak",
      }),
    );
    if (!out) return noAnswer("error");
    if (out.state === "not_on_record") return noAnswer("nothing");

    // 6. Check in code. A private question takes a grounded reply or nothing.
    const byId = new Map(items.map((i) => [i.id, i]));
    const reject = (why: string) => {
      work.rejected = out.reply;
      run.setAttribute("standin.ask.rejected", why);
      return noAnswer("check");
    };
    work.checks.code =
      work.private && out.state !== "grounded"
        ? `${out.state} reply to a private question`
        : codeCheck(out, { allowed: new Set(byId.keys()), inferable: items.some((i) => i.kind === "guess" || i.kind === "stance"), generalAllowed, canary });
    if (work.checks.code) return reject(work.checks.code);

    // 7. Check with a model; a failed call counts as a rejection.
    const cited = out.cites.map((id) => byId.get(id)!);
    try {
      work.checks.model = await deps.check.generateObject({ ...buildCheckPrompt({ personaName, reply: out.reply, cited, generalAllowed }), schema: CheckSchema, purpose: "check" });
    } catch (err) {
      work.checks.model = `check failed: ${err instanceof Error ? err.message : String(err)}`;
      return reject(work.checks.model);
    }
    if (!work.checks.model.supported || work.checks.model.unsupported.length > 0) return reject(`unsupported: ${work.checks.model.unsupported.join("; ")}`);

    return done({ text: out.reply, state: out.state, reason: null, cites: cited.map((i) => ({ id: i.id, statement: i.text, node: i.node })), general: out.general });
  });
  const usage = deps.usage?.(traceId);
  work.modelCalls = usage?.modelCalls ?? 0;
  work.costUsd = usage?.costUsd ?? 0;
  work.ms = Date.now() - started;
  return { ...reply, work, traceId };
}
