/** Human readable byte size, e.g. 1.4 MB. Used in reports and warnings. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return rounded + " " + units[unit];
}

/**
 * Cut `text` to at most `maxBytes` of UTF-8 without splitting a code point.
 *
 * Truncating mid-codepoint produces a lone surrogate, which then fails to
 * round-trip through JSON and makes the bundle unreadable — so cut on a
 * character boundary and re-check.
 */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  let end = Math.max(0, maxBytes);
  // Walk back off a continuation byte (0b10xxxxxx) so we don't split a sequence.
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

/** Keep the head and tail of a long log, replacing the middle with a marker. */
export function elideMiddle(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  const head = Math.floor(maxBytes * 0.55);
  const tail = maxBytes - head;
  const headText = truncateUtf8(text, head).text;
  const tailText = tailUtf8(text, tail);
  const omitted = buf.length - Buffer.byteLength(headText, "utf8") - Buffer.byteLength(tailText, "utf8");
  return {
    text: headText + "\n[... repropack elided " + formatBytes(omitted) + " ...]\n" + tailText,
    truncated: true,
  };
}

function tailUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start += 1;
  return buf.subarray(start).toString("utf8");
}
