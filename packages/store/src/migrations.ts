import type { DatabaseSync } from "node:sqlite";

const MIGRATIONS: string[] = [
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
];

export function migrate(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null };
  const current = row.v ?? 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[i]!);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(i + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
