import type { DatabaseSync } from "node:sqlite";
import { defaultRoot, newId, ROOTS, type EntityKind, type RootKey } from "@standin/schema";

/** SQL, or a function for a migration that needs to walk the data. Each runs inside one transaction. */
type Migration = string | ((db: DatabaseSync) => void);

/**
 * The world tree: every entity becomes a node, the six roots are created, each node keeps one home parent (extra
 * parents become `related` links), top-level branches go under their default root, and every memory gets the most
 * specific node it is linked to as its home. Loose nodes stay unplaced for `standin map refresh`.
 */
function worldTree(db: DatabaseSync): void {
  db.exec(`
    ALTER TABLE topics ADD COLUMN root_key TEXT;
    CREATE UNIQUE INDEX topics_root_key ON topics (root_key) WHERE root_key IS NOT NULL;
    ALTER TABLE topics ADD COLUMN frontier INTEGER NOT NULL DEFAULT 0;
    -- How many memories the node held when a split was last considered, so an unchanged node isn't asked again.
    ALTER TABLE topics ADD COLUMN split_checked INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE memories ADD COLUMN home_node_id TEXT REFERENCES entities(id);
    INSERT OR IGNORE INTO topics (entity_id) SELECT id FROM entities;
  `);
  const now = new Date().toISOString();
  const rootIds = new Map<RootKey, string>();
  for (const r of ROOTS) {
    const id = newId("ent");
    db.prepare("INSERT INTO entities (id, kind, name, aliases) VALUES (?, 'other', ?, '[]')").run(id, r.name);
    db.prepare("INSERT INTO topics (entity_id, root_key) VALUES (?, ?)").run(id, r.key);
    rootIds.set(r.key, id);
  }

  type EdgeRow = { id: string; from_topic: string; to_topic: string };
  const homes = db
    .prepare("SELECT id, from_topic, to_topic FROM topic_edges WHERE kind = 'part_of' AND deleted_at IS NULL ORDER BY created_at, id")
    .all() as EdgeRow[];
  const parentOf = new Map<string, string>();
  for (const e of homes) {
    if (!parentOf.has(e.from_topic)) {
      parentOf.set(e.from_topic, e.to_topic);
      continue;
    }
    const [a, b] = [e.from_topic, e.to_topic].sort() as [string, string];
    const taken = db.prepare("SELECT 1 FROM topic_edges WHERE from_topic = ? AND to_topic = ? AND kind = 'related'").get(a, b);
    if (taken) db.prepare("DELETE FROM topic_edges WHERE id = ?").run(e.id);
    else db.prepare("UPDATE topic_edges SET kind = 'related', from_topic = ?, to_topic = ? WHERE id = ?").run(a, b, e.id);
  }

  const withParts = new Set(parentOf.values());
  const nodes = db
    .prepare("SELECT e.id, e.kind FROM entities e JOIN topics t ON t.entity_id = e.id WHERE t.root_key IS NULL AND t.deleted_at IS NULL")
    .all() as { id: string; kind: EntityKind }[];
  for (const n of nodes) {
    if (parentOf.has(n.id) || !withParts.has(n.id)) continue;
    const root = rootIds.get(defaultRoot(n.kind))!;
    db.prepare("INSERT INTO topic_edges (id, from_topic, to_topic, kind, source, created_at) VALUES (?, ?, ?, 'part_of', 'placement', ?)").run(
      newId("edg"),
      n.id,
      root,
      now,
    );
    parentOf.set(n.id, root);
  }

  const depth = (id: string): number => {
    let d = 0;
    const seen = new Set<string>();
    for (let at = parentOf.get(id); at && !seen.has(at); at = parentOf.get(at)) {
      seen.add(at);
      d++;
    }
    return d;
  };
  const live = new Set(nodes.map((n) => n.id));
  const links = db.prepare("SELECT memory_id, entity_id FROM memory_entities ORDER BY rowid").all() as { memory_id: string; entity_id: string }[];
  const best = new Map<string, { node: string; depth: number }>();
  for (const l of links) {
    if (!live.has(l.entity_id)) continue;
    const d = depth(l.entity_id);
    const current = best.get(l.memory_id);
    if (!current || d > current.depth) best.set(l.memory_id, { node: l.entity_id, depth: d });
  }
  for (const [memoryId, { node }] of best) db.prepare("UPDATE memories SET home_node_id = ? WHERE id = ?").run(node, memoryId);
}

