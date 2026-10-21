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
  constructor(id: string, from: string, to: string) {
    super(`${id} cannot go from ${from} to ${to}`);
    this.name = "InvalidTransitionError";
  }
}

/** An edge that would close a loop; `path` lists topic names from the new edge's start back to itself. */
export class CycleError extends Error {
  constructor(public readonly path: string[]) {
    super(`that edge would make a cycle: ${path.join(" → ")}`);
    this.name = "CycleError";
  }
}

export class AlreadyRatedError extends Error {
  constructor(id: string) {
    super(`response ${id} is already rated`);
    this.name = "AlreadyRatedError";
  }
}
