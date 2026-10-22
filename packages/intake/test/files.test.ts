import { describe, expect, it } from "vitest";
import { fileToText, NoTextError, TooLargeError, UnsupportedFileError } from "../src/index.ts";
import { pdf } from "./pdf.ts";

describe("fileToText", () => {
  it("reads Markdown and plain text as they are", async () => {
    expect((await fileToText("cv.md", new TextEncoder().encode("# Me\nI build robots."))).text).toBe("# Me\nI build robots.");
  });
  it("reads the text layer of a PDF", async () => {
    const r = await fileToText("cv.pdf", pdf(["Lin Qiao", "MS in Computer Science, 2025"]));
    expect(r.text).toContain("MS in Computer Science, 2025");
    expect(r.pages).toBe(1);
  });
  it("refuses a PDF without text, an unknown type, and a file over 10 MB", async () => {
    await expect(fileToText("scan.pdf", pdf([]))).rejects.toBeInstanceOf(NoTextError);
    await expect(fileToText("photo.png", new Uint8Array(10))).rejects.toBeInstanceOf(UnsupportedFileError);
    await expect(fileToText("big.txt", new Uint8Array(10 * 1024 * 1024 + 1))).rejects.toBeInstanceOf(TooLargeError);
  });
});
