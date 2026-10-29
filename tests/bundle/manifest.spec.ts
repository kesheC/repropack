import { describe, expect, it } from "vitest";
import {
  checkIntegrity,
  computeIntegrity,
  isUnsafeRelativePath,
  parseManifest,
} from "../../src/bundle/manifest.js";
import type { Bundle } from "../../src/types.js";

function minimal(overrides: Partial<Bundle> = {}): Bundle {
  const partial = {
    formatVersion: 1 as const,
    id: "abc",
    createdAt: "2026-01-01T00:00:00.000Z",
    producer: { name: "repropack" as const, version: "0.1.0", node: "v20.11.0" },
    command: {
      argv: ["node", "x.js"],
      cwd: ".",
      startedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 12,
      exitCode: 1,
      signal: null,
      stdoutPath: "logs/stdout.txt",
      stderrPath: "logs/stderr.txt",
      truncated: false,
    },
    environment: {
      platform: "linux" as const,
      arch: "x64",
      release: "6.0",
      node: "v20.11.0",
      nodeAbi: "115",
      packageManager: null,
      env: {},
      timezone: "UTC",
      locale: "en-US",
      resources: { cpuCount: 4, totalMemoryMb: 8192, freeMemoryMb: 4096 },
    },
    repository: null,
    files: [{ path: "a.ts", bytes: 3, sha256: "aa", mode: "100644" as const, reason: "changed" as const, truncated: false }],
    redaction: { rulesVersion: "1", totalMatches: 0, byRule: [], bySurface: [], skipped: [] },
    warnings: [],
    ...overrides,
  };
  return { ...partial, integrity: computeIntegrity(partial) };
}

describe("computeIntegrity", () => {
  it("ignores the integrity field itself", () => {
    const bundle = minimal();
    expect(computeIntegrity({ ...bundle, integrity: "nonsense" })).toBe(bundle.integrity);
  });

  it("changes when any hashed field changes", () => {
    const bundle = minimal();
    const tampered = { ...bundle, warnings: ["someone edited this"] };
    expect(computeIntegrity(tampered)).not.toBe(bundle.integrity);
  });
});

describe("checkIntegrity", () => {
  it("accepts an untouched bundle", () => {
    expect(checkIntegrity(minimal()).ok).toBe(true);
  });

  it("rejects a bundle whose file hash list was edited", () => {
    const bundle = minimal();
    const tampered: Bundle = { ...bundle, files: [{ ...bundle.files[0]!, sha256: "bb" }] };
    const check = checkIntegrity(tampered);
    expect(check.ok).toBe(false);
    expect(check.actual).not.toBe(check.expected);
  });
});

describe("parseManifest", () => {
  it("accepts a well-formed manifest with no problems", () => {
    const { problems } = parseManifest(minimal());
    expect(problems).toEqual([]);
  });

  it("rejects a non-object", () => {
    expect(parseManifest(null).problems).toContain("manifest is not an object");
    expect(parseManifest("string").problems.length).toBeGreaterThan(0);
  });

  it("reports an unsupported format version", () => {
    const { problems } = parseManifest({ ...minimal(), formatVersion: 99 });
    expect(problems.some((p) => p.includes("formatVersion"))).toBe(true);
  });

  it("reports a missing command", () => {
    const bundle = minimal();
    const { problems } = parseManifest({ ...bundle, command: undefined });
    expect(problems).toContain("missing command");
  });

  it("reports an empty argv", () => {
    const bundle = minimal();
    const { problems } = parseManifest({ ...bundle, command: { ...bundle.command, argv: [] } });
    expect(problems.some((p) => p.includes("argv"))).toBe(true);
  });

  it("rejects paths that escape the bundle", () => {
    const bundle = minimal();
    const { problems } = parseManifest({
      ...bundle,
      files: [{ ...bundle.files[0]!, path: "../../etc/passwd" }],
    });
    expect(problems.some((p) => p.includes("unsafe file path"))).toBe(true);
  });
});

describe("isUnsafeRelativePath", () => {
  it("accepts ordinary relative paths", () => {
    expect(isUnsafeRelativePath("src/app.ts")).toBe(false);
    expect(isUnsafeRelativePath("a/b/c.txt")).toBe(false);
  });

  it("rejects absolute posix paths", () => {
    expect(isUnsafeRelativePath("/etc/passwd")).toBe(true);
  });

  it("rejects windows drive paths", () => {
    expect(isUnsafeRelativePath("C:\\Windows\\system32")).toBe(true);
  });

  it("rejects parent traversal anywhere in the path", () => {
    expect(isUnsafeRelativePath("a/../../b")).toBe(true);
    expect(isUnsafeRelativePath("../x")).toBe(true);
  });

  it("accepts repeated separators, which collapse harmlessly when joined", () => {
    expect(isUnsafeRelativePath("a//b")).toBe(false);
  });

  it("rejects a bare traversal segment even at the end", () => {
    expect(isUnsafeRelativePath("src/..")).toBe(true);
  });

  it("rejects an empty path", () => {
    expect(isUnsafeRelativePath("")).toBe(true);
  });
});
