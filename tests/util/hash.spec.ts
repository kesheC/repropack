import { describe, expect, it } from "vitest";
import { bundleId, canonicalJson, sha256, sha256Bytes } from "../../src/util/hash.js";

describe("sha256", () => {
  it("matches the known digest of the empty string", () => {
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("hashes bytes and strings to the same digest for valid utf8", () => {
    expect(sha256Bytes(Buffer.from("héllo", "utf8"))).toBe(sha256("héllo"));
  });
});

describe("canonicalJson", () => {
  it("sorts keys at every depth", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("keeps array order, because order is meaningful there", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("drops undefined fields so two objects with and without them hash equally", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it("is stable across different insertion orders", () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });
});

describe("bundleId", () => {
  const base = {
    command: { argv: ["node", "test.js"], exitCode: 1 },
    environment: { node: "v20.11.0" },
    repository: null,
    files: [
      { path: "b.ts", sha256: "bb" },
      { path: "a.ts", sha256: "aa" },
    ],
  };

  it("is stable regardless of the order files were listed in", () => {
    const forward = bundleId(base);
    const reversed = bundleId({ ...base, files: [...base.files].reverse() });
    expect(forward).toBe(reversed);
  });

  it("changes when a file hash changes", () => {
    const changed = bundleId({ ...base, files: [{ path: "a.ts", sha256: "zz" }, { path: "b.ts", sha256: "bb" }] });
    expect(changed).not.toBe(bundleId(base));
  });

  it("changes when the exit code changes", () => {
    const changed = bundleId({ ...base, command: { argv: base.command.argv, exitCode: 2 } });
    expect(changed).not.toBe(bundleId(base));
  });
});
