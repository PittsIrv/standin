import type { Memory } from "@standin/schema";

/** Terminal column width: East Asian wide and fullwidth characters take two cells. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd);
    w += wide ? 2 : 1;
  }
  return w;
}

const pad = (s: string, width: number) => s + " ".repeat(Math.max(0, width - displayWidth(s)));

export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? ""))));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : pad(c, widths[i]!)))
      .join("  ")
      .trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

export function memoryRows(memories: Memory[], extra?: (m: Memory) => string): string[][] {
  return memories.map((m) => [
    m.id,
    m.kind,
    String(m.tier),
    m.status,
    m.confidence.toFixed(2),
    extra ? `${m.statement}${extra(m)}` : m.statement,
  ]);
}

export const MEMORY_HEADERS = ["id", "kind", "tier", "status", "conf", "statement"];
