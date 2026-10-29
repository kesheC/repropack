import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run, runCapture, tryCapture } from "../../src/util/exec.js";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "repropack-exec-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const node = process.execPath;

describe("run", () => {
  it("captures stdout and a zero exit code", async () => {
    const result = await run([node, "-e", "process.stdout.write('hello')"], { cwd });
    expect(result.stdout).toBe("hello");
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.timedOut).toBe(false);
  });

  it("captures stderr separately", async () => {
    const result = await run([node, "-e", "process.stderr.write('bad')"], { cwd });
    expect(result.stderr).toBe("bad");
    expect(result.stdout).toBe("");
  });

  it("reports a non-zero exit code without throwing", async () => {
    const result = await run([node, "-e", "process.exit(3)"], { cwd });
    expect(result.exitCode).toBe(3);
  });

  it("kills the child and flags the timeout", async () => {
    const result = await run([node, "-e", "setTimeout(() => {}, 60000)"], { cwd, timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it("does not use a shell, so metacharacters stay literal arguments", async () => {
    // Under a shell this would run `echo hi` twice; without one it is a single
    // literal argument, which is exactly what the bundle records.
    const result = await run([node, "-e", "process.stdout.write(process.argv.slice(1).join('|'))", "a", "&&", "b"], {
      cwd,
    });
    expect(result.stdout).toBe("a|&&|b");
  });

  it("passes a custom environment", async () => {
    const result = await run([node, "-e", "process.stdout.write(String(process.env.REPROPACK_TEST))"], {
      cwd,
      env: { ...process.env, REPROPACK_TEST: "yes" },
    });
    expect(result.stdout).toBe("yes");
  });

  it("feeds stdin when provided", async () => {
    const result = await run([node, "-e", "process.stdin.pipe(process.stdout)"], { cwd, stdin: "piped" });
    expect(result.stdout).toBe("piped");
  });

  it("caps retained log bytes", async () => {
    const result = await run([node, "-e", "process.stdout.write('x'.repeat(5000))"], { cwd, maxLogBytes: 100 });
    expect(result.stdout.length).toBeLessThanOrEqual(100);
  });

  it("rejects an empty argv instead of hanging", async () => {
    await expect(run([], { cwd })).rejects.toThrow(/argv must contain/i);
  });

  it("rejects when the executable does not exist", async () => {
    await expect(run(["definitely-not-a-real-binary-xyz"], { cwd })).rejects.toThrow();
  });
});

describe("runCapture", () => {
  it("returns trimmed stdout", async () => {
    // Build the newline at runtime: embedding an escape here would be
    // interpreted by the outer string before node ever sees the -e script.
    const script = "process.stdout.write('  spaced  ' + String.fromCharCode(10))";
    expect(await runCapture([node, "-e", script], { cwd })).toBe("spaced");
  });

  it("throws with the command in the message on failure", async () => {
    await expect(runCapture([node, "-e", "process.exit(9)"], { cwd })).rejects.toThrow(/exit 9/);
  });
});

describe("tryCapture", () => {
  it("returns null for a missing binary", async () => {
    expect(await tryCapture(["definitely-not-a-real-binary-xyz"], { cwd })).toBeNull();
  });

  it("returns null for a non-zero exit", async () => {
    expect(await tryCapture([node, "-e", "process.exit(4)"], { cwd })).toBeNull();
  });

  it("returns the output when the command works", async () => {
    expect(await tryCapture([node, "-e", "process.stdout.write('ok')"], { cwd })).toBe("ok");
  });
});
