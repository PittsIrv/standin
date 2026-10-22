import { extname } from "node:path";
import { NoTextError, TooLargeError, UnsupportedFileError } from "./errors.ts";
import { LIMITS } from "./text.ts";

/** A file's text, read in code: PDF text layers, Word documents, Markdown and plain text (spec §3). Nothing else. */
export async function fileToText(name: string, bytes: Uint8Array): Promise<{ text: string; pages?: number }> {
  if (bytes.length > LIMITS.fileBytes) throw new TooLargeError(`${name} is over 10 MB.`);
  const ext = extname(name).toLowerCase();
  if (ext === ".md" || ext === ".markdown" || ext === ".txt") return { text: new TextDecoder("utf-8").decode(bytes) };
  if (ext === ".pdf") {
    const { getDocumentProxy, extractText } = await import("unpdf");
    const doc = await getDocumentProxy(new Uint8Array(bytes));
    if (doc.numPages > LIMITS.pdfPages) throw new TooLargeError(`${name} has ${doc.numPages} pages; at most ${LIMITS.pdfPages} can be read.`);
    const { text, totalPages } = await extractText(doc, { mergePages: false });
    const joined = (text as string[]).join("\n\n").trim();
    if (!joined) throw new NoTextError();
    return { text: joined, pages: totalPages };
  }
  if (ext === ".docx") {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return { text: value.trim() };
  }
  throw new UnsupportedFileError(name);
}
