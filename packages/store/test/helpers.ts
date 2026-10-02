import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObservationInput } from "@standin/schema";
import { openStore, type Store } from "../src/index.ts";

export class FakeClock {
  constructor(public current: Date = new Date("2026-10-01T12:00:00.000Z")) {}
  now(): Date {
    return new Date(this.current);
  }
  advanceDays(days: number): void {
    this.current = new Date(this.current.getTime() + days * 86_400_000);
  }
}

export function tempStore(clock = new FakeClock()): { store: Store; clock: FakeClock; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "standin-store-"));
  const path = join(dir, "standin.db");
  return { store: openStore({ path, clock }), clock, path };
}

export function obs(overrides: Partial<ObservationInput> = {}): ObservationInput {
  return {
    sourceKind: "interview",
    sourceRef: "interview-01",
    authorRole: "self",
    lang: "en",
    text: "I build board-game AIs.",
    occurredAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}
