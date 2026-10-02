import {
  Entity,
  Observation,
  type Entity as EntityT,
  type Observation as ObservationT,
} from "@standin/schema";

export type Row = Record<string, unknown>;

export function rowToObservation(r: Row): ObservationT {
  return Observation.parse({
    id: r.id,
    sourceKind: r.source_kind,
    sourceRef: r.source_ref,
    authorRole: r.author_role,
    lang: r.lang,
    text: r.text,
    contentHash: r.content_hash,
    occurredAt: r.occurred_at,
    ingestedAt: r.ingested_at,
    compactedAt: r.compacted_at,
    compactionResult: r.compaction_result,
    purgedAt: r.purged_at,
    meta: JSON.parse(String(r.meta)),
  });
}

export function rowToEntity(r: Row): EntityT {
  return Entity.parse({ id: r.id, kind: r.kind, name: r.name, aliases: JSON.parse(String(r.aliases)) });
}