/**
 * Hypotheses: inferred lighting stops lighting nodes. Each approved inferred lighting becomes an open hypothesis (its
 * memory retracted), and each pending inferred proposal is withdrawn, so nothing is both lit and probable.
 */
function hypotheses(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE hypotheses (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES entities(id),
      depth INTEGER NOT NULL CHECK (depth BETWEEN 1 AND 4),
      raw_score TEXT NOT NULL,
      kind TEXT NOT NULL,
      path TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      settled_at TEXT
    );
    CREATE INDEX hypotheses_node ON hypotheses (node_id);
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    ALTER TABLE probes ADD COLUMN hypothesis_id TEXT REFERENCES hypotheses(id);
    ALTER TABLE probe_responses ADD COLUMN predicted_p REAL;
    ALTER TABLE probe_responses ADD COLUMN prior_p REAL;
  `);
  const now = new Date().toISOString();
  const event = (memoryId: string, from: string, to: string, note: string) => {
    const { next } = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM memory_events").get() as { next: number };
    db.prepare("INSERT INTO memory_events (id, seq, memory_id, from_status, to_status, at, actor, note) VALUES (?, ?, ?, ?, ?, ?, 'map', ?)").run(
      newId("evt"),
      next,
      memoryId,
      from,
      to,
      now,
      note,
    );
    db.prepare("UPDATE memories SET status = ?, decided_at = COALESCE(decided_at, ?) WHERE id = ?").run(to, now, memoryId);
  };
  const kindOf = (reasons: string[]) => {
    const text = reasons.join("; ");
    return text.includes("core of your background") ? "background" : text.includes("is part of it") ? "part" : text.includes("needed for") ? "prerequisite" : "other";
  };
  const rows = db.prepare("SELECT id, status, attrs FROM memories WHERE kind = 'competence' AND status IN ('approved', 'proposed')").all() as {
    id: string;
    status: string;
    attrs: string;
  }[];
  for (const m of rows) {
    const attrs = JSON.parse(m.attrs) as { depth: number; basis?: string; reasons?: string[] };
    if (attrs.basis !== "predicted") continue;
    if (m.status === "proposed") {
      event(m.id, "proposed", "rejected", "withdrawn: inferred lighting is now a hypothesis");
      continue;
    }
    const link = db
      .prepare("SELECT me.entity_id FROM memory_entities me JOIN entities e ON e.id = me.entity_id WHERE me.memory_id = ? AND e.kind = 'topic' ORDER BY me.rowid LIMIT 1")
      .get(m.id) as { entity_id: string } | undefined;
    if (link && attrs.depth >= 1) {
      db.prepare("INSERT INTO hypotheses (id, node_id, depth, raw_score, kind, path, reason, status, created_at) VALUES (?, ?, ?, 'medium', ?, ?, ?, 'open', ?)").run(
        newId("hyp"),
        link.entity_id,
        attrs.depth,
        kindOf(attrs.reasons ?? []),
        JSON.stringify([link.entity_id]),
        (attrs.reasons ?? []).join("; ") || "inferred lighting",
        now,
      );
    }
    event(m.id, "approved", "retracted", "replaced by a hypothesis");
  }
}

const MIGRATIONS: Migration[] = [
  `
  CREATE TABLE observations (
    id TEXT PRIMARY KEY,
    source_kind TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    author_role TEXT NOT NULL,
    lang TEXT NOT NULL,
    text TEXT,
    content_hash TEXT NOT NULL UNIQUE,
    occurred_at TEXT NOT NULL,
    ingested_at TEXT NOT NULL,
    compacted_at TEXT,
    compaction_result TEXT,
    purged_at TEXT,
    meta TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX observations_pending ON observations (compacted_at, occurred_at);

  CREATE TABLE entities (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    aliases TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX entities_kind ON entities (kind);

  CREATE TABLE memories (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    statement TEXT NOT NULL,
    lang TEXT NOT NULL,
    tier INTEGER NOT NULL CHECK (tier BETWEEN 1 AND 4),
    status TEXT NOT NULL,
    confidence REAL NOT NULL,
    salience REAL NOT NULL,
    valid_from TEXT,
    valid_until TEXT,
    -- validUntil as approved; later supersession/expiry only changes valid_until.
    original_valid_until TEXT,
    is_current_state INTEGER NOT NULL,
    affirmed INTEGER NOT NULL,
    supersedes_id TEXT REFERENCES memories (id),
    conflicts_with_id TEXT REFERENCES memories (id),
    recorded_at TEXT NOT NULL,
    decided_at TEXT,
    last_corroborated_at TEXT NOT NULL,
    attrs TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX memories_status ON memories (status);

  CREATE TABLE memory_sources (
    memory_id TEXT NOT NULL REFERENCES memories (id),
    observation_id TEXT NOT NULL REFERENCES observations (id),
    PRIMARY KEY (memory_id, observation_id)
  );

  CREATE TABLE memory_entities (
    memory_id TEXT NOT NULL REFERENCES memories (id),
    entity_id TEXT NOT NULL REFERENCES entities (id),
    PRIMARY KEY (memory_id, entity_id)
  );
  CREATE INDEX memory_entities_entity ON memory_entities (entity_id);

  CREATE TABLE memory_events (
    id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL,
    memory_id TEXT NOT NULL REFERENCES memories (id),
    from_status TEXT,
    to_status TEXT NOT NULL,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    note TEXT
  );
  CREATE INDEX memory_events_memory ON memory_events (memory_id, seq);

  CREATE TABLE exemplars (
    id TEXT PRIMARY KEY,
    observation_id TEXT NOT NULL REFERENCES observations (id),
    text TEXT NOT NULL,
    lang TEXT NOT NULL,
    register TEXT NOT NULL,
    status TEXT NOT NULL,
    content_hash TEXT NOT NULL UNIQUE,
    recorded_at TEXT NOT NULL,
    decided_at TEXT
  );

  CREATE TABLE preference_pairs (
    id TEXT PRIMARY KEY,
    question TEXT NOT NULL,
    standin_answer TEXT NOT NULL,
    person_answer TEXT NOT NULL,
    lang TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  `
  -- Observations sent to a provider's batch API and not yet collected.
  CREATE TABLE compaction_batches (
    id TEXT PRIMARY KEY,
    provider_batch_id TEXT NOT NULL,
    model TEXT NOT NULL,
    submitted_at TEXT NOT NULL,
    closed_at TEXT,
    outcome TEXT
  );
  CREATE TABLE compaction_batch_items (
    batch_id TEXT NOT NULL REFERENCES compaction_batches(id),
    observation_id TEXT NOT NULL REFERENCES observations(id),
    position INTEGER NOT NULL,
    PRIMARY KEY (batch_id, observation_id)
  );
  `,
  `
  -- OpenTelemetry-shaped spans. Text (prompts, outputs) lives in span_content so retention can purge it alone.
  CREATE TABLE spans (
    span_id TEXT PRIMARY KEY,
    trace_id TEXT NOT NULL,
    parent_span_id TEXT,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    status TEXT NOT NULL,
    status_message TEXT,
    attributes TEXT NOT NULL,
    events TEXT NOT NULL
  );
  CREATE INDEX spans_trace ON spans (trace_id);
  CREATE INDEX spans_roots ON spans (start_time) WHERE parent_span_id IS NULL;
  CREATE TABLE span_content (
    span_id TEXT PRIMARY KEY REFERENCES spans(span_id),
    recorded_at TEXT NOT NULL,
    content TEXT NOT NULL
  );
  `,
  `
  -- English only, and no guessed confidence or salience scores.
  ALTER TABLE observations DROP COLUMN lang;
  ALTER TABLE memories DROP COLUMN lang;
  ALTER TABLE memories DROP COLUMN confidence;
  ALTER TABLE memories DROP COLUMN salience;
  ALTER TABLE exemplars DROP COLUMN lang;
  ALTER TABLE preference_pairs DROP COLUMN lang;
  -- Each review decision with the item's queue position, so a learned ordering can later be tested against the plain one.
  CREATE TABLE queue_decisions (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    item_kind TEXT NOT NULL,
    queue_group TEXT,
    position INTEGER,
    decision TEXT NOT NULL,
    at TEXT NOT NULL
  );
  `,
  `
  -- The knowledge tree: topic nodes (entities of kind topic), their edges, and gaps carved out of lit branches.
  CREATE TABLE topics (
    entity_id TEXT PRIMARY KEY REFERENCES entities(id),
    definition TEXT,
    expanded_at TEXT,
    seed_memory_id TEXT REFERENCES memories(id),
    boundary_tier INTEGER,
    deleted_at TEXT
  );
  CREATE TABLE topic_edges (
    id TEXT PRIMARY KEY,
    from_topic TEXT NOT NULL REFERENCES entities(id),
    to_topic TEXT NOT NULL REFERENCES entities(id),
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    deleted_at TEXT,
    UNIQUE (from_topic, to_topic, kind)
  );
  CREATE TABLE gaps (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL REFERENCES entities(id),
    claim_node_id TEXT REFERENCES entities(id),
    level INTEGER NOT NULL,
    status TEXT NOT NULL,
    source TEXT NOT NULL,
    memory_id TEXT REFERENCES memories(id),
    created_at TEXT NOT NULL,
    UNIQUE (node_id, memory_id)
  );
  `,
  `
  -- Probing: review sessions, probes (with their holdout set), and responses with the prediction recorded first.
  CREATE TABLE review_sessions (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    size INTEGER NOT NULL
  );
  CREATE TABLE probes (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL REFERENCES entities(id),
    check_of TEXT REFERENCES entities(id),
    kind TEXT NOT NULL,
    difficulty INTEGER NOT NULL CHECK (difficulty BETWEEN 1 AND 4),
    question TEXT NOT NULL,
    holdout TEXT NOT NULL,
    created_at TEXT NOT NULL,
    released_at TEXT
  );
  CREATE INDEX probes_node ON probes (node_id);
  CREATE TABLE probe_responses (
    id TEXT PRIMARY KEY,
    probe_id TEXT NOT NULL UNIQUE REFERENCES probes(id),
    session_id TEXT NOT NULL REFERENCES review_sessions(id),
    shown_at TEXT NOT NULL,
    predicted_mode TEXT NOT NULL,
    rating TEXT,
    answered_at TEXT,
    spot_check TEXT NOT NULL,
    spot_check_answer TEXT,
    observation_id TEXT REFERENCES observations(id),
    grade TEXT,
    grade_reason TEXT,
    grade_batch_id TEXT,
    judged TEXT
  );
  ALTER TABLE gaps ADD COLUMN response_id TEXT REFERENCES probe_responses(id);
  `,
  worldTree,
  hypotheses,
  `
  -- Concept cards: the level the person gave, each part's level, and walks the person stopped.
  ALTER TABLE probe_responses ADD COLUMN level INTEGER;
  ALTER TABLE topics ADD COLUMN part_level INTEGER;
  ALTER TABLE topics ADD COLUMN walk_stopped INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Concrete parts: what each concept includes, as a JSON array of strings.
  ALTER TABLE topics ADD COLUMN examples TEXT NOT NULL DEFAULT '[]';
  `,
  `
  -- Anchors: the OpenAlex field or subfield a frame node stands for.
  ALTER TABLE topics ADD COLUMN anchor TEXT;
  CREATE INDEX topics_anchor ON topics(anchor) WHERE anchor IS NOT NULL;
  `,
];

/** Applies pending migrations up to `target` (default: all of them). */
export function migrate(db: DatabaseSync, target = MIGRATIONS.length): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null };
  const current = row.v ?? 0;
  for (let i = current; i < target; i++) {
    db.exec("BEGIN");
    try {
      const m = MIGRATIONS[i]!;
      if (typeof m === "string") db.exec(m);
      else m(db);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(i + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
