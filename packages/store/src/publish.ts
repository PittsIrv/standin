import type { Store } from "./store.ts";

/** One bundle item's sensitivity check at its current text, and the person's decision (publish spec §4). */
export interface PublishReview {
  itemKey: string;
  contentHash: string;
  flagged: boolean;
  reason: string | null;
  checkedAt: string;
  decision: "keep" | "hide" | null;
  decidedAt: string | null;
}

type Row = { item_key: string; content_hash: string; flagged: number; reason: string | null; checked_at: string; decision: "keep" | "hide" | null; decided_at: string | null };
const toReview = (r: Row): PublishReview => ({
  itemKey: r.item_key,
  contentHash: r.content_hash,
  flagged: r.flagged === 1,
  reason: r.reason,
  checkedAt: r.checked_at,
  decision: r.decision,
  decidedAt: r.decided_at,
});

export function getPublishReview(s: Store, key: string): PublishReview | null {
  const r = s.db.prepare("SELECT * FROM publish_reviews WHERE item_key = ?").get(key) as Row | undefined;
  return r ? toReview(r) : null;
}

export const listPublishReviews = (s: Store): PublishReview[] => (s.db.prepare("SELECT * FROM publish_reviews ORDER BY checked_at, item_key").all() as Row[]).map(toReview);

/** A new check replaces the old one, and with it any decision about the old text. */
export function recordSensitivity(s: Store, key: string, hash: string, r: { flagged: boolean; reason: string | null }): void {
  s.db
    .prepare(
      `INSERT INTO publish_reviews (item_key, content_hash, flagged, reason, checked_at, decision, decided_at) VALUES (?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT (item_key) DO UPDATE SET content_hash = excluded.content_hash, flagged = excluded.flagged, reason = excluded.reason,
         checked_at = excluded.checked_at, decision = NULL, decided_at = NULL`,
    )
    .run(key, hash, r.flagged ? 1 : 0, r.reason, s.nowIso());
}

export function decidePublishReview(s: Store, key: string, decision: "keep" | "hide"): PublishReview {
  const r = s.db.prepare("UPDATE publish_reviews SET decision = ?, decided_at = ? WHERE item_key = ?").run(decision, s.nowIso(), key);
  if (r.changes === 0) throw new Error(`no sensitivity check recorded for ${key}`);
  return getPublishReview(s, key)!;
}
