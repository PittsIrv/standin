import { describe, expect, it, vi } from "vitest";
import { compact } from "../src/index.ts";
import { config, extraction, obs, script, tempStore } from "./helpers.ts";

describe("compact", () => {
  it("skips exposed observations without calling the model", async () => {
    const { store } = tempStore();
    const o = store.addObservation(obs("Channel announcement: lab meeting moved.", { authorRole: "exposed", sourceKind: "slack" }));
    const llm = script({});
    const report = await compact({ store, llm, config });
    expect(report.skippedExposed).toBe(1);
    expect(llm.calls).toHaveLength(0);
    expect(store.getObservation(o.id).compactionResult).toBe("skipped_exposed");
  });

  it("creates proposed memories linked to sources and entities", async () => {
    const { store } = tempStore();
    const o = store.addObservation(obs("I built Dealer's Choice, a platform for poker variants."));
    const llm = script({
      [o.text!]: extraction([
        { statement: "I built Dealer's Choice.", entities: [{ name: "Dealer's Choice", kind: "project" }] },
        { kind: "competence", statement: "I know poker game theory well.", competence: { domain: "poker game theory", depth: 9 } },
      ]),
    });
    const report = await compact({ store, llm, config });
    expect(report).toMatchObject({ processed: 1, created: 2, failed: [] });
    const built = store.listMemories().find((m) => m.kind === "fact");
    const comp = store.listMemories().find((m) => m.kind === "competence");
    expect(built!.status).toBe("proposed");
    expect(store.memorySources(built!.id).map((x) => x.id)).toEqual([o.id]);
    expect(store.memoryEntities(built!.id).map((e) => e.name)).toEqual(["Dealer's Choice"]);
    expect(comp!.attrs).toEqual({ domain: "poker game theory", depth: 4 });
    expect(store.getObservation(o.id).compactionResult).toBe("processed");
  });

  it("drops candidates whose kind-specific attributes are missing", async () => {
    const { store } = tempStore();
    const o = store.addObservation(obs("I have opinions."));
    const llm = script({ [o.text!]: extraction([{ kind: "stance", statement: "I have opinions.", stance: null }]) });
    const report = await compact({ store, llm, config });
    expect(report.created).toBe(0);
    expect(report.invalidCandidates).toBe(1);
  });

  it("corroborates duplicates instead of creating new memories", async () => {
    const { store } = tempStore();
    const a = store.addObservation(obs("I love poker."));
    const b = store.addObservation(obs("poker night again, love it", { sourceKind: "slack", occurredAt: "2026-09-02T00:00:00.000Z" }));
    const llm = script(
      {
        [a.text!]: extraction([{ statement: "I love poker." }]),
        [b.text!]: extraction([{ statement: "I love poker!" }]),
      },
      (_c, neighbors) => ({ action: "duplicate", targetId: neighbors[0]!, reason: "same" }),
    );
    const report = await compact({ store, llm, config });
    expect(report).toMatchObject({ created: 1, corroborated: 1 });
    const [m] = store.listMemories();
    expect(store.memorySources(m!.id)).toHaveLength(2);
    expect(store.memorySourceSummary(m!.id)).toMatchObject({ distinct: 2, unverified: false });
  });

  it("drops duplicates of rejected memories", async () => {
    const { store } = tempStore();
    const a = store.addObservation(obs("I hate mornings."));
    const llm1 = script({ [a.text!]: extraction([{ statement: "I hate mornings." }]) });
    await compact({ store, llm: llm1, config });
    store.reject(store.listMemories()[0]!.id);

    const b = store.addObservation(obs("Mornings are the worst.", { occurredAt: "2026-09-05T00:00:00.000Z" }));
    const llm2 = script({ [b.text!]: extraction([{ statement: "I hate mornings!" }]) }, (_c, n) => ({
      action: "duplicate",
      targetId: n[0]!,
      reason: "same",
    }));
    const report = await compact({ store, llm: llm2, config });
    expect(report.droppedAsRejected).toBe(1);
    expect(store.listMemories()).toHaveLength(1);
  });

  it("links updates and contradictions, defaulting validFrom to when the observation happened", async () => {
    const { store } = tempStore();
    const a = store.addObservation(obs("Currently reading Dune."));
    await compact({
      store,
      llm: script({ [a.text!]: extraction([{ statement: "I'm currently reading Dune.", isCurrentState: true }]) }),
      config,
    });
    const dune = store.listMemories()[0]!;
    store.approve(dune.id);

    const py = store.addObservation(obs("User prefers Python.", { sourceKind: "chatgpt-memory", occurredAt: "2026-08-01T00:00:00.000Z" }));
    await compact({ store, llm: script({ [py.text!]: extraction([{ statement: "I prefer Python." }]) }), config });
    const python = store.listMemories().find((m) => m.statement === "I prefer Python.")!;

    const b = store.addObservation(obs("Now reading Solaris; also I prefer Rust.", { occurredAt: "2026-09-20T00:00:00.000Z" }));

    const report = await compact({
      store,
      llm: script(
        {
          [b.text!]: extraction([
            { statement: "I'm currently reading Solaris.", isCurrentState: true },
            { statement: "I prefer Rust." },
          ]),
        },
        (c, n) =>
          c.includes("Solaris")
            ? { action: "update", targetId: n.find((id) => id === dune.id)!, reason: "new book" }
            : { action: "contradiction", targetId: n.find((id) => id === python.id) ?? null, reason: "conflict" },
      ),
      config,
    });
    expect(report).toMatchObject({ updates: 1, contradictions: 1 });
    const solaris = store.listMemories().find((m) => m.statement.includes("Solaris"))!;
    expect(solaris.supersedesId).toBe(dune.id);
    expect(solaris.validFrom).toBe("2026-09-20T00:00:00.000Z");
    expect(store.listMemories().find((m) => m.statement === "I prefer Rust.")!.conflictsWithId).toBe(python.id);
  });

  it("treats an unknown targetId as new", async () => {
    const { store } = tempStore();
    const a = store.addObservation(obs("I like chess."));
    const b = store.addObservation(obs("I like chess a lot.", { occurredAt: "2026-09-03T00:00:00.000Z" }));
    const llm = script(
      { [a.text!]: extraction([{ statement: "I like chess." }]), [b.text!]: extraction([{ statement: "I like chess a lot." }]) },
      () => ({ action: "duplicate", targetId: "mem_ffffffffffff", reason: "hallucinated" }),
    );
    const report = await compact({ store, llm, config });
    expect(report.created).toBe(2);
  });

  it("isolates per-observation failures and retries them on request", async () => {
    const { store } = tempStore();
    const bad = store.addObservation(obs("This one breaks."));
    const good = store.addObservation(obs("I play guitar.", { occurredAt: "2026-09-02T00:00:00.000Z" }));
    let fail = true;
    const llm = script({
      [bad.text!]: () => {
        if (fail) throw new Error("rate limited");
        return extraction([{ statement: "I recovered." }]) as never;
      },
      [good.text!]: extraction([{ statement: "I play guitar." }]),
    });
    const report = await compact({ store, llm, config });
    expect(report.processed).toBe(1);
    expect(report.failed).toEqual([{ observationId: bad.id, error: expect.stringContaining("rate limited") }]);
    expect(store.getObservation(bad.id).compactionResult).toBe("failed");

    expect((await compact({ store, llm, config })).processed).toBe(0);
    fail = false;
    const retry = await compact({ store, llm, config, retryFailed: true });
    expect(retry).toMatchObject({ processed: 1, created: 1 });
  });

  it("keeps exemplars only from the person's own writing", async () => {
    const { store } = tempStore();
    const mine = store.addObservation(obs("haha ok fine, one more hand", { sourceKind: "slack" }));
    const theirs = store.addObservation(obs("Lin said: one more hand", { authorRole: "engaged", sourceKind: "slack", occurredAt: "2026-09-02T00:00:00.000Z" }));
    const ex = [{ text: "haha ok fine, one more hand", register: "casual" as const }];
    const llm = script({ [mine.text!]: extraction([], ex), [theirs.text!]: extraction([], ex) });
    const report = await compact({ store, llm, config });
    expect(report.exemplars).toBe(1);
    expect(store.listExemplars()[0]!.observationId).toBe(mine.id);
  });

  it("rolls back an observation's partial writes when applying it crashes, and re-runs cleanly", async () => {
    const { store } = tempStore();
    const o = store.addObservation(obs("I run marathons. lol yes really"));
    const llm = script({
      [o.text!]: extraction([{ statement: "I run marathons." }], [{ text: "lol yes really", register: "casual" }]),
    });
    const spy = vi.spyOn(store, "insertExemplar").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    const first = await compact({ store, llm, config });
    expect(first.failed).toHaveLength(1);
    expect(store.listMemories()).toEqual([]);
    expect(store.listEntities()).toEqual([]);
    spy.mockRestore();

    const second = await compact({ store, llm, config, retryFailed: true });
    expect(second).toMatchObject({ processed: 1, created: 1, exemplars: 1 });
    expect(store.listMemories()).toHaveLength(1);
  });

  it("marks memories from another AI's memory as unverified", async () => {
    const { store } = tempStore();
    const o = store.addObservation(obs("User likes jazz.", { sourceKind: "claude-memory" }));
    await compact({ store, llm: script({ [o.text!]: extraction([{ kind: "stance", statement: "I like jazz.", stance: { topic: "jazz", strength: 3 } }]) }), config });
    const m = store.listMemories()[0]!;
    expect(store.memorySourceSummary(m.id).unverified).toBe(true);
  });
});

