import { SecretFoundError } from "@standin/airlock";
import { describe, expect, it } from "vitest";
import { fact, obs, seedMemory, tempStore } from "./helpers.ts";

// Built at run time so no key-shaped string sits in the repo.
const TOKEN = "ghp_" + "aB3kQ9zX7mW2pL5vR8tY4nC6aB3kQ9zX7mW2".slice(0, 36);
const count = (store: ReturnType<typeof tempStore>["store"], table: string) => (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("the store refuses secrets in text a person typed (personal-data guard §3)", () => {
  it("refuses an observation with a secret and stores nothing", () => {
    const { store } = tempStore();
    expect(() => store.addObservation(obs({ text: `my token is ${TOKEN}` }))).toThrow(SecretFoundError);
    expect(count(store, "observations")).toBe(0);
  });

  it("cuts contact details from an observation", () => {
    const { store } = tempStore();
    expect(store.addObservation(obs({ text: "Write to me@example.com about Go." })).text).toBe("Write to [removed] about Go.");
  });

  it("refuses an edited statement on approval", () => {
    const { store } = tempStore();
    const m = seedMemory(store, "I use GitHub.");
    expect(() => store.approve(m.id, { statement: `My GitHub token is ${TOKEN}` })).toThrow(SecretFoundError);
    expect(store.getMemory(m.id).status).toBe("proposed");
  });

  it("refuses a secret in a node's new name or description", () => {
    const { store } = tempStore();
    const n = store.ensureNode("Tools", "topic");
    expect(() => store.renameTopic(n.id, `Tools ${TOKEN}`)).toThrow(SecretFoundError);
    expect(() => store.describeTopic(n.id, { definition: `key ${TOKEN}`, examples: [] })).toThrow(SecretFoundError);
    expect(() => store.describeTopic(n.id, { definition: "Things I use", examples: [`token ${TOKEN}`] })).toThrow(SecretFoundError);
  });

  it("refuses a self-quiz answer and a preference pair with a secret", () => {
    const { store } = tempStore();
    expect(() =>
      store.addQuizAnswer({ caseId: "k", question: "Q?", personAnswer: `password: Hunter2!`, standinReply: "A.", state: "grounded", sessionId: null }),
    ).toThrow(SecretFoundError);
    expect(() => store.addPreferencePair({ question: "Q?", standinAnswer: "A.", personAnswer: `the PIN is 4821` })).toThrow(SecretFoundError);
    expect(count(store, "quiz_answers") + count(store, "preference_pairs")).toBe(0);
  });

  it("cuts, rather than refuses, anything a model wrote: memories, exemplars and node names", () => {
    const { store } = tempStore();
    const o = store.addObservation(obs({ text: "I like Go." }));
    const m = store.insertMemory(fact(`My key is ${TOKEN} and mail me@example.com`), { sourceObservationIds: [o.id], entityIds: [], actor: "compaction" });
    expect(m.statement).toBe("My key is [removed] and mail [removed]");
    const e = store.insertExemplar({ observationId: o.id, text: `Ping me at me@example.com, token ${TOKEN}, any time you like.`, register: "casual" });
    expect(e?.text).toBe("Ping me at [removed], token [removed], any time you like.");
    expect(store.ensureNode(`Keys ${TOKEN}`, "topic").name).toBe("Keys [removed]");
  });
});
