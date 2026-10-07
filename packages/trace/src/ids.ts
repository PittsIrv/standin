function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  // W3C trace context forbids all-zero ids; regenerate in the (vanishingly rare) case.
  do crypto.getRandomValues(buf);
  while (buf.every((b) => b === 0));
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 16 random bytes as 32 lowercase hex characters. */
export const newTraceId = (): string => randomHex(16);
/** 8 random bytes as 16 lowercase hex characters. */
export const newSpanId = (): string => randomHex(8);
