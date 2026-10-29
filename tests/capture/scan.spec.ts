import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanWorktree, toMatcher } from "../../src/capture/scan.js";
import { run, tryCapture } from "../../src/util/exec.js";

const dirs: string[] = [];

async function makeTree(spec: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "repropack-scan-"));
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

const paths = (result: { files: readonly { path: string }[] }): string[] => result.files.map((file) => file.path);

describe("toMatcher", () => {
  it("matches * within one segment only", () => {
    const match = toMatcher("*.ts");
    expect(match("a.ts")).toBe(true);
    expect(match("a.js")).toBe(false);
    expect(match("src/a.ts")).toBe(false);
  });

  it("matches src/**/*.ts at any depth, including zero", () => {
    const match = toMatcher("src/**/*.ts");
    expect(match("src/a.ts")).toBe(true);
    expect(match("src/deep/a.ts")).toBe(true);
    expect(match("src/deep/deeper/a.ts")).toBe(true);
    expect(match("other/a.ts")).toBe(false);
  });

  it("treats a trailing slash as a directory", () => {
    const match = toMatcher("dist/");
    expect(match("dist")).toBe(true);
    expect(match("dist/a.js")).toBe(true);
    expect(match("dist-a.js")).toBe(false);
  });

  it("matches **/*.md anywhere", () => {
    const match = toMatcher("**/*.md");
    expect(match("README.md")).toBe(true);
    expect(match("docs/deep/notes.md")).toBe(true);
    expect(match("docs/notes.txt")).toBe(false);
  });

  it("treats ? as exactly one non-separator character", () => {
    const match = toMatcher("a?.ts");
    expect(match("ab.ts")).toBe(true);
    expect(match("a.ts")).toBe(false);
  });

  it("escapes regex metacharacters in the pattern", () => {
    const match = toMatcher("a+b.ts");
    expect(match("a+b.ts")).toBe(true);
    expect(match("aab.ts")).toBe(false);
  });
});

