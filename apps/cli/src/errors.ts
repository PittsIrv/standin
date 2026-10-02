/** A user-facing error: printed without a stack trace, exit code 1. */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}