describe("knowledge tree inputs", () => {
  it("tags background facts", async () => {
    const { store } = tempStore();
    const o = store.addObservation(obs("I'm a CS master's student at CMU."));
    await compact({ store, llm: script({ [o.text!]: extraction([{ statement: "I'm a CS master's student at CMU.", background: true }]) }), config });
    expect(store.listMemories()[0]!.attrs).toEqual({ background: true });
  });

  it("matches competence claims by tree node, without text search or a reconcile call", async () => {
    const { store } = tempStore();
    const a = store.addObservation(obs("I know Rust well."));
    const b = store.addObservation(obs("Rust is my strongest language.", { occurredAt: "2026-09-02T00:00:00.000Z" }));
    const rust = (statement: string, depth: number) =>
      extraction([{ kind: "competence", statement, competence: { domain: "Rust", depth }, entities: [{ name: "Rust", kind: "topic" }] }]);
    const reconcile = vi.fn(() => ({ action: "new" as const, targetId: null, reason: "" }));
    const llm = script({ [a.text!]: rust("I know Rust well.", 3), [b.text!]: rust("Rust is my strongest language.", 3) }, reconcile);
    const report = await compact({ store, llm, config });
    expect(report).toMatchObject({ created: 1, corroborated: 1 });
    expect(reconcile).not.toHaveBeenCalled();
    const [m] = store.listMemories();
    const topic = store.listTopics().find((t) => t.name === "Rust")!;
    expect(store.topicMemories(topic.id).map((x) => x.id)).toEqual([m!.id]);
  });

  it("proposes a new depth that supersedes the approved claim", async () => {
    const { store } = tempStore();
    const a = store.addObservation(obs("I know Rust well."));
    const rust = (statement: string, depth: number) => extraction([{ kind: "competence", statement, competence: { domain: "Rust", depth } }]);
    await compact({ store, llm: script({ [a.text!]: rust("I know Rust well.", 3) }), config });
    const first = store.listMemories()[0]!;
    store.approve(first.id);
    const b = store.addObservation(obs("Honestly I'm an expert in Rust now.", { occurredAt: "2026-09-02T00:00:00.000Z" }));
    const report = await compact({ store, llm: script({ [b.text!]: rust("I'm an expert in Rust.", 4) }), config });
    expect(report.updates).toBe(1);
    const proposed = store.listMemories({ status: "proposed" })[0]!;
    expect(proposed).toMatchObject({ supersedesId: first.id, attrs: { domain: "Rust", depth: 4 } });
  });
});

