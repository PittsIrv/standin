/** Why a source can't be read: each message is shown to the person as it is. */
export class IntakeError extends Error {}
export class TooLargeError extends IntakeError {}
export class NoTextError extends IntakeError {
  constructor() {
    super("This PDF has no text layer (it may be a scan). Paste its text instead.");
  }
}
export class UnsupportedFileError extends IntakeError {
  constructor(name: string) {
    super(`${name}: only PDF, Word (.docx), Markdown and plain-text files can be read.`);
  }
}
export class BlockedUrlError extends IntakeError {}
export class FetchFailedError extends IntakeError {}
