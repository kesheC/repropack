import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanWorktree } from "../../src/capture/scan.js";
import { run, tryCapture } from "../../src/util/exec.js";

const dirs: string[] = [];

async function makeTree(spec: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "repropack-nested-"));
  dirs.push(dir);
  for (const [relPath, body] of Object.entries(spec)) {
    const absolute = join(dir, relPath);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, body, "utf8");
  }
  return dir;
}

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

const paths = (result: { files: readonly { path: string }[] }): string[] =>
  result.files.map((file) => file.path).sort();

const gitAvailable = async (): Promise<boolean> =>
  (await tryCapture(["git", "--version"], { cwd: tmpdir(), timeoutMs: 10_000 })) !== null;

/**
 * Regression suite for the scan root.
 *
 * The bug: the scan root was the *repository* root, so capturing from
 * 'packages/api' walked up and bundled every sibling project. On a real
 * checkout that turned a 4-file demo bundle into 221 files including
 * unrelated repositories and their test fixtures.
 */
describe("scanWorktree nested in a repository", () => {
  async function makeRepo(spec: Record<string, string>): Promise<string> {
    const dir = await makeTree(spec);
    if (!(await gitAvailable())) return dir;
    for (const argv of [
      ["git", "init", "-q"],
      ["git", "config", "user.email", "test@example.com"],
      ["git", "config", "user.name", "Test"],
      ["git", "add", "-A"],
      ["git", "commit", "-q", "-m", "init"],
    ]) {
      const result = await run(argv, { cwd: dir, timeoutMs: 30_000 });
      if (result.exitCode !== 0) return dir;
    }
    return dir;
  }

  it("scopes to the working directory, not the repository root", async () => {
    const dir = await makeRepo({
      "sibling/other.txt": "not mine",
      "packages/api/main.ts": "mine",
    });
    const cwd = join(dir, "packages", "api");
    const result = await scanWorktree({ cwd, scope: "all" });
    expect(paths(result)).toEqual(["main.ts"]);
  });

  it("reports paths relative to the working directory", async () => {
    const dir = await makeRepo({
      "packages/api/src/main.ts": "mine",
      "packages/api/README.md": "docs",
    });
    const result = await scanWorktree({ cwd: join(dir, "packages", "api"), scope: "all" });
    expect(paths(result)).toEqual(["README.md", "src/main.ts"]);
  });

  it("keeps changed files inside the working directory and drops the rest", async () => {
    const dir = await makeRepo({
      "packages/api/tracked.ts": "one",
      "sibling/other.txt": "not mine",
    });
    const api = join(dir, "packages", "api");
    await writeFile(join(api, "tracked.ts"), "one-changed", "utf8");
    await writeFile(join(api, "fresh.ts"), "new", "utf8");
    await writeFile(join(dir, "sibling", "other.txt"), "changed too", "utf8");
    const result = await scanWorktree({ cwd: api, scope: "changed" });
    expect(paths(result)).toEqual(["fresh.ts", "tracked.ts"]);
  });

  it("keeps tracked files inside the working directory and drops the rest", async () => {
    const dir = await makeRepo({
      "packages/api/tracked.ts": "one",
      "sibling/other.txt": "not mine",
    });
    const result = await scanWorktree({ cwd: join(dir, "packages", "api"), scope: "tracked" });
    expect(paths(result)).toEqual(["tracked.ts"]);
  });

  it("finds untracked files inside a new, still-untracked directory", async () => {
    // git collapses an untracked directory to one entry unless asked for
    // --untracked-files=all, and a collapsed entry can never match a file
    // path, so the whole directory silently vanished from "changed".
    const dir = await makeRepo({
      "a.txt": "tracked",
    });
    await writeFile(join(dir, "a.txt"), "tracked-changed", "utf8");
    await mkdir(join(dir, "feature", "deep"), { recursive: true });
    await writeFile(join(dir, "feature", "deep", "x.ts"), "new", "utf8");
    const result = await scanWorktree({ cwd: dir, scope: "changed" });
    expect(paths(result)).toEqual(["a.txt", "feature/deep/x.ts"]);
  });
});

describe("scanWorktree output directory", () => {
  it("never bundles the directory it is about to write", async () => {
    const dir = await makeTree({
      "main.ts": "code",
      "bundle/bundle.json": "{}",
      "bundle/files/main.ts": "code",
    });
    const result = await scanWorktree({ cwd: dir, scope: "all", outDir: join(dir, "bundle") });
    expect(paths(result)).toEqual(["main.ts"]);
  });

  it("ignores an output directory outside the working directory", async () => {
    const dir = await makeTree({
      "main.ts": "code",
    });
    const outside = await makeTree({});
    const result = await scanWorktree({ cwd: dir, scope: "all", outDir: outside });
    expect(paths(result)).toEqual(["main.ts"]);
  });
});
