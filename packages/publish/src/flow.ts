import type { LLM } from "@standin/llm";
import type { Bundle } from "@standin/schema";
import type { Store } from "@standin/store";
import { buildBundle } from "./build.ts";
import { contentHash, diffBundles, items, scanBundle, type BundleFinding, type Change, type ItemKind } from "./items.ts";
import { flagSensitive } from "./sensitivity.ts";
import { currentVersion, readCurrent, readVersion, saveVersion } from "./versions.ts";

export interface PublishDeps {
  store: Store;
  /** Where versions are saved: `~/.standin/published`. */
  dir: string;
  /** Role `screen`: the sensitivity check. */
  screen: LLM;
  personaName: string;
  speakAt: number;
  /** Items per sensitivity call. */
  batch: number;
}

/** An item the sensitivity check flagged, held back until the person keeps or hides it. */
export interface Held {
  key: string;
  kind: ItemKind;
  id: string;
  label: string;
  reason: string;
}

export interface Prepared {
  current: { version: number; createdAt: string } | null;
  /** What Publish would save: the draft without held items. */
  bundle: Bundle;
  /** From the current version to `bundle`. */
  changes: Change[];
  /** The final scan of the whole draft. Any finding blocks publishing (decision 105). */
  findings: BundleFinding[];
  held: Held[];
}

/** Publishing was refused: a scan finding, or a check that couldn't run. */
export class PublishBlockedError extends Error {}

/** `b` without the given items. A removed node takes its descendants with it, and a memory left on no node goes too. */
export function withoutKeys(b: Bundle, keys: Set<string>): Bundle {
  if (keys.size === 0) return b;
  const gone = new Set(b.nodes.filter((n) => keys.has(`node:${n.id}`)).map((n) => n.id));
  for (let grew = true; grew; ) {
    grew = false;
    for (const n of b.nodes) if (!gone.has(n.id) && n.parent && gone.has(n.parent)) gone.add(n.id), (grew = true);
  }
  const memories = b.memories
    .filter((m) => !keys.has(`memory:${m.id}`))
    .map((m) => ({ ...m, nodes: m.nodes.filter((id) => !gone.has(id)) }))
    .filter((m) => m.nodes.length > 0);
  return {
    ...b,
    nodes: b.nodes.filter((n) => !gone.has(n.id)),
    related: b.related.filter(([x, y]) => !gone.has(x) && !gone.has(y)),
    memories,
    exemplars: b.exemplars.filter((e) => !keys.has(`exemplar:${e.id}`)),
  };
}

/**
 * Everything the Publish tab shows (publish spec §4): the draft, the final scan, the sensitivity check of new and
 * changed items (only those without a scan finding are sent to the model, and each item is checked once per text),
 * the items held back, and what would change.
 */
export async function preparePublish(d: PublishDeps): Promise<Prepared> {
  const draft = buildBundle(d.store, { personaName: d.personaName, speakAt: d.speakAt });
  const current = readCurrent(d.dir);
  const findings = scanBundle(draft);
  const withFinding = new Set(findings.map((f) => f.key));
  const changed = new Set(diffBundles(current, draft).filter((c) => c.change !== "removed").map((c) => c.key));
  const all = items(draft);
  const toCheck = all.filter((i) => changed.has(i.key) && !withFinding.has(i.key) && d.store.getPublishReview(i.key)?.contentHash !== contentHash(i));
  if (toCheck.length) {
    const flags = await flagSensitive(d.screen, d.personaName, toCheck, d.batch);
    for (const i of toCheck) d.store.recordSensitivity(i.key, contentHash(i), { flagged: flags.get(i.key) != null, reason: flags.get(i.key) ?? null });
  }
  const held: Held[] = [];
  for (const i of all) {
    const r = d.store.getPublishReview(i.key);
    if (r && r.flagged && r.decision === null && r.contentHash === contentHash(i)) held.push({ key: i.key, kind: i.kind, id: i.id, label: i.label, reason: r.reason ?? "flagged" });
  }
  const bundle = withoutKeys(draft, new Set(held.map((h) => h.key)));
  return {
    current: current ? { version: current.version, createdAt: current.createdAt } : null,
    bundle,
    changes: diffBundles(current, bundle),
    findings,
    held,
  };
}

/** Prepares again, so nothing stale is saved, and saves the result as the next version. */
export async function publish(d: PublishDeps): Promise<Bundle> {
  const p = await preparePublish(d);
  if (p.findings.length) throw new PublishBlockedError(`The final scan found ${p.findings.length} thing${p.findings.length === 1 ? "" : "s"} that can't go public; fix or remove ${p.findings.length === 1 ? "it" : "them"} first.`);
  return saveVersion(d.dir, p.bundle);
}

/**
 * Keep or Hide a held item (publish spec §4). Hide makes it unpublishable at its source: a memory goes to tier 3, an
 * exemplar is rejected, a node becomes a boundary (and everything under it leaves the bundle).
 */
export function decideHeld(store: Store, key: string, decision: "keep" | "hide"): void {
  store.transaction(() => {
    if (decision === "hide") {
      const [kind, ...rest] = key.split(":");
      const id = rest.join(":");
      if (kind === "memory") store.retier(id, 3, "hidden at publish");
      else if (kind === "exemplar") store.rejectExemplar(id);
      else if (kind === "node") store.setTopic(id, { boundaryTier: 3 });
      else throw new Error(`unknown item ${key}`);
    }
    store.decidePublishReview(key, decision);
  });
}

/**
 * What rolling back to version `n` would publish (decision 108): the old version's items, minus any that aren't
 * publishable now. The old text is kept; nothing hidden, re-tiered, retracted or expired since comes back.
 */
export function prepareRollback(d: Pick<PublishDeps, "store" | "dir" | "personaName" | "speakAt">, n: number): Omit<Prepared, "held"> {
  const old = readVersion(d.dir, n);
  const now = new Set(items(buildBundle(d.store, { personaName: d.personaName, speakAt: d.speakAt })).map((i) => i.key));
  const kept = new Set(old.nodes.filter((x) => now.has(`node:${x.id}`)).map((x) => x.id));
  const memories = old.memories
    .filter((m) => now.has(`memory:${m.id}`))
    .map((m) => ({ ...m, nodes: m.nodes.filter((id) => kept.has(id)) }))
    .filter((m) => m.nodes.length > 0);
  const bundle: Bundle = {
    ...old,
    nodes: old.nodes.filter((x) => kept.has(x.id)).map((x) => ({ ...x, parent: x.parent && kept.has(x.parent) ? x.parent : null })),
    related: old.related.filter(([x, y]) => kept.has(x) && kept.has(y)),
    memories,
    exemplars: old.exemplars.filter((e) => now.has(`exemplar:${e.id}`)),
  };
  const current = readCurrent(d.dir);
  return {
    current: current ? { version: current.version, createdAt: current.createdAt } : null,
    bundle,
    changes: diffBundles(current, bundle),
    findings: scanBundle(bundle),
  };
}

/** Saves the rollback as the next version; history is never rewritten. */
export function rollback(d: Pick<PublishDeps, "store" | "dir" | "personaName" | "speakAt">, n: number): Bundle {
  const p = prepareRollback(d, n);
  if (p.findings.length) throw new PublishBlockedError(`Version ${n} holds ${p.findings.length} thing${p.findings.length === 1 ? "" : "s"} the final scan stops; it can't be restored.`);
  if (currentVersion(d.dir) === null) throw new PublishBlockedError("Nothing is published yet.");
  return saveVersion(d.dir, p.bundle);
}
