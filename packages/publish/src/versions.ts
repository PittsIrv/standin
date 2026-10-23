import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bundle } from "@standin/schema";

/** A saved version, as the Publish tab lists it. */
export interface VersionInfo {
  version: number;
  createdAt: string;
  memories: number;
  nodes: number;
  exemplars: number;
}

const file = (dir: string, n: number) => join(dir, `${String(n).padStart(4, "0")}.json`);
const CURRENT = "current";

/** Writes through a temporary file, so a crash never leaves half a version or a current pointing at nothing. */
function writeAtomic(path: string, text: string) {
  writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

export function readVersion(dir: string, n: number): Bundle {
  const path = file(dir, n);
  if (!existsSync(path)) throw new Error(`version ${n} doesn't exist`);
  return Bundle.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** The current version's number, or null before the first publish. */
export function currentVersion(dir: string): number | null {
  const path = join(dir, CURRENT);
  if (!existsSync(path)) return null;
  const n = Number(readFileSync(path, "utf8").trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function readCurrent(dir: string): Bundle | null {
  const n = currentVersion(dir);
  return n === null ? null : readVersion(dir, n);
}

/** Every saved version, newest first. */
export function listVersions(dir: string): VersionInfo[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d{4,}\.json$/.test(f))
    .map((f) => readVersion(dir, Number(f.slice(0, -5))))
    .map((b) => ({ version: b.version, createdAt: b.createdAt, memories: b.memories.length, nodes: b.nodes.length, exemplars: b.exemplars.length }))
    .sort((a, b) => b.version - a.version);
}

/** Saves `bundle` as the next version and makes it current (decision 108: every version is kept). */
export function saveVersion(dir: string, bundle: Bundle): Bundle {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const next = Math.max(0, ...listVersions(dir).map((v) => v.version)) + 1;
  const saved = Bundle.parse({ ...bundle, version: next });
  writeAtomic(file(dir, next), `${JSON.stringify(saved, null, 2)}\n`);
  writeAtomic(join(dir, CURRENT), `${next}\n`);
  return saved;
}