describe("homes in the world tree", () => {
  it("homes a memory at its deepest node and a competence memory at its domain, with every entity a node", async () => {
    const { store } = tempStore();
    const ml = store.ensureTopic("Machine learning");
    const rl = store.ensureTopic("RL");
    store.addEdge({ from: ml.id, to: store.root("knowledge").id, kind: "part_of", source: "placement" });
    store.addEdge({ from: rl.id, to: ml.id, kind: "part_of", source: "placement" });
    const o = store.addObservation(obs("I built Kite, an RL agent for Go."));
    const llm = script({
      [o.text!]: extraction([
        { statement: "I built Kite, an RL agent for Go.", entities: [{ name: "Kite", kind: "project" }, { name: "RL", kind: "topic" }] },
        { kind: "competence", statement: "I know Go engines well.", entities: [{ name: "Kite", kind: "project" }], competence: { domain: "Go engines", depth: 3 } },
      ]),
    });
    await compact({ store, llm, config });
    const built = store.listMemories().find((m) => m.kind === "fact")!;
    const comp = store.listMemories().find((m) => m.kind === "competence")!;
    expect(built.homeNodeId).toBe(rl.id);
    expect(comp.homeNodeId).toBe(store.ensureTopic("Go engines").id);
    expect(store.listTopics().find((t) => t.name === "Kite")?.label).toBe("project");
  });
});

describe("claims and map proposals", () => {
  it("keeps the person's claim separate from a map proposal at the same depth", async () => {
    const { store } = tempStore();
    const node = store.ensureTopic("Algorithms");
    store.insertMemory(
      { kind: "competence", statement: "I've used Algorithms and can get things done with it.", tier: 1, isCurrentState: false, attrs: { domain: "Algorithms", depth: 2, basis: "predicted", reasons: [] } },
      { sourceObservationIds: [], entityIds: [node.id], actor: "map" },
    );
    const o = store.addObservation(obs("I'm decent at algorithms."));
    await compact({ store, llm: script({ [o.text!]: extraction([{ kind: "competence", statement: "I'm decent at algorithms.", competence: { domain: "Algorithms", depth: 2 } }]) }), config });
    const claims = store.listMemories({ kind: "competence" }).filter((m) => m.kind === "competence" && !m.attrs.basis);
    expect(claims.map((m) => m.statement)).toEqual(["I'm decent at algorithms."]);
  });
});
