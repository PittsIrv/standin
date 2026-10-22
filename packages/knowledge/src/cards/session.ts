import type { LLM } from "@standin/llm";
import type { Store } from "@standin/store";
import type { Tracer } from "@standin/trace";
import { answerMode } from "../answer.ts";
import { cells, loadPriors, outcomeOf, probabilityOf } from "../hypotheses/calibrate.ts";
import { expandNode } from "../probing/expand.ts";
import { syncStatedGaps } from "../gaps.ts";
import { computeLighting } from "../lighting.ts";
import { stripContacts, unwrap } from "@standin/intake";
import { MAX_INTRO_STATEMENTS, needsIntro, readSource, saveIntro, skipIntro, type ConfirmedStatement, type IntroSource, type ReadStatement } from "../intro.ts";
import { refresh } from "../refresh.ts";
import { loadSnapshot, type TreeSnapshot } from "../snapshot.ts";
import { statementFor } from "../wording.ts";
import { MIN_PARTS, nextCardTarget } from "./plan.ts";

export interface CardSessionDeps {
  store: Store;
  /** The `map` role's model: refresh at the start, and splitting concepts into parts. */
  map: LLM;
  /** The `hypothesize` role's model, for the refresh at the start; without it, no new guesses. */
  hypothesize?: LLM;
  tracer: Tracer;
  personaName: string;
  splitAt?: number;
  hypotheses?: { speakAt: number; dropBelow: number; dropAfter: number; brierWindow: number };
}

/** A source waiting in the introduction. */
export interface IntroSourceSummary {
  id: string;
  kind: IntroSource["kind"];
  ref: string;
  chars: number;
  contactsRemoved: number;
}

/** What the waiting sources were read into, grouped by source, with counts of what was left out. */
export interface IntroReading {
  groups: { sourceId: string; kind: IntroSource["kind"]; ref: string; statements: ReadStatement[] }[];
  notFound: number;
  sensitive: number;
  contacts: number;
  /** Statements past the limit of 40, not shown. */
  overLimit: number;
}

/** One concept on the screen. */
export interface ShownCard {
  responseId: string;
  nodeId: string;
  topic: string;
  definition: string | null;
  /** What it includes: its examples, or else up to 5 of its parts. */
  examples: string[];
  /** For a guess: why the standin guessed it. */
  why: string | null;
  /** Names from the root down to (not including) the concept. */
  path: string[];
  /** Why it's asked: the standin's guess, a part of something you answered, or an area nobody has asked about. */
  reason: "guess" | "part" | "area";
  /** For a part: the concept it belongs to. */
  parent: string | null;
  parentId: string | null;
  /** Cards answered in this session so far. */
  done: number;
}

export interface ClaimDecision {
  claimNodeId: string;
  topic: string;
  claimed: number;
  /** Parts rated below the claim. */
  lower: { topic: string; level: number }[];
}

export interface FinishReport {
  answered: number;
  /** Guesses this session's answers settled. */
  settled: number;
}

const keepLowerKey = (claimNodeId: string) => `keepLower:${claimNodeId}`;

/**
 * A concept-card session: the stateful API the review page drives (concept-cards spec). The person rates concepts;
 * each answer lights its branch, settles any guess about it (scored against the prediction recorded first), and opens
 * the parts below a middle answer.
 */
export class CardSession {
  readonly warnings: string[] = [];
  private readonly skip = new Set<string>();
  private settledHere = 0;
  private sourceCount = 0;
  private readonly pending = new Map<string, { source: IntroSource; contactsRemoved: number; read: Awaited<ReturnType<typeof readSource>> | null }>();

  private constructor(
    private readonly deps: CardSessionDeps,
    readonly sessionId: string,
  ) {}

  /** Size 0 means no cap: a session runs until nothing is left. */
  readonly size = 0;

  static async start(deps: CardSessionDeps): Promise<CardSession> {
    const { store } = deps;
    const earlier = store.listSessions();
    for (const s of earlier) if (s.endedAt === null) store.endSession(s.id);
    const session = new CardSession(deps, store.startSession(0).id);
    session.resume(earlier.map((s) => s.id));
    await session.traced("start", () => session.refreshTree());
    return session;
  }

