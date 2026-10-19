import type { Memory } from "@standin/schema";
import { UNVERIFIED_SOURCES, type SourceSummary } from "@standin/store";

const pad = (s: string, width: number) => s + " ".repeat(Math.max(0, width - s.length));

export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : pad(c, widths[i]!)))
      .join("  ")
      .trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

/** "interview×2, slack", with AI-memory sources marked "(unverified)". */
export function formatSources(s: SourceSummary): string {
  if (s.counts.length === 0) return "-";
  return s.counts
    .map((c) => `${c.sourceKind}${c.count > 1 ? `×${c.count}` : ""}${UNVERIFIED_SOURCES.has(c.sourceKind) ? " (unverified)" : ""}`)
    .join(", ");
}

export function memoryRows(memories: Memory[], sourcesOf: (m: Memory) => SourceSummary, extra?: (m: Memory) => string): string[][] {
  return memories.map((m) => [
    m.id,
    m.kind,
    String(m.tier),
    m.status,
    formatSources(sourcesOf(m)),
    extra ? `${m.statement}${extra(m)}` : m.statement,
  ]);
}

export const MEMORY_HEADERS = ["id", "kind", "tier", "status", "sources", "statement"];
