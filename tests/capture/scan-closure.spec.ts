import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanWorktree } from "../../src/capture/scan.js";
import { run, tryCapture } from "../../src/util/exec.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const gitAvailable = async (): Promise<boolean> =>
  (await tryCapture(["git", "--version"], { cwd: tmpdir(), timeoutMs: 10_000 })) !== null;

/**
 * A committed git repo whose files are all unchanged.
 *
 * `scope: "changed"` then selects nothing at all, which isolates what this
 * suite is about: only the stack frames and their import closure should
 * survive, so anything else in the bundle is a widening bug.
 */
async function committedRepo(spec: Record<string, string>): Promise<string | null> {
  if (!(await gitAvailable())) return null;
  const dir = await mkdtemp(join(tmpdir(), "repropack-closure-scan-"));
  dirs.push(dir);
  for (const [relPath, body] of Object.entries(spec)) {
    const absolute = join(dir, relPath);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, body, "utf8");
  }
  for (const argv of [
    ["git", "init", "-q"],
    ["git", "config", "user.email", "test@example.com"],
    ["git", "config", "user.name", "Test"],
    ["git", "add", "-A"],
    ["git", "commit", "-qm", "init"],
  ]) {
    const result = await run(argv, { cwd: dir, timeoutMs: 30_000 });
    if (result.exitCode !== 0) return null;
  }
  return dir;
}

describe("scanWorktree with stack frames", () => {
  it("widens the stack-frame seeds to the local import closure", async () => {
    const root = await committedRepo({
      "src/main.js": 'import { share } from "./mathy.js";\nconsole.log(share(1, 0));\n',
      "src/mathy.js": "export function share(a, b) {\n  return (a / b) * 100;\n}\n",
      "src/unrelated.js": "export const unrelated = true;\n",
    });
    if (root === null) return;

    const result = await scanWorktree({
      cwd: root,
      scope: "changed",
      stackFramePaths: [join(root, "src", "main.js")],
    });
    const paths = result.files.map((file) => file.path).sort();
    expect(paths).toContain("src/main.js");
    expect(paths).toContain("src/mathy.js");
    // Nothing imported it and nothing changed, so it must stay out: a closure
    // that sweeps the whole directory would be no different from --scope all.
    expect(paths).not.toContain("src/unrelated.js");
    expect(result.files.find((file) => file.path === "src/mathy.js")?.reason).toBe("stack-frame");
  });
});
