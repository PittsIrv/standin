import type { Store } from "@standin/store";
import { proposeNode } from "../proposals.ts";
import { usableProbe, type TreeSnapshot } from "../snapshot.ts";
import { DISCOVERY_START } from "./plan.ts";

/** Depth 4 from probes also needs this many passed spot-checks at difficulty 4. */
export const EXPERT_PASSES = 2;

/**
 * Lighting proposals from discovery walks: the highest level known in an unbroken climb from 2, using usable
 * probes only. 4 needs two passed spot-checks at 4; until the grades come in, the proposal is 3.
 */
export function discoveryProposals(store: Store, t: TreeSnapshot): string[] {
  const walks = new Map<string, ReturnType<Store["listResponses"]>>();
  for (const r of store.listResponses({ rated: true }).filter((x) => x.probe.kind === "discovery" && usableProbe(x.probe))) {
    walks.set(r.probe.nodeId, [...(walks.get(r.probe.nodeId) ?? []), r]);
  }
  const proposed: string[] = [];
  store.transaction(() => {
    for (const [nodeId, steps] of walks) {
      if (!t.topics.has(nodeId)) continue;
      let level = DISCOVERY_START - 1;
      for (let d = DISCOVERY_START; d <= 4; d++) {
        if (steps.some((s) => s.probe.difficulty === d && s.rating === "know")) level = d;
        else break;
      }
      if (level < DISCOVERY_START) continue;
      const passesAt4 = steps.filter((s) => s.probe.difficulty === 4 && s.grade === "pass").length;
      if (level === 4 && passesAt4 < EXPERT_PASSES) level = 3;
      const reasons = [`you knew it at ${level} when probed`];
      const out = proposeNode(store, t, nodeId, level, "probed", reasons);
      if (out.proposed) proposed.push(out.proposed);
    }
  });
  return proposed;
}
