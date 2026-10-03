import { randomBytes } from "node:crypto";

export const ID_PREFIXES = ["obs", "ent", "mem", "exm", "evt", "pp", "cb"] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number];

/** A prefixed random id, e.g. `mem_3f9a1c04be27`. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

export function isId(prefix: IdPrefix, value: string): boolean {
  return new RegExp(`^${prefix}_[0-9a-f]{12}$`).test(value);
}