describe("scanWorktree directory skipping", () => {
  it("skips vendored and generated directories", async () => {
    const dir = await makeTree({
      "src/index.ts": "export const a = 1;",
      "node_modules/left-pad/index.js": "module.exports = 1;",
      ".git/config": "[core]",
      "dist/bundle.js": "var x;",
      "build/out.js": "var y;",
      "out/z.js": "var z;",
      "coverage/lcov.info": "TN:",
      ".next/static/chunk.js": "1",
      ".venv/pyvenv.cfg": "home = /usr",
      "__pycache__/m.cpython-311.pyc": "x",
      "target/debug/bin": "x",
      "vendor/lib.go": "package lib",
      ".repropack/last.json": "{}",
    });
    const result = await scanWorktree({ cwd: dir, scope: "all" });
    expect(paths(result)).toEqual(["src/index.ts"]);
  });

  it("skips directories named in the root .gitignore", async () => {
    const dir = await makeTree({
      ".gitignore": "tmp/\nlogs/\n*.tgz\n",
      "src/a.ts": "1",
      "tmp/scratch.txt": "2",
      "logs/run.log": "3",
      "kept.log": "4",
    });
    const result = await scanWorktree({ cwd: dir, scope: "all" });
    expect(paths(result)).toEqual([".gitignore", "kept.log", "src/a.ts"]);
  });

  it("returns nothing for an empty directory", async () => {
    const dir = await makeTree({});
    const result = await scanWorktree({ cwd: dir, scope: "all" });
    expect(result.files).toEqual([]);
    expect(result.totalBytes).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  it("emits POSIX relative paths and absolute paths", async () => {
    const dir = await makeTree({ "a/b/c.ts": "x" });
    const result = await scanWorktree({ cwd: dir, scope: "all" });
    expect(paths(result)).toEqual(["a/b/c.ts"]);
    expect(result.files[0]?.path).not.toContain("\\");
    expect(result.files[0]?.absolutePath).toContain("c.ts");
  });
});

describe("scanWorktree budgets", () => {
  it("skips a file over maxFileBytes and warns", async () => {
    const dir = await makeTree({ "small.txt": "1234", "big.txt": "x".repeat(64) });
    const result = await scanWorktree({ cwd: dir, scope: "all", maxFileBytes: 32 });
    expect(paths(result)).toEqual(["small.txt"]);
    expect(result.warnings.some((w) => w.includes("big.txt") && w.includes("large file"))).toBe(true);
  });

  it("stops adding files once maxBundleBytes is exhausted and warns", async () => {
    const dir = await makeTree({ "a.txt": "a".repeat(40), "b.txt": "b".repeat(40), "c.txt": "c".repeat(40) });
    const result = await scanWorktree({ cwd: dir, scope: "all", maxBundleBytes: 90 });
    expect(paths(result)).toEqual(["a.txt", "b.txt"]);
    expect(result.totalBytes).toBe(80);
    expect(result.warnings.some((w) => w.includes("budget"))).toBe(true);
  });

  it("never exceeds the byte budget", async () => {
    const dir = await makeTree({ "a.txt": "a".repeat(100), "b.txt": "b".repeat(100) });
    const result = await scanWorktree({ cwd: dir, scope: "all", maxBundleBytes: 150 });
    expect(result.totalBytes).toBeLessThanOrEqual(150);
    expect(paths(result)).toEqual(["a.txt"]);
  });

  it("reports totalBytes as the sum of the files it kept", async () => {
    const dir = await makeTree({ "a.txt": "abc", "b.txt": "de" });
    const result = await scanWorktree({ cwd: dir, scope: "all" });
    const sum = result.files.reduce((acc, file) => acc + file.bytes, 0);
    expect(result.totalBytes).toBe(sum);
    expect(result.totalBytes).toBe(5);
  });
});

describe("scanWorktree symlinks", () => {
  it("skips symlinks and warns rather than following them", async () => {
    const dir = await makeTree({ "real.txt": "content" });
    let created = false;
    try {
      await symlink(dir, join(dir, "loop"), "dir");
      created = true;
    } catch {
      // Windows without developer mode refuses symlink creation; the case is
      // unexercisable there, not failing.
      created = false;
    }
    if (!created) return;
    const result = await scanWorktree({ cwd: dir, scope: "all" });
    expect(paths(result)).toEqual(["real.txt"]);
    expect(result.warnings.some((w) => w.includes("symlink"))).toBe(true);
  });
});

describe("scanWorktree stability", () => {
  it("sorts by path and yields identical results on two runs", async () => {
    const dir = await makeTree({ "z.txt": "1", "a.txt": "2", "m/n.txt": "3", "m/a.txt": "4" });
    const first = await scanWorktree({ cwd: dir, scope: "all" });
    const second = await scanWorktree({ cwd: dir, scope: "all" });
    expect(paths(first)).toEqual(["a.txt", "m/a.txt", "m/n.txt", "z.txt"]);
    expect(first.files.map((f) => f.path)).toEqual(second.files.map((f) => f.path));
    expect(first.totalBytes).toBe(second.totalBytes);
  });

  it("marks executables only on POSIX", async () => {
    const dir = await makeTree({ "run.sh": "#!/bin/sh", "data.txt": "x" });
    if (process.platform === "win32") {
      const result = await scanWorktree({ cwd: dir, scope: "all" });
      expect(result.files.every((f) => f.mode === "100644")).toBe(true);
      return;
    }
    await chmod(join(dir, "run.sh"), 0o755);
    const result = await scanWorktree({ cwd: dir, scope: "all" });
    const byPath = new Map(result.files.map((f) => [f.path, f.mode]));
    expect(byPath.get("run.sh")).toBe("100755");
    expect(byPath.get("data.txt")).toBe("100644");
  });
});

describe("scanWorktree include globs", () => {
  it("labels include matches as inputs and everything else as changed", async () => {
    const dir = await makeTree({ "src/a.ts": "1", "docs/readme.md": "#", "other.txt": "3" });
    const result = await scanWorktree({ cwd: dir, scope: "all", include: ["**/*.md"] });
    const reasons = new Map(result.files.map((file) => [file.path, file.reason]));
    expect(reasons.get("docs/readme.md")).toBe("input");
    expect(reasons.get("src/a.ts")).toBe("changed");
    expect(reasons.get("other.txt")).toBe("changed");
  });

  it("rejects files matched by exclude", async () => {
    const dir = await makeTree({ "keep.ts": "1", "drop.ts": "2" });
    const result = await scanWorktree({ cwd: dir, scope: "all", exclude: ["drop.ts"] });
    expect(paths(result)).toEqual(["keep.ts"]);
  });
});

const gitAvailable = async (): Promise<boolean> =>
  (await tryCapture(["git", "--version"], { cwd: tmpdir(), timeoutMs: 10_000 })) !== null;

describe("scanWorktree scopes inside a repository", () => {
  let usable = false;

  async function makeRepo(files: Record<string, string>): Promise<string> {
    const dir = await makeTree(files);
    usable = await gitAvailable();
    if (!usable) return dir;
    for (const argv of [
      ["git", "init", "-q"],
      ["git", "config", "user.email", "test@example.com"],
      ["git", "config", "user.name", "Test"],
      ["git", "add", "-A"],
      ["git", "commit", "-q", "-m", "init"],
    ]) {
      const result = await run(argv, { cwd: dir, timeoutMs: 30_000 });
      if (result.exitCode !== 0) {
        usable = false;
        return dir;
      }
    }
    return dir;
  }

  it("tracked keeps committed files and drops untracked ones", async () => {
    const dir = await makeRepo({ "a.txt": "tracked" });
    if (!usable) return;
    await writeFile(join(dir, "b.txt"), "untracked", "utf8");
    const result = await scanWorktree({ cwd: dir, scope: "tracked" });
    expect(paths(result)).toEqual(["a.txt"]);
  });

  it("changed keeps only modified and untracked files", async () => {
    const dir = await makeRepo({ "a.txt": "one", "b.txt": "two" });
    if (!usable) return;
    await writeFile(join(dir, "a.txt"), "one-changed", "utf8");
    await writeFile(join(dir, "c.txt"), "brand new", "utf8");
    const result = await scanWorktree({ cwd: dir, scope: "changed" });
    expect(paths(result)).toEqual(["a.txt", "c.txt"]);
  });

  it("all includes untracked files", async () => {
    const dir = await makeRepo({ "a.txt": "tracked" });
    if (!usable) return;
    await writeFile(join(dir, "b.txt"), "untracked", "utf8");
    const result = await scanWorktree({ cwd: dir, scope: "all" });
    expect(paths(result)).toEqual(["a.txt", "b.txt"]);
  });

  it("falls back to every file with a warning outside a repository", async () => {
    const dir = await makeTree({ "a.txt": "x" });
    const result = await scanWorktree({ cwd: dir, scope: "changed" });
    expect(paths(result)).toEqual(["a.txt"]);
    expect(result.warnings.some((w) => w.includes("not a git repository"))).toBe(true);
  });
});
