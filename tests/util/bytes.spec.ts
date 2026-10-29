import { describe, expect, it } from "vitest";
import { elideMiddle, formatBytes, formatBytes as fb, truncateUtf8 } from "../../src/util/bytes.js";

describe("formatBytes", () => {
  it("formats the unit boundaries", () => {
    expect(fb(0)).toBe("0 B");
    expect(fb(999)).toBe("999 B");
    expect(fb(1024)).toBe("1 KB");
    expect(fb(1536)).toBe("1.5 KB");
    expect(fb(1024 * 1024)).toBe("1 MB");
  });

  it("is defensive about nonsense input", () => {
    expect(fb(-1)).toBe("0 B");
    expect(fb(Number.NaN)).toBe("0 B");
  });
});

describe("truncateUtf8", () => {
  it("returns the input untouched when it fits", () => {
    expect(truncateUtf8("hello", 100)).toEqual({ text: "hello", truncated: false });
  });

  it("never splits a multi-byte code point", () => {
    // "é" is two bytes in UTF-8; cutting at 1 byte must yield nothing rather
    // than a lone continuation byte that JSON.stringify would mangle.
    const result = truncateUtf8("é", 1);
    expect(result.text).toBe("");
    expect(result.truncated).toBe(true);
    expect(Buffer.from(result.text, "utf8").length).toBeLessThanOrEqual(1);
  });

  it("keeps emoji intact", () => {
    const result = truncateUtf8("a😀b", 5);
    expect(result.text.startsWith("a")).toBe(true);
    // A complete emoji is fine even though its last JS code unit is a low
    // surrogate; what must never happen is a *lone* surrogate. Round-tripping
    // through UTF-8 replaces lone surrogates with U+FFFD, so compare bytes.
    expect(Buffer.from(result.text, "utf8").toString("utf8")).toBe(result.text);
    expect(result.text).toBe("a😀");
  });
});

describe("elideMiddle", () => {
  it("keeps head and tail with a marker in between", () => {
    const long = "A".repeat(4000) + "TAILMARKER" + "B".repeat(4000);
    const result = elideMiddle(long, 200);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("repropack elided");
    expect(result.text.startsWith("AAA")).toBe(true);
    expect(result.text.endsWith("BBB")).toBe(true);
  });

  it("does not touch a short string", () => {
    expect(elideMiddle("short", 1000)).toEqual({ text: "short", truncated: false });
  });

  it("respects the byte budget including the marker", () => {
    const result = elideMiddle("x".repeat(10_000), 500);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThan(700);
  });
});

void formatBytes;
