import type { LLM } from "@standin/llm";
import { normalizeName, type Store } from "@standin/store";
import { answerMode } from "../answer.ts";
import { buildHypothesizePrompt } from "../prompts.ts";
import { HypothesizeSchema } from "../schemas.ts";
import { loadSnapshot, type TreeSnapshot } from "../snapshot.ts";
import { cellKey, cells, loadPriors } from "./calibrate.ts";
import { checkHypothesis, established } from "./guards.ts";

const LAST_RUN = "hypothesize.lastRun";

export interface HypothesizeReport {
  added: number;
  withdrawn: number;
  /** "<node>: <why>" for every guess the guards or the reliability counts refused. */
  rejected: string[];
}

/** Has anything the guesses depend on changed since the last run? */
function changedSince(store: Store, since: string | null): boolean {
  if (since === null) return true;
  return (
    store.listMemories().some((m) => (m.decidedAt ?? "") > since) ||
    store.listResponses({ rated: true }).some((r) => (r.answeredAt ?? "") > since) ||
    store.listHypotheses().some((h) => (h.settledAt ?? h.createdAt) > since)
  );
}

/** The Knowledge subtree, one node per line, each with what is on record for it. */
function knowledgeOutline(t: TreeSnapshot): string {
  const state = (id: string) => {
    if (t.claims.has(id)) return `claimed ${t.claims.get(id)}`;
    if (t.approved.get(id)?.basis === "probed") return `probed ${t.approved.get(id)!.depth}`;
    if (t.confirmedHypotheses.has(id)) return `confirmed ${t.confirmedHypotheses.get(id)}`;
    const gap = t.gaps.find((g) => g.nodeId === id);
    if (gap) return `gap: fine up to ${gap.level}`;
    if (t.seeded.has(id)) return "seeded from background";
    const guess = t.hypotheses.get(id);
    if (guess) return `open guess ${guess.depth}`;
    const d = answerMode(t, id);
    return d.from?.via === "inherited" ? `inherits ${d.depth}` : "unknown";
  };
  return [...t.topics.values()]
    .map((n) => {
      const parent = t.parentOf.get(n.id);
      return `- ${n.name} [${state(n.id)}]${parent && t.topics.has(parent) ? ` (part of: ${t.topics.get(parent)!.name})` : ""}`;
    })
    .join("\n");
}

/**
 * One `hypothesize` call, incremental: guesses are checked by the guards (spec §4.2) and dropped when their evidence
 * cell keeps failing; an unchanged guess is kept, a changed depth replaces the old one, and `withdraw` retires guesses.
 * No call when nothing changed since the last run, or when nothing is established to reason from.
 */
export async function hypothesize(
  store: Store,
  model: LLM,
  personaName: string,
  cfg: { dropBelow: number; dropAfter: number },
): Promise<HypothesizeReport> {
  const report: HypothesizeReport = { added: 0, withdrawn: 0, rejected: [] };
  const t = loadSnapshot(store);
  if (![...t.topics.keys()].some((id) => established(t, id))) return report;
  if (!changedSince(store, store.getKv(LAST_RUN))) return report;

  const reliability = cells(store, loadPriors(store));
  const facts = store
    .listMemories({ status: "approved", kind: "fact" })
    .filter((m) => m.kind === "fact" && (m.attrs.background === true || (m.homeNodeId !== null && store.rootOf(m.homeNodeId) === "work")))
    .map((m) => m.statement);
  const open = store.listHypotheses({ status: "open" });
  const name = (id: string) => t.all.get(id)?.name ?? id;
  const out = await model.generateObject({
    ...buildHypothesizePrompt({
      tree: knowledgeOutline(t),
      facts,
      open: open.map((h) => `${name(h.nodeId)} at ${h.depth} (${h.kind}): ${h.reason}`),
      cells: [...reliability].map(([key, c]) => `${key} → ${c.p.toFixed(2)} (${c.confirmed + c.refuted} outcomes)`),
      personaName,
    }),
    schema: HypothesizeSchema,
    purpose: "hypothesize",
  });

  const byName = new Map<string, string>();
  for (const n of t.topics.values()) for (const alias of [n.name, ...n.aliases]) byName.set(normalizeName(alias), n.id);
  const edges = store.listEdges();
  store.transaction(() => {
    for (const g of out.hypotheses) {
      const nodeId = byName.get(normalizeName(g.node));
      const path = g.path.map((p) => byName.get(normalizeName(p)));
      if (!nodeId || path.some((p) => p === undefined)) {
        report.rejected.push(`${g.node}: unknown node in the guess or its path`);
        continue;
      }
      const why = checkHypothesis(t, { nodeId, depth: g.depth, path: path as string[], reason: g.reason }, edges);
      if (why) {
        report.rejected.push(`${g.node}: ${why}`);
        continue;
      }
      const cell = reliability.get(cellKey(g.kind, g.rawScore));
      if (cell && cell.confirmed + cell.refuted >= cfg.dropAfter && cell.p < cfg.dropBelow) {
        report.rejected.push(`${g.node}: ${g.kind}:${g.rawScore} guesses have been unreliable (${cell.p.toFixed(2)})`);
        continue;
      }
      const current = store.listHypotheses({ nodeId, status: "open" });
      if (current.some((h) => h.depth === g.depth)) continue;
      for (const h of current) {
        store.withdrawHypothesis(h.id);
        report.withdrawn++;
      }
      store.insertHypothesis({ nodeId, depth: g.depth, rawScore: g.rawScore, kind: g.kind, path: path as string[], reason: g.reason });
      report.added++;
    }
    for (const w of out.withdraw) {
      const nodeId = byName.get(normalizeName(w));
      for (const h of nodeId ? store.listHypotheses({ nodeId, status: "open" }) : []) {
        store.withdrawHypothesis(h.id);
        report.withdrawn++;
      }
    }
    store.setKv(LAST_RUN, store.nowIso());
  });
  return report;
}
