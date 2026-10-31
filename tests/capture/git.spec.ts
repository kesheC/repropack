import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRepository, stripCredentials } from "../../src/capture/git.js";
import { run, tryCapture } from "../../src/util/exec.js";

const dirs: string[] = [];

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "repropack-git-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (!dir) continue;
    // Windows keeps a handle open on the git object store for a moment after
    // the last git process exits, so a single rm can throw EBUSY. Retry with
    // backoff instead of failing the test that happened to run last.
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

describe("stripCredentials", () => {
  const cases: { name: string; input: string; expected: string }[] = [
    {
      name: "user:token userinfo",
      input: "https://user:token@github.com/o/r.git",
      expected: "https://github.com/o/r.git",
    },
    {
      name: "bare personal access token",
      input: "https://ghp_abcdef@github.com/o/r.git",
      expected: "https://github.com/o/r.git",
    },
    {
      name: "CI checkout token user",
      input: "https://x-access-token:ghs_secretvalue@github.com/o/r",
      expected: "https://github.com/o/r",
    },
    {
      name: "plain https remote",
      input: "https://github.com/o/r.git",
      expected: "https://github.com/o/r.git",
    },
    {
      name: "scp-style has no credentials",
      input: "git@github.com:o/r.git",
      expected: "git@github.com:o/r.git",
    },
    {
      name: "@ inside the path is not userinfo",
      input: "https://github.com/o/r@v1",
      expected: "https://github.com/o/r@v1",
    },
    {
      name: "ssh url with user only",
      input: "ssh://git@github.com/o/r.git",
      expected: "ssh://github.com/o/r.git",
    },
    {
      name: "token as password with port",
      input: "https://oauth2:abc123@gitlab.example.com:8443/g/p.git",
      expected: "https://gitlab.example.com:8443/g/p.git",
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(stripCredentials(testCase.input)).toBe(testCase.expected);
    });
  }

  it("never leaves the token in the output", () => {
    const out = stripCredentials("https://ghp_abcdef@github.com/o/r.git");
    expect(out).not.toContain("ghp_abcdef");
  });
});

describe("probeRepository outside a repository", () => {
  it("returns null instead of throwing", async () => {
    const dir = await makeDir();
    await expect(probeRepository(dir)).resolves.toBeNull();
  });

  it("returns null for a directory that does not exist", async () => {
    const missing = join(await makeDir(), "nope", "deeper");
    await expect(probeRepository(missing)).resolves.toBeNull();
  });
});

const gitAvailable = async (): Promise<boolean> => {
  const version = await tryCapture(["git", "--version"], { cwd: tmpdir(), timeoutMs: 10_000 });
  return version !== null;
};

describe("probeRepository inside a repository", () => {
  let repo: string;
  let usable = false;

  beforeEach(async () => {
    repo = await makeDir();
    usable = await gitAvailable();
    if (!usable) return;
    const init = await run(["git", "init", "-q"], { cwd: repo, timeoutMs: 30_000 });
    usable = init.exitCode === 0;
    if (!usable) return;
    await writeFile(join(repo, "a.txt"), "hello\n", "utf8");
    for (const argv of [
      ["git", "config", "user.email", "test@example.com"],
      ["git", "config", "user.name", "Test"],
      ["git", "add", "a.txt"],
      ["git", "commit", "-q", "-m", "init"],
      ["git", "remote", "add", "origin", "https://user:token@example.com/o/r.git"],
    ]) {
      const result = await run(argv, { cwd: repo, timeoutMs: 30_000 });
      if (result.exitCode !== 0) {
        usable = false;
        return;
      }
    }
  });

  it("reports commit, root and a clean worktree", async () => {
    if (!usable) return;
    const snapshot = await probeRepository(repo);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.vcs).toBe("git");
    expect(snapshot?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(snapshot?.dirty).toBe(false);
    expect(snapshot?.statusLines).toEqual([]);
    expect(snapshot?.root.toLowerCase()).toContain(repo.split(/[\\/]/).pop()?.toLowerCase() ?? "");
  });

  it("strips credentials from remotes", async () => {
    if (!usable) return;
    const snapshot = await probeRepository(repo);
    const origin = snapshot?.remotes.find((remote) => remote.name === "origin");
    expect(origin?.url).toBe("https://example.com/o/r.git");
    expect(JSON.stringify(snapshot?.remotes)).not.toContain("token");
  });

  it("marks a dirty worktree and lists changed files", async () => {
    if (!usable) return;
    await writeFile(join(repo, "b.txt"), "new\n", "utf8");
    const snapshot = await probeRepository(repo);
    expect(snapshot?.dirty).toBe(true);
    expect(snapshot?.statusLines.some((line) => line.includes("b.txt"))).toBe(true);
  });

  it("caps status lines at 200", async () => {
    if (!usable) return;
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 205; i += 1) {
      writes.push(writeFile(join(repo, "f" + String(i).padStart(3, "0") + ".txt"), "x", "utf8"));
    }
    await Promise.all(writes);
    const snapshot = await probeRepository(repo);
    expect(snapshot?.statusLines.length).toBe(200);
  }, 60_000);
});