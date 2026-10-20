import type { LLM } from "@standin/llm";
import type { Probe, ProbeKind, Rating } from "@standin/schema";
import type { Store } from "@standin/store";
import type { Tracer } from "@standin/trace";
import { answerMode } from "../answer.ts";
import { refresh } from "../refresh.ts";
import { loadSnapshot } from "../snapshot.ts";
import { statementFor } from "../wording.ts";
import { expandNode } from "./expand.ts";
import { collectGrades, submitGrades } from "./grade.ts";
import { nextTarget, type ProbeState, type Target } from "./plan.ts";
import { writeProbes } from "./quiz.ts";

export interface SessionDeps {
  store: Store;
  map: LLM;
  quiz: LLM;
  grade: LLM;
  tracer: Tracer;
  rng: () => number;
  personaName: string;
  /** Probes this session; defaults to 40 for the very first session and 10 after. */
  size?: number;
}

export interface ShownProbe {
  responseId: string;
  nodeId: string;
  topic: string;
  question: string;
  difficulty: number;
  kind: ProbeKind;
  /** Probes shown so far this session, this one included. */
  done: number;
  total: number;
}

export interface FinishReport {
  released: number;
  exemplars: number;
  discoveryProposals: number;
  gradingSubmitted: number;
}

export interface Miss {
  responseId: string;
  topic: string;
  question: string;
  difficulty: number;
  reason: "no_idea" | "failed_check";
}

export interface ClaimDecision {
  claimNodeId: string;
  topic: string;
  claimed: number;
  gaps: { topic: string; level: number }[];
}

export const FIRST_SESSION_SIZE = 40;
export const SESSION_SIZE = 10;
export const SPOT_CHECK_RATE = 1 / 3;

/** A held-out probe may feed the map, exemplars and discovery only once released; a fixed one never. */
export const usable = (p: Probe): boolean => p.holdout === "none" || (p.holdout === "rotating" && p.releasedAt !== null);

/**
 * One review session: the stateful API the review page drives. It owns the holdout rules: predictions are
 * recorded before ratings, held-out answers stay out of the map until released, and fixed ones never get in.
 */
export class ProbeSession {
  readonly warnings: string[] = [];
  private readonly skip = new Set<string>();

  private constructor(
    private readonly deps: SessionDeps,
    readonly sessionId: string,
    readonly size: number,
  ) {}

  static async start(deps: SessionDeps): Promise<ProbeSession> {
    const { store } = deps;
    const firstEver = store.listSessions().length === 0;
    const size = deps.size ?? (firstEver ? FIRST_SESSION_SIZE : SESSION_SIZE);
    const session = new ProbeSession(deps, store.startSession(size).id, size);
    await session.traced("start", async () => {
      const unfinished = store.listSessions().filter((s) => s.endedAt === null && s.id !== session.sessionId);
      session.releaseAndDefer(unfinished.map((s) => s.id));
      for (const s of unfinished) store.endSession(s.id);
      await session.attempt("collecting grades", () => collectGrades(store, deps.grade));
      await session.attempt("refreshing the tree", async () => {
        const report = await refresh({ store, map: deps.map, tracer: deps.tracer, personaName: deps.personaName });
        session.warnings.push(...report.warnings);
      });
    });
    return session;
  }

  /** The next probe, with the standin's prediction stored before it is returned. Null when the session is done. */
  async next(): Promise<ShownProbe | null> {
    const { store } = this.deps;
    const shownHere = store.listResponses({ sessionId: this.sessionId }).length;
    if (shownHere >= this.size) return null;
    return this.traced("next", async () => {
      for (let guard = 0; guard < 50; guard++) {
        const t = loadSnapshot(store);
        const target = nextTarget(t, this.state(), this.skip);
        if (target === null) return null;
        if (typeof target === "string") {
          const nodeId = target.slice("expand:".length);
          const ok = await this.attempt(`expanding ${t.topics.get(nodeId)?.name ?? nodeId}`, () =>
            expandNode(store, this.deps.map, nodeId, this.deps.personaName),
          );
          if (!ok) this.skip.add(target);
          continue;
        }
        const probe = await this.probeFor(target);
        if (!probe) {
          this.skip.add(`${target.kind}:${target.nodeId}`);
          continue;
        }
        const mode = answerMode(t, target.nodeId).mode;
        const response = store.showProbe(probe.id, this.sessionId, mode);
        return {
          responseId: response.id,
          nodeId: target.nodeId,
          topic: t.topics.get(target.nodeId)!.name,
          question: probe.question,
          difficulty: probe.difficulty,
          kind: probe.kind,
          done: shownHere + 1,
          total: this.size,
        };
      }
      return null;
    });
  }

