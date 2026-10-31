import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string): string => readFileSync(join(root, relative), "utf8");

/**
 * The release gate and the tarball assertions live in workflow YAML, where no
 * test would otherwise reach them. Both exist because the older checks could
 * not fail: `bin --version` was compared against the package.json inside the
 * same tarball, so it agreed by construction. Pinning the text here means
 * deleting or weakening a gate breaks a test instead of shipping silently.
 */
describe("release workflow", () => {
  const release = read(".github/workflows/release.yml");

  it("refuses a tag that disagrees with package.json", () => {
    expect(release).toContain("tag/version mismatch");
    expect(release).toContain("tag is not a vX.Y.Z tag");
  });

  it("gates before the changelog is read, so a drifted tag reports the tag", () => {
    const gate = release.indexOf("tag/version mismatch");
    const changelog = release.indexOf("CHANGELOG.md has no section for");
    expect(gate).toBeGreaterThan(0);
    expect(changelog).toBeGreaterThan(0);
    expect(gate).toBeLessThan(changelog);
  });

  it("publishes the release before uploading, so a re-pushed tag is not a draft", () => {
    expect(release).toContain("--draft=false");
  });
});

describe("ci workflow", () => {
  const ci = read(".github/workflows/ci.yml");

  it("inspects the tarball contents before installing it", () => {
    expect(ci).toContain("npm pack --dry-run --json");
    expect(ci).toContain("dist/cli/index.js is missing from the tarball");
    expect(ci).toContain(".js.map files that point at sources it does not contain");
  });

  it("imports the packed entry point instead of trusting the CLI", () => {
    expect(ci).toContain("await import('repropack')");
    expect(ci).toContain("missing library export");
  });
});

describe("packaged build", () => {
  it("does not emit sourcemaps, since src/ is not in the tarball", () => {
    // tsconfig files here carry comments, so the text is matched directly.
    const build = read("tsconfig.build.json");
    expect(build).toMatch(/"sourceMap":\s*false/);
    expect(build).toMatch(/"declarationMap":\s*false/);
  });
});
