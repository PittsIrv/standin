import { createHash } from "node:crypto";
import { describeAll, scan, type Described } from "@standin/airlock";
import type { Bundle, BundleNode } from "@standin/schema";

export type ItemKind = "node" | "memory" | "exemplar";

/** One reviewable thing in a bundle: a node, a memory or an exemplar, with the text a visitor could see. */
export interface Item {
  /** `memory:mem_…`, `node:…`, `exemplar:…`: stable across versions. */
  key: string;
  kind: ItemKind;
  id: string;
  /** What the person reads: a node's name, a memory's statement, an exemplar's text. */
  label: string;
  /** The tree it sits in, for grouping; null for exemplars and unplaced nodes. */
  root: string | null;
  /** Every visible text field, named. */
  fields: { field: string; text: string }[];
  /** Everything else that a change to would matter (tier, level, parent…), for the diff. */
  meta: string;
}

const nodeFields = (n: BundleNode) => [
  { field: "name", text: n.name },
  ...n.aliases.map((a, i) => ({ field: `alias ${i + 1}`, text: a })),
  ...(n.definition ? [{ field: "definition", text: n.definition }] : []),
  ...n.examples.map((e, i) => ({ field: `example ${i + 1}`, text: e })),
];

export function items(b: Bundle): Item[] {
  const rootOf = new Map(b.nodes.map((n) => [n.id, n.root]));
  return [
    ...b.nodes.map((n): Item => ({
      key: `node:${n.id}`,
      kind: "node",
      id: n.id,
      label: n.name,
      root: n.root,
      fields: nodeFields(n),
      meta: JSON.stringify({ parent: n.parent, answer: n.answer }),
    })),
    ...b.memories.map((m): Item => ({
      key: `memory:${m.id}`,
      kind: "memory",
      id: m.id,
      label: m.statement,
      root: rootOf.get(m.nodes[0]!) ?? null,
      fields: [{ field: "statement", text: m.statement }],
      meta: JSON.stringify({ kind: m.kind, tier: m.tier, nodes: m.nodes, validUntil: m.validUntil }),
    })),
    ...b.exemplars.map((e): Item => ({ key: `exemplar:${e.id}`, kind: "exemplar", id: e.id, label: e.text, root: null, fields: [{ field: "text", text: e.text }], meta: e.register })),
  ];
}

/** A hash of an item's visible text: a Keep decision holds until it changes (publish spec §4). */
export const contentHash = (i: Item) => createHash("sha256").update(i.fields.map((f) => `${f.field}\u0000${f.text}`).join("\u0001")).digest("hex").slice(0, 32);

/** A finding in a bundle: which item and field holds it, masked; never the matched text. */
export interface BundleFinding extends Described {
  key: string;
  where: string;
}

/** The final scan (publish spec §4, decision 105): every text field through the airlock. Any finding stops a publish. */
export function scanBundle(b: Bundle): BundleFinding[] {
  const out: BundleFinding[] = [];
  out.push(...describeAll(b.persona.name, scan(b.persona.name)).map((d) => ({ ...d, key: "persona", where: "persona name" })));
  for (const i of items(b))
    for (const f of i.fields) {
      const found = scan(f.text);
      if (found.length) out.push(...describeAll(f.text, found).map((d) => ({ ...d, key: i.key, where: `${i.kind} ${i.id} ${f.field}` })));
    }
  return out;
}

export interface Change {
  key: string;
  kind: ItemKind;
  id: string;
  label: string;
  root: string | null;
  change: "added" | "changed" | "removed";
  /** For a change: the label before, when it differs. */
  was?: string;
}

/** What changed from `prev` (null: nothing published yet) to `next`, items in `next`'s order, removals last. */
export function diffBundles(prev: Bundle | null, next: Bundle): Change[] {
  const before = new Map((prev ? items(prev) : []).map((i) => [i.key, i]));
  const after = items(next);
  const seen = new Set<string>();
  const out: Change[] = [];
  const base = (i: Item) => ({ key: i.key, kind: i.kind, id: i.id, label: i.label, root: i.root });
  for (const i of after) {
    seen.add(i.key);
    const p = before.get(i.key);
    if (!p) out.push({ ...base(i), change: "added" });
    else if (contentHash(p) !== contentHash(i) || p.meta !== i.meta) out.push({ ...base(i), change: "changed", ...(p.label !== i.label ? { was: p.label } : {}) });
  }
  for (const [key, p] of before) if (!seen.has(key)) out.push({ ...base(p), change: "removed" });
  return out;
}