  /** Records a rating. `know`/`roughly` may ask for a one-line spot-check; `wouldnt_say` sets a boundary at once. */
  rate(responseId: string, rating: Rating): { spotCheck: boolean } {
    const { store, rng } = this.deps;
    const probe = store.getProbe(store.getResponse(responseId).probeId);
    const spotCheck = (rating === "know" || rating === "roughly") && rng() < SPOT_CHECK_RATE;
    store.rateResponse(responseId, rating, spotCheck);
    if (rating === "wouldnt_say") store.setTopic(probe.nodeId, { boundaryTier: 3 });
    if (probe.kind === "followup") this.settleGap(probe, rating);
    return { spotCheck };
  }

  /** Misses the person may judge: `no_idea`, or `know` with a failed spot-check, on claim and foundation probes. */
  pendingMisses(): Miss[] {
    const { store } = this.deps;
    return store
      .listResponses({ rated: true })
      .filter((r) => r.judged === null && (r.probe.kind === "claim" || r.probe.kind === "foundation") && usable(r.probe))
      .filter((r) => r.rating === "no_idea" || (r.rating === "know" && r.grade === "fail"))
      .map((r) => ({
        responseId: r.id,
        topic: store.getTopic(r.probe.nodeId).name,
        question: r.probe.question,
        difficulty: r.probe.difficulty,
        reason: r.rating === "no_idea" ? ("no_idea" as const) : ("failed_check" as const),
      }));
  }

  /**
   * The person's verdict on a miss. A gap is recorded at one level below the missed probe for now; the follow-up
   * probe a level lower settles it. A miss at level 1 has nothing below it, so its gap is recorded at 0.
   */
  judgeMiss(responseId: string, isGap: boolean): void {
    const { store } = this.deps;
    const probe = store.getProbe(store.getResponse(responseId).probeId);
    store.judgeResponse(responseId, isGap ? "gap" : "not_gap");
    if (!isGap) return;
    store.addGap({
      nodeId: probe.nodeId,
      claimNodeId: probe.kind === "claim" ? probe.checkOf : null,
      level: Math.max(probe.difficulty - 1, 0),
      status: probe.kind === "claim" ? "open" : "kept",
      source: "probe",
      memoryId: null,
      responseId,
    });
  }

  /** Claims whose confirmed gaps are settled and waiting for the person to keep or lower them. */
  pendingClaimDecisions(): ClaimDecision[] {
    const { store } = this.deps;
    const t = loadSnapshot(store);
    const open = t.gaps.filter((g) => g.status === "open" && g.claimNodeId && g.source === "probe");
    const decisions: ClaimDecision[] = [];
    for (const claimNodeId of new Set(open.map((g) => g.claimNodeId!))) {
      const gaps = open.filter((g) => g.claimNodeId === claimNodeId);
      if (!gaps.every((g) => this.settled(g.responseId))) continue;
      decisions.push({
        claimNodeId,
        topic: t.topics.get(claimNodeId)?.name ?? claimNodeId,
        claimed: t.approved.get(claimNodeId)?.depth ?? 0,
        gaps: gaps.map((g) => ({ topic: t.topics.get(g.nodeId)?.name ?? g.nodeId, level: g.level })),
      });
    }
    return decisions;
  }

  /** Keep: the claim stands except its gaps. Lower: the claim drops to its lowest gap level (the person's own decision). */
  decideClaim(claimNodeId: string, choice: "keep" | "lower"): void {
    const { store } = this.deps;
    store.transaction(() => {
      const t = loadSnapshot(store);
      const gaps = t.gaps.filter((g) => g.status === "open" && g.claimNodeId === claimNodeId);
      for (const g of gaps) store.setGap(g.id, { status: choice === "keep" ? "kept" : "lowered" });
      if (choice === "keep" || gaps.length === 0) return;
      const topic = t.topics.get(claimNodeId)!;
      const previous = t.approved.get(claimNodeId);
      const depth = Math.min(...gaps.map((g) => g.level));
      const lowered = store.insertMemory(
        {
          kind: "competence",
          statement: statementFor(depth, topic.name),
          tier: previous ? store.getMemory(previous.memoryId).tier : 1,
          isCurrentState: false,
          attrs: { domain: topic.name, depth, basis: "probed", reasons: [`you lowered your claim after gaps in ${gaps.map((g) => t.topics.get(g.nodeId)?.name).join(", ")}`] },
          supersedesId: previous?.memoryId ?? null,
        },
        { sourceObservationIds: [], entityIds: [claimNodeId], actor: "person" },
      );
      store.approve(lowered.id);
    });
  }

