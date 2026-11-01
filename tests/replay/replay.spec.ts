import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { replay } from "../../src/replay/index.js";
import { writeBundle, type StagedFile } from "../../src/bundle/write.js";

let workdir: string;
const node = process.execPath;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "repropack-replay-"));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

function staged(path: string, text: string, mode: "100644" | "100755" = "100644"): StagedFile {
  return {
    path: "files/" + path,
    sourcePath: path,
    content: Buffer.from(text, "utf8"),
    mode,
    reason: "changed",
    truncated: false,
  };
}

async function makeBundle(
  options: {
    files: StagedFile[];
    argv?: string[];
    exitCode?: number | null;
    name?: string;
    /** What the captured run wrote to stderr; replay compares against it. */
    recordedStderr?: string;
  },
): Promise<string> {
  const root = join(workdir, options.name ?? "bundle");
  await writeBundle({
    root,
    files: options.files,
    logs:
      options.recordedStderr === undefined
        ? []
        : [{ path: join("logs", "stderr.txt"), content: Buffer.from(options.recordedStderr, "utf8") }],
    manifest: {
      formatVersion: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      producer: { name: "repropack", version: "0.1.0", node: "v20.11.0" },
      command: {
        argv: options.argv ?? [node, "fail.js"],
        cwd: ".",
        startedAt: "2026-01-01T00:00:00.000Z",
        durationMs: 10,
        exitCode: options.exitCode === undefined ? 1 : options.exitCode,
        signal: null,
        stdoutPath: "logs/stdout.txt",
        stderrPath: "logs/stderr.txt",
        truncated: false,
      },
      environment: {
        platform: "linux",
        arch: "x64",
        release: "6.0",
        node: "v20.11.0",
        nodeAbi: "115",
        packageManager: null,
        env: {},
        timezone: "UTC",
        locale: "en-US",
        resources: null,
      },
      repository: null,
      redaction: { rulesVersion: "1", totalMatches: 0, byRule: [], bySurface: [], skipped: [] },
      warnings: [],
    },
  });
  return root;
}

const failingScript = "console.error('boom: expected failure');\nprocess.exit(1);\n";

