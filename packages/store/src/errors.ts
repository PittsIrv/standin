import type { MemoryStatus } from "@standin/schema";

export class NotFoundError extends Error {
  constructor(what: string, id: string) {
    super(`${what} not found: ${id}`);
    this.name = "NotFoundError";
  }
}

export class AmbiguousIdError extends Error {
  constructor(
    public readonly prefix: string,
    public readonly candidates: string[],
  ) {
    super(`id prefix "${prefix}" is ambiguous; matches: ${candidates.join(", ")}`);
    this.name = "AmbiguousIdError";
  }
}

export class InvalidTransitionError extends Error {
  constructor(id: string, from: MemoryStatus, to: MemoryStatus) {
    super(`memory ${id} cannot go from ${from} to ${to}`);
    this.name = "InvalidTransitionError";
  }
}
