import { readFileSync } from "node:fs";
import type { LLM } from "@standin/llm";
import type { Topic } from "@standin/schema";
import { CycleError, normalizeName, type Store } from "@standin/store";
import { buildAnchorPrompt } from "./prompts.ts";
import { AnchorSchema } from "./schemas.ts";

export interface FrameField {
  id: string;
  name: string;
  domain: string;
}
export interface FrameSubfield {
  id: string;
  name: string;
  fieldId: string;
  /** The words its research is known by: its topics' names, then their strongest keywords. */
  terms: string[];
}
export interface Frame {
  fields: FrameField[];
  subfields: FrameSubfield[];
}

/** The candidates kept for each concept (anchors spec §4). */
export const CANDIDATES = 10;

const fieldAnchor = (id: string) => `openalex:field:${id}`;
const subfieldAnchor = (id: string) => `openalex:subfield:${id}`;
const CHECKED = (id: string) => `anchor-checked:${id}`;

let frame: (Frame & { index: Index }) | null = null;

/** The OpenAlex fields and subfields shipped with the code (CC0), read once. */
export function loadFrame(): Frame {
  return framed();
}

function framed(): Frame & { index: Index } {
  if (!frame) {
    const data = JSON.parse(readFileSync(new URL("../data/openalex-frame.json", import.meta.url), "utf8")) as Frame;
    frame = { ...data, index: buildIndex(data) };
  }
  return frame;
}

// Words that say nothing about where a concept lives, common in OpenAlex topic names.
const STOP = new Set(
  "a an and as at by for from in into of on or the to with via its their using based advanced applications application techniques technique methods method research studies study general other various modern new recent".split(" "),
);

/** Lower-case words, a plural's "s" dropped, with nothing too short or too common. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
    .filter((w) => w.length > 1 && !STOP.has(w));
}

interface Index {
  /** Each subfield's words, and the words of its own name (which count double). */
  bags: { sub: FrameSubfield; all: Set<string>; name: Set<string> }[];
  idf: Map<string, number>;
}

function buildIndex(f: Frame): Index {
  const bags = f.subfields.map((sub) => {
    const name = new Set(words(sub.name));
    return { sub, name, all: new Set([...name, ...sub.terms.flatMap(words)]) };
  });
  const df = new Map<string, number>();
  for (const b of bags) for (const w of b.all) df.set(w, (df.get(w) ?? 0) + 1);
  return { bags, idf: new Map([...df].map(([w, n]) => [w, Math.log(bags.length / n)])) };
}

/**
 * The subfields a concept most likely belongs to (anchors spec §2): ranked by the words they share with its name,
 * definition and examples, rarer words counting more and a subfield's own name counting double. Top 10, best first.
 */
export function shortlist(concept: { name: string; definition: string | null; examples: string[] }): FrameSubfield[] {
  const { index } = framed();
  const mine = new Set(words([concept.name, concept.definition ?? "", ...concept.examples].join(" ")));
  return index.bags
    .map((b) => {
      let score = 0;
      for (const w of mine) if (b.all.has(w)) score += (index.idf.get(w) ?? 0) * (b.name.has(w) ? 2 : 1);
      return { sub: b.sub, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.sub.name.localeCompare(b.sub.name))
    .slice(0, CANDIDATES)
    .map((x) => x.sub);
}

/** A field, or a subfield whose name no other subfield shares, named exactly like the concept. */
function exactly(t: Topic): { field: FrameField } | { sub: FrameSubfield } | null {
  const f = framed();
  const keys = new Set([t.name, ...t.aliases].map(normalizeName));
  const field = f.fields.find((x) => keys.has(normalizeName(x.name)));
  if (field) return { field };
  const subs = f.subfields.filter((x) => keys.has(normalizeName(x.name)));
  return subs.length === 1 ? { sub: subs[0]! } : null;
}

/**
 * Anchors the Knowledge concepts that sit at the top of the tree (anchors spec §2): a concept named like a field or
 * subfield becomes that frame node; the rest go to a `map` call that picks one subfield from each concept's own
 * candidates, or none. An anchored concept moves under its subfield, under its field, made only now. Placements the
 * person made are never touched, and each concept is considered once.
 */
export async function anchorConcepts(store: Store, model: LLM, personaName: string): Promise<{ anchored: string[] }> {
  const root = store.root("knowledge").id;
  const homeEdge = new Map(store.listEdges("part_of").map((e) => [e.from, e]));
  const pending = store
    .listTopics()
    .filter((t) => t.label === "topic" && t.anchor === null && store.getKv(CHECKED(t.id)) === null)
    .filter((t) => {
      const e = homeEdge.get(t.id);
      return e?.to === root && e.source !== "person";
    });
  const anchored: string[] = [];
  const ask: { topic: Topic; candidates: FrameSubfield[] }[] = [];
  store.transaction(() => {
    for (const t of pending) {
      const hit = exactly(t);
      if (hit && "field" in hit) {
        store.setTopic(t.id, { anchor: fieldAnchor(hit.field.id) });
        anchored.push(t.name);
      } else if (hit) {
        store.setTopic(t.id, { anchor: subfieldAnchor(hit.sub.id) });
        const field = frameNode(store, hit.sub.fieldId, root);
        if (field) move(store, t.id, field.id);
        anchored.push(t.name);
      } else {
        const candidates = shortlist(t);
        if (candidates.length) ask.push({ topic: t, candidates });
      }
      store.setKv(CHECKED(t.id), store.nowIso());
    }
  });
  if (ask.length === 0) return { anchored };
  const out = await model.generateObject({ ...buildAnchorPrompt(ask, framed().fields, personaName), schema: AnchorSchema, purpose: "anchor" });
  store.transaction(() => {
    for (const a of out.anchors) {
      const item = ask[a.concept - 1];
      const sub = item?.candidates.find((c) => c.id === a.subfield);
      if (!item || !sub) continue;
      const field = frameNode(store, sub.fieldId, root);
      const node = field && frameNode(store, sub.id, field.id, sub);
      if (node && move(store, item.topic.id, node.id)) anchored.push(item.topic.name);
    }
  });
  return { anchored };
}

/**
 * The node standing for a field (or, given `sub`, a subfield), placed under `parent`: found by its anchor, else by its
 * name, else made. Null when the person deleted it: nothing brings a deleted node back.
 */
function frameNode(store: Store, id: string, parent: string, sub?: FrameSubfield): Topic | null {
  const anchor = sub ? subfieldAnchor(id) : fieldAnchor(id);
  const name = sub ? sub.name : framed().fields.find((f) => f.id === id)!.name;
  let node = store.findByAnchor(anchor) ?? store.listTopics().find((t) => t.label === "topic" && [t.name, ...t.aliases].some((n) => normalizeName(n) === normalizeName(name))) ?? null;
  if (!node) {
    node = store.ensureTopic(name);
    if (node.deletedAt) return null;
  }
  if (!node.anchor) node = store.setTopic(node.id, { anchor });
  const edge = store.listEdges("part_of").find((e) => e.from === node.id);
  if (!edge || (edge.to !== parent && edge.to === store.root("knowledge").id && edge.source !== "person")) move(store, node.id, parent);
  return node;
}

function move(store: Store, id: string, parent: string): boolean {
  try {
    store.moveTopic(id, parent, "anchor");
    return true;
  } catch (err) {
    if (err instanceof CycleError) return false;
    throw err;
  }
}