  /**
   * Picks up where the last session stopped (review-page spec §3): its latest card, if it was shown and never answered
   * and its concept hasn't been answered since, moves into this session with the prediction made when it was shown.
   */
  private resume(earlier: string[]): void {
    const { store } = this.deps;
    for (const id of earlier.toReversed()) {
      const cards = store.listResponses({ sessionId: id }).filter((r) => r.probe.kind === "card");
      if (cards.length === 0) continue;
      const left = cards.at(-1)!;
      if (left.rating !== null) return;
      const answered = store.listResponses({ rated: true }).some((r) => r.probe.kind === "card" && r.probe.nodeId === left.probe.nodeId);
      if (!answered) store.carryResponse(left.id, this.sessionId);
      return;
    }
  }

  /** Seed, place, home, split, record gaps and guess: a failure is a warning, never the end of the session. */
  private async refreshTree(): Promise<void> {
    const d = this.deps;
    try {
      const report = await refresh({
        store: d.store,
        map: d.map,
        tracer: d.tracer,
        personaName: d.personaName,
        splitAt: d.splitAt,
        hypothesize: d.hypothesize,
        hypotheses: d.hypotheses,
      });
      this.warnings.push(...report.warnings);
    } catch (err) {
      this.warnings.push(`refreshing the tree failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** True while the session should open with the introduction (spec §6a). */
  needsIntro(): boolean {
    return needsIntro(this.deps.store);
  }

  /**
   * Adds a source to the introduction being built (intro-sources spec §3), lines broken mid-sentence joined up. It waits in memory, contact details
   * removed, until the person confirms statements from it; nothing is stored before then.
   */
  addSource(kind: IntroSource["kind"], ref: string, text: string): IntroSourceSummary {
    const { text: clean, removed } = stripContacts(unwrap(text.trim()));
    const source: IntroSource = { id: `src${++this.sourceCount}`, kind, ref, text: clean };
    this.pending.set(source.id, { source, contactsRemoved: removed, read: null });
    return this.summary(source.id);
  }

  removeSource(id: string): void {
    this.pending.delete(id);
  }

  introSources(): IntroSourceSummary[] {
    return [...this.pending.keys()].map((id) => this.summary(id));
  }

  private summary(id: string): IntroSourceSummary {
    const p = this.pending.get(id)!;
    return { id, kind: p.source.kind, ref: p.source.ref, chars: p.source.text.length, contactsRemoved: p.contactsRemoved };
  }

  /** Every waiting source read into statements for the person to confirm (each source is read once). Nothing is stored. */
  async readSources(): Promise<IntroReading> {
    return this.traced("intro.read", async () => {
      const groups: IntroReading["groups"] = [];
      let notFound = 0;
      let sensitive = 0;
      let contacts = 0;
      let shown = 0;
      let overLimit = 0;
      for (const p of this.pending.values()) {
        p.read ??= await readSource(this.deps.map, p.source, this.deps.personaName);
        const room = Math.max(0, MAX_INTRO_STATEMENTS - shown);
        const statements = p.read.statements.slice(0, room);
        shown += statements.length;
        overLimit += p.read.statements.length - statements.length;
        groups.push({ sourceId: p.source.id, kind: p.source.kind, ref: p.source.ref, statements });
        notFound += p.read.notFound;
        sensitive += p.read.sensitive;
        contacts += p.contactsRemoved;
      }
      return { groups, notFound, sensitive, contacts, overLimit };
    });
  }

  /** Stores the confirmed statements as background, clears the waiting sources, and refreshes so their guesses come next. */
  async introduce(statements: ConfirmedStatement[]): Promise<{ saved: number; dropped: string[] }> {
    return this.traced("intro.save", async () => {
      const { saved, dropped } = saveIntro(this.deps.store, [...this.pending.values()].map((p) => p.source), statements);
      if (saved.length > 0) {
        this.pending.clear();
        await this.refreshTree();
      }
      return { saved: saved.length, dropped };
    });
  }

  skipIntro(): void {
    skipIntro(this.deps.store);
  }

  private snapshot(): TreeSnapshot {
    return loadSnapshot(this.deps.store, { brierWindow: this.deps.hypotheses?.brierWindow });
  }

  private answeredHere(): number {
    return this.deps.store.listResponses({ sessionId: this.sessionId, rated: true }).length;
  }

  private shown(responseId: string, t: TreeSnapshot = this.snapshot()): ShownCard {
    const { store } = this.deps;
    const r = store.getResponse(responseId);
    const probe = store.getProbe(r.probeId);
    const node = store.getTopic(probe.nodeId);
    const path: string[] = [];
    const seen = new Set<string>();
    for (let at = t.parentOf.get(node.id); at && !seen.has(at); at = t.parentOf.get(at)) {
      seen.add(at);
      path.unshift(t.all.get(at)?.name ?? store.getTopic(at).name);
    }
    const parent = probe.checkOf ? store.getTopic(probe.checkOf) : null;
    const parts = [...t.parentOf]
      .filter(([c, p]) => p === node.id && t.all.has(c))
      .map(([c]) => t.all.get(c)!.name)
      .sort((a, b) => a.localeCompare(b));
    return {
      responseId,
      nodeId: node.id,
      topic: node.name,
      definition: node.definition,
      examples: node.examples.length > 0 ? node.examples : parts.slice(0, 5),
      why: probe.hypothesisId ? store.getHypothesis(probe.hypothesisId).reason : null,
      path,
      reason: probe.hypothesisId ? "guess" : parent ? "part" : "area",
      parent: parent?.name ?? null,
      parentId: parent?.id ?? null,
      done: this.answeredHere(),
    };
  }

  /** The card shown and not yet answered (a reload shows it again), or null. A part whose parent was skipped is dropped. */
  current(): ShownCard | null {
    const { store } = this.deps;
    const skipped = (nodeId: string) => {
      const seen = new Set<string>();
      for (let at = store.homeParent(nodeId); at && !seen.has(at); at = store.homeParent(at)) {
        if (store.getTopic(at).walkStopped) return true;
        seen.add(at);
      }
      return false;
    };
    const open = store.listResponses({ sessionId: this.sessionId }).findLast((r) => r.rating === null && !(r.probe.checkOf && skipped(r.probe.nodeId)));
    return open ? this.shown(open.id) : null;
  }

  /** The next card, with the standin's prediction stored before it is shown. Null when nothing is left. */
  async next(): Promise<ShownCard | null> {
    const { store } = this.deps;
    return this.traced("next", async () => {
      for (let guard = 0; guard < 50; guard++) {
        const t = this.snapshot();
        const responses = store.listResponses({ rated: true }).filter((r) => r.probe.kind === "card");
        const target = nextCardTarget(
          t,
          { answered: new Set(responses.map((r) => r.probe.nodeId)), guessesAnswered: new Set(responses.map((r) => r.probe.hypothesisId).filter((x) => x !== null)) },
          this.skip,
        );
        if (target === null) return null;
        if (typeof target === "string") {
          const nodeId = target.slice("expand:".length);
          try {
            await expandNode(store, this.deps.map, nodeId, this.deps.personaName);
          } catch (err) {
            this.warnings.push(`expanding ${t.topics.get(nodeId)?.name ?? nodeId} failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          this.skip.add(target);
          continue;
        }
        const node = t.topics.get(target.nodeId)!;
        const guess = target.kind === "guess" ? t.hypotheses.get(target.nodeId) : undefined;
        const probe = store.insertProbe({
          nodeId: target.nodeId,
          checkOf: target.kind === "part" ? target.parentId : null,
          kind: "card",
          difficulty: Math.max(1, node.partLevel ?? 1),
          question: node.definition ?? node.name,
          holdout: "none",
          hypothesisId: target.kind === "guess" ? target.hypothesisId : null,
        });
        // Predict, then learn: what the standin would say, and how sure it was of a guess, before the answer.
        const mode = answerMode(t, target.nodeId, { speakAt: this.deps.hypotheses?.speakAt }).mode;
        const priorP = guess ? probabilityOf({ kind: guess.kind as never, rawScore: guess.rawScore as never }, cells(store, loadPriors(store)), { safeguard: true }) : null;
        const response = store.showProbe(probe.id, this.sessionId, mode, guess && priorP !== null ? { predictedP: guess.p, priorP } : undefined);
        return this.shown(response.id, t);
      }
      return null;
    });
  }

  /** Records an answer: a level 0–4 lights the branch; "wouldn't say" sets a boundary. Settles any guess about it. */
  answer(responseId: string, answer: number | "wouldnt_say"): void {
    const { store } = this.deps;
    if (answer !== "wouldnt_say" && (!Number.isInteger(answer) || answer < 0 || answer > 4)) throw new RangeError("an answer is a level from 0 to 4");
    const response = store.answerCard(responseId, answer);
    const probe = store.getProbe(response.probeId);
    if (answer === "wouldnt_say") store.setTopic(probe.nodeId, { boundaryTier: 3 });
    // Lighting a branch must not override what the person said they don't know inside it: carve that out now.
    const t = this.snapshot();
    syncStatedGaps(store, t, computeLighting(t));
    if (!probe.hypothesisId) return;
    const h = store.getHypothesis(probe.hypothesisId);
    if (h.status !== "open") return;
    if (answer === "wouldnt_say") {
      store.withdrawHypothesis(h.id);
      return;
    }
    if (outcomeOf(h, store.listResponses({ rated: true })) !== null) {
      store.settleHypothesis(h.id);
      this.settledHere++;
    }
  }

  /** "That's enough here": nothing more under this concept is asked. */
  skipRest(parentId: string): void {
    this.deps.store.setTopic(parentId, { walkStopped: true });
  }

  /**
   * A claim whose parts are all answered (or whose walk was stopped), with some part rated below it, and no decision
   * since the latest such answer (concept-cards spec §5).
   */
  keepLowerDue(): ClaimDecision | null {
    const { store } = this.deps;
    const t = this.snapshot();
    const stated = store.stateds();
    const answered = new Set(store.listResponses({ rated: true }).filter((r) => r.probe.kind === "card").map((r) => r.probe.nodeId));
    for (const [claimNodeId, claimed] of [...t.claims].sort(([a], [b]) => a.localeCompare(b))) {
      if (claimed < 1 || claimed > 3 || t.stated.has(claimNodeId)) continue;
      const parts = [...t.parentOf].filter(([c, p]) => p === claimNodeId && t.topics.has(c)).map(([c]) => c);
      const qualifying = parts.filter((c) => (t.topics.get(c)!.partLevel ?? 2) <= claimed + 1);
      if (qualifying.length < MIN_PARTS) continue;
      const stopped = t.topics.get(claimNodeId)!.walkStopped;
      if (!stopped && !qualifying.every((c) => answered.has(c))) continue;
      const lower = qualifying.filter((c) => (stated.get(c)?.level ?? claimed) < claimed);
      if (lower.length === 0) continue;
      const latest = lower.map((c) => stated.get(c)!.answeredAt).sort().at(-1)!;
      const decided = store.getKv(keepLowerKey(claimNodeId));
      if (decided && decided >= latest) continue;
      return {
        claimNodeId,
        topic: t.topics.get(claimNodeId)!.name,
        claimed,
        lower: lower.map((c) => ({ topic: t.topics.get(c)!.name, level: stated.get(c)!.level })),
      };
    }
    return null;
  }

  /** Keep: the claim stands, its lower parts carved out by their own answers. Lower: the claim drops to the lowest part. */
  decideClaim(claimNodeId: string, choice: "keep" | "lower"): void {
    const { store } = this.deps;
    const due = this.keepLowerDue();
    store.transaction(() => {
      if (choice === "lower" && due && due.claimNodeId === claimNodeId) {
        const t = this.snapshot();
        const topic = t.topics.get(claimNodeId)!;
        const previous = t.approved.get(claimNodeId);
        const depth = Math.min(...due.lower.map((l) => l.level));
        const lowered = store.insertMemory(
          {
            kind: "competence",
            statement: statementFor(depth, topic.name),
            tier: previous ? store.getMemory(previous.memoryId).tier : 1,
            isCurrentState: false,
            attrs: { domain: topic.name, depth, basis: "probed", reasons: [`you lowered your claim after rating ${due.lower.map((l) => l.topic).join(", ")} lower`] },
            supersedesId: previous?.memoryId ?? null,
          },
          { sourceObservationIds: [], entityIds: [claimNodeId], actor: "person", homeNodeId: claimNodeId },
        );
        store.approve(lowered.id);
      }
      store.setKv(keepLowerKey(claimNodeId), store.nowIso());
    });
  }

  boundaries(): { nodeId: string; topic: string }[] {
    return this.deps.store
      .listTopics()
      .filter((t) => t.boundaryTier !== null)
      .map((t) => ({ nodeId: t.id, topic: t.name }))
      .sort((a, b) => a.topic.localeCompare(b.topic));
  }

  undoBoundary(nodeId: string): void {
    this.deps.store.setTopic(nodeId, { boundaryTier: null });
  }

  async finish(): Promise<FinishReport> {
    return this.traced("finish", async () => {
      const answered = this.answeredHere();
      this.deps.store.endSession(this.sessionId);
      return { answered, settled: this.settledHere };
    });
  }

  private traced<T>(step: string, fn: () => Promise<T>): Promise<T> {
    return this.deps.tracer.run("review", { "standin.review.session": this.sessionId, "standin.review.step": step }, () => fn());
  }
}
