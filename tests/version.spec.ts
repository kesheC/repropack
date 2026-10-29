import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TOOL_VERSION } from "../src/version.js";

/**
 * The manifest records the tool version that produced it, so a bundle's
 * provenance depends on this constant being the version actually published.
 * Without this test the two drift silently and every bundle claims a version
 * that never existed.
 */
function packageJsonVersion(): string {
  // Walk up from this file instead of hard-coding a relative depth: the spec
  // lives one level under the package root today, but a reorganisation should
  // not silently point the assertion at some other package.json.
  let dir = import.meta.dirname;
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };
      if (parsed.name === "repropack") return parsed.version ?? "";
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not locate the repropack package.json above " + import.meta.dirname);
}

describe("TOOL_VERSION", () => {
  it("matches the version in package.json", () => {
    expect(packageJsonVersion()).toBe(TOOL_VERSION);
  });

  it("is a plain semver triple", () => {
    expect(TOOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
