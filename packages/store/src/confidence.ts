import type { AuthorRole, SourceKind } from "@standin/schema";

export const SOURCE_WEIGHTS: Record<SourceKind, number> = {
  interview: 0.9,
  checkin: 0.9,
  manual: 0.9,
  github: 0.85,
  website: 0.85,
  demo: 0.8,
  slack: 0.7,
  gdrive: 0.6,
  "chatgpt-export": 0.6,
  "claude-export": 0.6,
  "claude-memory": 0.4,
  "chatgpt-memory": 0.4,
  "muse-paste": 0.4,
};

export const ROLE_FACTORS: Record<AuthorRole, number> = { self: 1, engaged: 0.7, exposed: 0 };

export const CURRENT_STATE_FLOOR = 0.25;

export interface ConfidenceInput {
  affirmed: boolean;
  sources: { sourceKind: SourceKind; authorRole: AuthorRole }[];
  isCurrentState: boolean;
  lastCorroboratedAt: string;
  now: Date;
  halfLifeDays: number;
}

/**
 * Affirmed memories are certain; otherwise evidence combines by noisy-OR over sources.
 * Current-state memories ("currently reading X") decay since last corroboration.
 */
export function computeConfidence(input: ConfidenceInput): number {
  const base = input.affirmed
    ? 1
    : 1 - input.sources.reduce((acc, s) => acc * (1 - SOURCE_WEIGHTS[s.sourceKind] * ROLE_FACTORS[s.authorRole]), 1);
  if (!input.isCurrentState) return base;
  const ageDays = (input.now.getTime() - new Date(input.lastCorroboratedAt).getTime()) / 86_400_000;
  const decay = Math.max(CURRENT_STATE_FLOOR, 0.5 ** (Math.max(0, ageDays) / input.halfLifeDays));
  return base * decay;
}