describe("replay", () => {
  it("reproduces a failing command and reports ok", async () => {
    const bundle = await makeBundle({ files: [staged("fail.js", failingScript)], exitCode: 1 });
    const result = await replay({ bundle });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.expectedExitCode).toBe(1);
    expect(result.stderr).toContain("boom");
    expect(result.reasons).toEqual([]);
  });

  it("materialises files into an explicit workdir and keeps them", async () => {
    const bundle = await makeBundle({ files: [staged("fail.js", failingScript)], exitCode: 1 });
    const target = join(workdir, "materialised");
    const result = await replay({ bundle, workdir: target, keep: true });
    expect(result.workdir).toBe(target);
    const content = await readFile(join(target, "fail.js"), "utf8");
    expect(content).toContain("boom");
  });

  it("restores the executable bit on posix", async () => {
    if (process.platform === "win32") return;
    const bundle = await makeBundle({
      files: [staged("run.sh", "#!/bin/sh\nexit 1\n", "100755")],
      argv: ["sh", "run.sh"],
      exitCode: 1,
    });
    const target = join(workdir, "exec");
    await replay({ bundle, workdir: target, keep: true });
    const info = await stat(join(target, "run.sh"));
    expect(info.mode & 0o111).not.toBe(0);
  });

  it("reports an exit-code drift instead of claiming success", async () => {
    // The bundle claims exit 1 but the script exits 0: a replay that "passes"
    // here would be a false negative, which is worse than a hard failure.
    const bundle = await makeBundle({
      files: [staged("fail.js", "process.exit(0);\n")],
      exitCode: 1,
    });
    const result = await replay({ bundle });
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.kind === "exit-code")).toBe(true);
  });

  it("can ignore the exit code when the caller only wants the output", async () => {
    const bundle = await makeBundle({
      files: [staged("fail.js", "console.log('ran');\nprocess.exit(0);\n")],
      exitCode: 1,
    });
    const result = await replay({ bundle, ignoreExitCode: true });
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("ran");
  });

  it("flags a missing file and still runs what it has", async () => {
    const bundle = await makeBundle({ files: [staged("fail.js", failingScript)], exitCode: 1 });
    await rm(join(bundle, "files", "fail.js"));
    const result = await replay({ bundle });
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.kind === "missing-file")).toBe(true);
  });

  it("flags a file whose hash no longer matches", async () => {
    const bundle = await makeBundle({ files: [staged("fail.js", failingScript)], exitCode: 1 });
    await writeFile(join(bundle, "files", "fail.js"), "console.log('swapped');", "utf8");
    const result = await replay({ bundle });
    expect(result.ok).toBe(false);
    const mismatch = result.reasons.find((r) => r.kind === "hash-mismatch");
    expect(mismatch).toBeTruthy();
  });

  it("flags a broken manifest integrity", async () => {
    const bundle = await makeBundle({ files: [staged("fail.js", failingScript)], exitCode: 1 });
    const manifestPath = join(bundle, "bundle.json");
    const raw = JSON.parse(await readFile(manifestPath, "utf8")) as { warnings: string[] };
    raw.warnings.push("edited after the fact");
    await writeFile(manifestPath, JSON.stringify(raw, null, 2), "utf8");
    const result = await replay({ bundle });
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.kind === "integrity")).toBe(true);
  });

  it("reports a timeout rather than hanging", async () => {
    const bundle = await makeBundle({
      files: [staged("slow.js", "setTimeout(() => {}, 60000);\n")],
      argv: [node, "slow.js"],
      exitCode: 0,
    });
    const result = await replay({ bundle, timeoutMs: 400 });
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.kind === "timeout")).toBe(true);
  });

  it("refuses a bundle that records no command", async () => {
    const bundle = await makeBundle({ files: [], argv: [], exitCode: null });
    const result = await replay({ bundle });
    expect(result.ok).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("says the failure drifted when the error message differs", async () => {
    // The trap this tool creates for itself: capture redacts a token out of argv,
    // so the replayed command fails on the placeholder instead of the token. Same
    // exit code, different bug -- and the old code called that faithful.
    const bundle = await makeBundle({
      files: [
        staged(
          "fail.js",
          "const token = process.argv[2] ?? '';\n" +
            "if (token.startsWith('REDACTED_')) {\n" +
            "  console.error('auth failed: token ' + token + ' is a placeholder');\n" +
            "} else {\n" +
            "  console.error('auth failed: token ' + token.slice(0, 3) + '*** has length ' + token.length);\n" +
            "}\n" +
            "process.exit(1);\n",
        ),
      ],
      argv: [node, "fail.js", "REDACTED_OPENAI_KEY"],
      exitCode: 1,
      recordedStderr: "auth failed: token sk-*** has length 40\n",
    });

    const result = await replay({ bundle });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    const drift = result.reasons.find((reason) => reason.kind === "integrity");
    expect(drift).toBeTruthy();
    if (drift?.kind !== "integrity") throw new Error("expected an integrity reason");
    expect(drift.detail).toContain("failed differently");
    expect(drift.detail).toContain("has length 40");
    expect(drift.detail).toContain("is a placeholder");
  });

  it("still calls a replay faithful when only the paths and timings moved", async () => {
    // The other half of the same judgement: a temp directory that differs between
    // machines is not a reproduction failure, and reporting it would train people
    // to ignore the one finding that does matter.
    const bundle = await makeBundle({
      files: [
        staged(
          "fail.js",
          "console.error('Error: boom at ' + process.cwd() + ' after 12ms');\nprocess.exit(1);\n",
        ),
      ],
      exitCode: 1,
      recordedStderr: "Error: boom at C:\\Users\\alice\\work after 7ms\n    at fail.js:1:1\n",
    });

    const result = await replay({ bundle });

    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("reports a drift when the recorded run printed nothing at all", async () => {
    const bundle = await makeBundle({
      files: [staged("fail.js", "console.error('Error: boom');\nprocess.exit(1);\n")],
      exitCode: 1,
      recordedStderr: "",
    });

    const result = await replay({ bundle });

    expect(result.ok).toBe(false);
    const drift = result.reasons.find((reason) => reason.kind === "integrity");
    expect(drift).toBeTruthy();
    if (drift?.kind !== "integrity") throw new Error("expected an integrity reason");
    expect(drift.detail).toContain("no stderr output");
  });

  it("leaves no workdir behind when the bundle records no command", async () => {
    // That branch returns before the run, and used to skip the cleanup with it.
    const bundle = await makeBundle({ files: [], argv: [], exitCode: null });
    const result = await replay({ bundle });
    await expect(stat(result.workdir)).rejects.toThrow();
  });

  it("cleans up the temp workdir unless asked to keep it", async () => {
    const bundle = await makeBundle({ files: [staged("fail.js", failingScript)], exitCode: 1 });
    const kept = await makeBundle({ files: [staged("fail.js", failingScript)], exitCode: 1, name: "kept" });
    const keptResult = await replay({ bundle: kept, keep: true });
    await expect(stat(keptResult.workdir)).resolves.toBeTruthy();
    const tempResult = await replay({ bundle });
    await expect(stat(tempResult.workdir)).rejects.toThrow();
  });
});