  /** A spot-check answer: kept as a probe observation; a voice sample now only if the probe isn't held out. */
  answer(responseId: string, text: string): void {
    const { store } = this.deps;
    const probe = store.getProbe(store.getResponse(responseId).probeId);
    const o = store.addObservation({
      sourceKind: "probe",
      sourceRef: `probe:${probe.id}`,
      authorRole: "self",
      text: `Q: ${probe.question}\n\nA: ${text.trim()}`,
      occurredAt: store.nowIso(),
    });
    store.markCompacted(o.id, "processed");
    store.answerSpotCheck(responseId, text, o.id);
    if (probe.holdout === "none") store.insertExemplar({ observationId: o.id, text: text.trim(), register: "casual" });
  }

  undoBoundary(nodeId: string): void {
    this.deps.store.setTopic(nodeId, { boundaryTier: null });
  }

  async finish(): Promise<FinishReport> {
    const { store } = this.deps;
    return this.traced("finish", async () => {
      const { released, exemplars } = this.releaseAndDefer([this.sessionId]);
      let gradingSubmitted = 0;
      await this.attempt("submitting grades", async () => {
        const g = await submitGrades(store, this.deps.grade, this.deps.personaName);
        gradingSubmitted = g.submitted + g.gradedLive;
      });
      store.endSession(this.sessionId);
      return { released, exemplars, discoveryProposals: 0, gradingSubmitted };
    });
  }

  // ---- internals ------------------------------------------------------------

  /** The follow-up for a gap sets its level: one below the miss if known, two below if missed too. */
  private settleGap(followup: Probe, rating: Rating): void {
    const { store } = this.deps;
    const gap = store
      .listGaps()
      .find((g) => g.responseId && g.nodeId === followup.nodeId && store.getProbe(store.getResponse(g.responseId).probeId).difficulty === followup.difficulty + 1);
    if (!gap) return;
    const level = rating === "know" || rating === "roughly" ? followup.difficulty : Math.max(followup.difficulty - 1, 0);
    store.setGap(gap.id, { level });
  }

  /** A gap is settled once its follow-up is rated, or immediately when the miss was at level 1. */
  private settled(responseId: string | null): boolean {
    if (!responseId) return true;
    const { store } = this.deps;
    const missed = store.getResponse(responseId);
    const probe = store.getProbe(missed.probeId);
    if (probe.difficulty < 2) return true;
    // In show order; timestamps can tie within a second.
    const all = store.listResponses();
    const after = all.slice(all.findIndex((r) => r.id === responseId) + 1);
    return after.some(
      (r) => r.rating !== null && r.probe.kind === "followup" && r.probe.nodeId === probe.nodeId && r.probe.difficulty === probe.difficulty - 1,
    );
  }

  private state(): ProbeState {
    const { store } = this.deps;
    const children = new Map<string, string[]>();
    for (const e of store.listEdges("part_of")) children.set(e.to, [...(children.get(e.to) ?? []), e.from]);
    return { responses: store.listResponses(), children };
  }

  /** An unshown probe for the target, written on demand (one `quiz` call) when none exists. */
  private async probeFor(target: Target): Promise<Probe | null> {
    const { store } = this.deps;
    const checkOf = target.kind === "claim" || target.kind === "followup" ? target.checkOf : null;
    const shown = new Set(store.listResponses().map((r) => r.probeId));
    const fits = (p: Probe) => p.kind === target.kind && p.difficulty === target.difficulty && p.checkOf === checkOf && !shown.has(p.id);
    const existing = store.listProbes({ nodeId: target.nodeId }).find(fits);
    if (existing) return existing;
    const written = await this.attempt(`writing a probe for ${store.getTopic(target.nodeId).name}`, () =>
      writeProbes(store, this.deps.quiz, {
        nodeId: target.nodeId,
        difficulty: target.difficulty,
        kind: target.kind,
        checkOf,
        count: 1,
        rng: this.deps.rng,
        personaName: this.deps.personaName,
      }),
    );
    return written?.[0] ?? null;
  }

  /** Releases rotating probes answered in these sessions and creates the voice samples they were holding back. */
  private releaseAndDefer(sessionIds: string[]): { released: number; exemplars: number } {
    const { store } = this.deps;
    const released = store.releaseRotating(sessionIds);
    const ids = new Set(released.map((p) => p.id));
    let exemplars = 0;
    for (const r of store.listResponses().filter((x) => ids.has(x.probeId) && x.spotCheckAnswer && x.observationId)) {
      if (store.insertExemplar({ observationId: r.observationId!, text: r.spotCheckAnswer!, register: "casual" })) exemplars++;
    }
    return { released: released.length, exemplars };
  }

  /** Runs a model step; a failure becomes a warning and the session goes on. */
  private async attempt<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (err) {
      this.warnings.push(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private traced<T>(step: string, fn: () => Promise<T>): Promise<T> {
    return this.deps.tracer.run("review", { "standin.review.session": this.sessionId, "standin.review.step": step }, () => fn());
  }
}
