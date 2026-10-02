import { DatabaseSync } from "node:sqlite";
import { migrate } from "./migrations.ts";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

let savepointCounter = 0;

/** Runs `fn` atomically. Nested calls become savepoints, so inner failures roll back only their own work. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) {
    const name = `sp_${++savepointCounter}`;
    db.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${name}`);
      return result;
    } catch (err) {
      db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
      throw err;
    }
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
