export type ModelTier = "small" | "medium" | "large";
export type Zone = "private" | "public";

/**
 * Every task that calls a model, with its default tier and zone. Public-zone
 * roles run on the Cloudflare Worker and can't reach private-network models.
 * Adding a role is a code change, reviewed like one.
 */
export const ROLES = {
  extract: { tier: "large", zone: "private", purpose: "Extract atomic memories from one observation" },
  reconcile: { tier: "small", zone: "private", purpose: "Classify a candidate against similar memories" },
  screen: { tier: "small", zone: "private", purpose: "Flag possibly sensitive memories for review" },
  answer: { tier: "small", zone: "public", purpose: "Answer a visitor turn" },
  checkin: { tier: "medium", zone: "private", purpose: "Write follow-up interview questions" },
  quiz: { tier: "medium", zone: "private", purpose: "Generate self-quiz questions" },
  attack: { tier: "medium", zone: "private", purpose: "Generate break-me attempts" },
  style: { tier: "large", zone: "private", purpose: "Rewrite the style card" },
  judge: { tier: "large", zone: "private", purpose: "Grade eval answers" },
} as const satisfies Record<string, { tier: ModelTier; zone: Zone; purpose: string }>;

export type Role = keyof typeof ROLES;
export const ROLE_NAMES = Object.keys(ROLES) as [Role, ...Role[]];

export const DEFAULT_TIER_MODELS: Record<ModelTier, string> = {
  small: "claude-haiku-4-5-20251001",
  medium: "claude-sonnet-5-5",
  large: "claude-opus-5-5",
};

/** True for loopback, RFC 1918 and mDNS (.local) hosts: places a Cloudflare Worker can't reach. */
export function isPrivateAddress(baseURL: string): boolean {
  let host: string;
  try {
    host = new URL(baseURL).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "::1" || host === "0.0.0.0") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
