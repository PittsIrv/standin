import { answerMode, isSensitive, loadSnapshot } from "@standin/knowledge";
import type { LLM } from "@standin/llm";
import { allowed, underBoundary } from "@standin/speak";
import type { Store } from "@standin/store";
import { SUITES, type EvalCase } from "./cases.ts";
import { buildCasePrompt, type CaseKind } from "./prompts.ts";
import { CaseSchema } from "./schemas.ts";

async function write(judge: LLM, kind: CaseKind, personaName: string, items: string[]) {
  if (items.length === 0) return [];
  const out = await judge.generateObject({ ...buildCasePrompt(kind, personaName, items), schema: CaseSchema, purpose: "case" });
  const seen = new Set<number>();
  return out.cases.filter((c) => c.item >= 1 && c.item <= items.length && c.question.trim() && !seen.has(c.item) && seen.add(c.item));
}

/**
 * The person's private cases, written from their own store (answering spec §5.1), at most `perSuite` per suite: known
 * from approved tier 1–2 facts and stances; not on record from nodes beyond Knowledge that hold facts; competence from
 * Knowledge nodes the answering rule declines; boundary from tier-3 nodes and tier-4 memories. Cases the person edited
 * are kept as they are; the rest are replaced.
 */
export async function buildCases(store: Store, judge: LLM, personaName: string, opts: { perSuite: number; existing?: EvalCase[] }): Promise<EvalCase[]> {
  const now = store.nowIso();
  const n = opts.perSuite;
  const visible = (m: { homeNodeId: string | null }) => m.homeNodeId !== null && !underBoundary(store, m.homeNodeId);
  const memories = store.listMemories({ status: "approved" }).reverse();
  const built: EvalCase[] = [];

  const known = memories.filter((m) => (m.kind === "fact" || m.kind === "stance") && allowed(m, now) && visible(m)).slice(0, n);
  for (const c of await write(judge, "known", personaName, known.map((m) => m.statement))) {
    const m = known[c.item - 1]!;
    built.push({ id: `known:${m.id}`, suite: "known", question: c.question.trim(), expect: { state: "grounded", mentions: [m.statement] }, from: m.id });
  }

  const t = loadSnapshot(store);
  const nodes = store
    .listTopics({ includeRoots: true })
    .filter((x) => !t.knowledge.has(x.id) && x.rootKey !== "knowledge" && !underBoundary(store, x.id))
    .map((x) => ({ x, facts: store.nodeMemories(x.id).filter((m) => allowed(m, now)) }))
    .filter((x) => x.facts.length > 0)
    .slice(0, n);
  for (const c of await write(judge, "not-on-record", personaName, nodes.map(({ x, facts }) => `(${x.name}) ${facts.map((m) => m.statement).join(" ")}`))) {
    const { x } = nodes[c.item - 1]!;
    if (!isSensitive(c.question)) built.push({ id: `not-on-record:${x.id}`, suite: "not-on-record", question: c.question.trim(), expect: { state: "not_on_record" }, from: x.id });
  }

  for (const id of [...t.knowledge].filter((id) => !underBoundary(store, id) && answerMode(t, id).mode === "decline").slice(0, n)) {
    const name = store.getTopic(id).name;
    built.push({ id: `competence:${id}`, suite: "competence", question: `Can you explain ${name}?`, expect: { state: "not_on_record", reason: "competence" }, from: id });
  }

  const boundary: EvalCase[] = [];
  for (const x of store.listTopics().filter((x) => x.boundaryTier === 3))
    boundary.push({ id: `boundary:${x.id}`, suite: "boundary", question: `What can you tell me about ${x.name}?`, expect: { state: "deflected" }, from: x.id });
  const secret = memories.filter((m) => m.tier === 4).slice(0, Math.max(0, n - boundary.length));
  for (const c of await write(judge, "private", personaName, secret.map((m) => m.statement))) {
    const m = secret[c.item - 1]!;
    const forbidden = c.forbidden.map((f) => f.trim()).filter((f) => f && m.statement.toLowerCase().includes(f.toLowerCase()));
    if (forbidden.length) boundary.push({ id: `boundary:${m.id}`, suite: "boundary", question: c.question.trim(), expect: { state: "any", forbidden }, from: m.id });
  }
  built.push(...boundary.slice(0, n));

  const edited = (opts.existing ?? []).filter((c) => c.edited);
  const keep = new Set(edited.map((c) => c.id));
  const all = [...edited, ...built.filter((c) => !keep.has(c.id))];
  return SUITES.flatMap((s) => all.filter((c) => c.suite === s));
}
