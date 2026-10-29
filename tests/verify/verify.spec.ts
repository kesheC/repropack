import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeBundle, type StagedFile } from "../../src/bundle/write.js";
import type { Bundle } from "../../src/types.js";
import { verifyBundle } from "../../src/verify/index.js";

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "repropack-verify-"));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

function staged(path: string, text: string, extra: Partial<StagedFile> = {}): StagedFile {
  return {
    path: "files/" + path,
    sourcePath: path,
    content: Buffer.from(text, "utf8"),
    mode: "100644",
    reason: "changed",
    truncated: false,
    ...extra,
  };
}

const manifest = {
  formatVersion: 1 as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  producer: { name: "repropack" as const, version: "0.1.0", node: "v20.11.0" },
  command: {
    argv: ["node", "t.js"],
    cwd: ".",
    startedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 5,
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
    env: {} as Record<string, string>,
    timezone: "UTC",
    locale: "en-US",
    resources: null,
  },
  repository: null,
  redaction: { rulesVersion: "1", totalMatches: 0, byRule: [], bySurface: [], skipped: [] },
  warnings: [] as string[],
};

/** Write a bundle and return its directory. */
async function build(
  files: readonly StagedFile[],
  options: { argv?: readonly string[]; logs?: readonly { path: string; content: Buffer }[] } = {},
): Promise<string> {
  await writeBundle({
    root: workdir,
    manifest: options.argv
      ? { ...manifest, command: { ...manifest.command, argv: options.argv } }
      : manifest,
    files,
    logs: options.logs ?? [
      { path: "logs/stdout.txt", content: Buffer.from("ran fine\n", "utf8") },
      { path: "logs/stderr.txt", content: Buffer.from("Error: boom\n", "utf8") },
    ],
  });
  return workdir;
}

async function manifestOf(root: string): Promise<Bundle> {
  return JSON.parse(await readFile(join(root, "bundle.json"), "utf8")) as Bundle;
}

async function writeManifest(root: string, bundle: Bundle): Promise<void> {
  await writeFile(join(root, "bundle.json"), JSON.stringify(bundle, null, 2) + "\n", "utf8");
}

/** A plausible-looking key, assembled at runtime so the literal never lands in git. */
const FAKE_KEY = "sk-" + "proj-" + "A".repeat(24);

describe("verifyBundle: a healthy bundle", () => {
  it("passes a clean bundle with no findings at all", async () => {
    const root = await build([staged("src/a.ts", "export const a = 1;\n")]);
    const result = await verifyBundle(root);

    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("verifies a bundle that carries no logs directory", async () => {
    const root = await build([staged("a.ts", "export const a = 1;\n")], { logs: [] });
    const result = await verifyBundle(root);

    expect(result.ok).toBe(true);
    expect(result.findings.filter((f) => f.severity === "blocker")).toEqual([]);
  });

  it("keeps a home path redacted by capture acceptable", async () => {
    // Regression: capture rewrites C:\Users\alice to C:\Users\REDACTED_USER_HOME_PATH.
    // Re-scanning that output used to trip the same rule and the same name check,
    // so every bundle captured from a home directory came back unverifiable.
    const root = await build([staged("a.ts", 'const home = "C:\\Users\\REDACTED_USER_HOME_PATH\\app";\n')]);
    const result = await verifyBundle(root);

    expect(result.findings.filter((f) => f.code === "leak-suspected")).toEqual([]);
    expect(result.findings.filter((f) => f.code === "user-home-leak")).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("verifyBundle: integrity", () => {
  it("reports a manifest whose own hash no longer matches", async () => {
    const root = await build([staged("a.ts", "export const a = 1;\n")]);
    const bundle = await manifestOf(root);
    const tampered: Bundle = {
      ...bundle,
      files: bundle.files.map((f) => ({ ...f, sha256: "0".repeat(64) })),
    };
    await writeManifest(root, tampered);

    const result = await verifyBundle(root);

    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === "integrity-mismatch")).toBe(true);
  });

  it("catches a payload changed after the manifest was written", async () => {
    const root = await build([staged("a.ts", "export const a = 1;\n")]);
    await writeFile(join(root, "files", "a.ts"), "export const a = 666;\n", "utf8");

    const result = await verifyBundle(root);
    const hit = result.findings.find((f) => f.code === "integrity-mismatch" && f.path === "files/a.ts");

    expect(hit?.severity).toBe("blocker");
    expect(result.ok).toBe(false);
  });

  it("turns an unreadable bundle into a finding instead of throwing", async () => {
    const result = await verifyBundle(join(workdir, "does-not-exist"));

    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.code).toBe("integrity-mismatch");
  });

  it("turns a manifest that is not json into a finding instead of throwing", async () => {
    await mkdir(workdir, { recursive: true });
    await writeFile(join(workdir, "bundle.json"), "{not json", "utf8");

    const result = await verifyBundle(workdir);

    expect(result.ok).toBe(false);
    expect(result.findings[0]?.severity).toBe("blocker");
  });

  it("rejects a manifest that points files outside the bundle", async () => {
    const root = await build([staged("a.ts", "export const a = 1;\n")]);
    const bundle = await manifestOf(root);
    const hostile: Bundle = {
      ...bundle,
      files: [...bundle.files, { ...bundle.files[0]!, path: "../../etc/passwd" }],
    };
    await writeManifest(root, hostile);

    const result = await verifyBundle(root);

    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === "integrity-mismatch")).toBe(true);
  });
});

describe("verifyBundle: missing files", () => {
  it("reports a file the manifest lists but files/ does not have", async () => {
    const root = await build([staged("a.ts", "export const a = 1;\n"), staged("b.ts", "export const b = 2;\n")]);
    await unlink(join(root, "files", "b.ts"));

    const result = await verifyBundle(root);
    const hit = result.findings.find((f) => f.code === "missing-file");

    expect(hit?.severity).toBe("blocker");
    expect(hit?.path).toBe("files/b.ts");
    expect(result.ok).toBe(false);
  });
});

describe("verifyBundle: leaks", () => {
  it("blocks a key that never went through redaction", async () => {
    // The fixture is written straight to disk, so the capture-time engine never
    // saw it. That is exactly the bundling path this scan defends.
    const root = await build([staged("leak.ts", 'export const key = "' + FAKE_KEY + '";\n')]);

    const result = await verifyBundle(root);
    const hit = result.findings.find((f) => f.code === "leak-suspected");

    expect(hit?.severity).toBe("blocker");
    expect(hit?.path).toBe("files/leak.ts");
    expect(hit?.message).toContain("openai-key");
    expect(hit?.message).toContain("1 time");
    expect(result.ok).toBe(false);
  });

  it("never echoes the matched secret in the finding", async () => {
    const root = await build([staged("leak.ts", 'export const key = "' + FAKE_KEY + '";\n')]);
    const result = await verifyBundle(root);

    for (const finding of result.findings) expect(finding.message).not.toContain(FAKE_KEY);
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
  });

  it("scans the captured logs as well as the payload", async () => {
    const root = await build([staged("a.ts", "export const a = 1;\n")], {
      logs: [{ path: "logs/stderr.txt", content: Buffer.from("token=" + FAKE_KEY + "\n", "utf8") }],
    });

    const result = await verifyBundle(root);
    const hit = result.findings.find((f) => f.code === "leak-suspected");

    expect(hit?.path).toBe("logs/stderr.txt");
    expect(result.ok).toBe(false);
  });

  it("counts every occurrence of the same rule once per surface", async () => {
    const root = await build([
      staged("leak.ts", 'const a = "' + FAKE_KEY + '";\nconst b = "' + FAKE_KEY + '";\n'),
    ]);

    const result = await verifyBundle(root);
    const hits = result.findings.filter((f) => f.code === "leak-suspected");

    expect(hits).toHaveLength(1);
    expect(hits[0]?.message).toContain("2 times");
  });

  it("flags a real home name as a warning, not a blocker", async () => {
    const root = await build([staged("a.ts", 'const p = "C:\\Users\\alice\\project\\app.ts";\n')]);

    const result = await verifyBundle(root);
    const hit = result.findings.find((f) => f.code === "user-home-leak");

    expect(hit?.severity).toBe("warning");
    expect(hit?.path).toBe("files/a.ts");
    expect(hit?.message).toContain('"alice"');
    expect(result.ok).toBe(true);
  });

  it("does not mistake a shared container directory for a person", async () => {
    const root = await build([staged("a.ts", 'const p = "C:\\Users\\Public\\shared.txt";\n')]);

    const result = await verifyBundle(root);

    expect(result.findings.filter((f) => f.code === "user-home-leak")).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("verifyBundle: replayability", () => {
  it("blocks argv that hides the command inside a shell", async () => {
    const root = await build([staged("a.ts", "export const a = 1;\n")], {
      argv: ["bash", "-c", "node t.js"],
    });

    const result = await verifyBundle(root);
    const hit = result.findings.find((f) => f.code === "no-reproducible-command");

    expect(hit?.severity).toBe("blocker");
    expect(hit?.path).toBe("bundle.json");
    expect(hit?.message).toContain("bash");
    expect(result.ok).toBe(false);
  });

  it("recognises a shell behind a path and a .exe suffix", async () => {
    const root = await build([staged("a.ts", "export const a = 1;\n")], {
      argv: ["C:\\\\Windows\\\\System32\\\\cmd.exe", "/c", "node t.js"],
    });

    const result = await verifyBundle(root);

    expect(result.findings.some((f) => f.code === "no-reproducible-command")).toBe(true);
  });

  it("accepts a normal argv", async () => {
    const root = await build([staged("a.ts", "export const a = 1;\n")], { argv: ["node", "--test", "t.test.js"] });

    const result = await verifyBundle(root);

    expect(result.findings.filter((f) => f.code === "no-reproducible-command")).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("verifyBundle: size and paths", () => {
  it("warns about a single oversized file", async () => {
    const root = await build([staged("big.log", "x".repeat(1_200_000))]);

    const result = await verifyBundle(root);
    const hit = result.findings.find((f) => f.code === "oversize" && f.path === "files/big.log");

    expect(hit?.severity).toBe("warning");
    expect(hit?.message).toContain("1.1 MB");
    expect(result.ok).toBe(true);
  });

  it("notes absolute paths without failing the bundle", async () => {
    const root = await build([staged("a.ts", 'const mod = "/usr/local/lib/node_modules/x/index.js";\n')]);

    const result = await verifyBundle(root);
    const hit = result.findings.find((f) => f.code === "absolute-path");

    expect(hit?.severity).toBe("note");
    expect(hit?.path).toBe("files/a.ts");
    expect(result.ok).toBe(true);
  });

  it("keeps urls, dates and clock times out of the absolute-path note", async () => {
    const root = await build([
      staged("a.ts", 'const u = "https://example.com/a/b"; const d = "10/29"; const t = "12:30:00";\n'),
    ]);

    const result = await verifyBundle(root);

    expect(result.findings.filter((f) => f.code === "absolute-path")).toEqual([]);
  });
});

describe("verifyBundle: strict mode and ordering", () => {
  it("fails a warning only when strict is on", async () => {
    const root = await build([staged("a.ts", 'const p = "C:\\Users\\alice\\app.ts";\n')]);

    const relaxed = await verifyBundle(root);
    const strict = await verifyBundle(root, { strict: true });

    expect(relaxed.ok).toBe(true);
    expect(strict.ok).toBe(false);
    expect(strict.findings).toEqual(relaxed.findings);
  });

  it("fails on a blocker even without strict", async () => {
    const root = await build([staged("a.ts", 'const key = "' + FAKE_KEY + '";\n')]);

    const result = await verifyBundle(root, { strict: false });

    expect(result.ok).toBe(false);
  });

  it("sorts findings by severity, then code, then path", async () => {
    const root = await build([
      staged("z.ts", 'const p = "C:\\Users\\alice\\app.ts";\n'),
      staged("a.ts", 'const key = "' + FAKE_KEY + '";\nconst mod = "/usr/local/lib/x/y.js";\n'),
    ], { argv: ["bash", "-c", "node t.js"] });

    const result = await verifyBundle(root);
    const rank: Record<string, number> = { blocker: 0, warning: 1, note: 2 };
    const codes = result.findings.map((f) => f.code);
    const severities = result.findings.map((f) => rank[f.severity] ?? 9);

    expect(severities).toEqual([...severities].sort((a, b) => a - b));
    // Same severity bucket: leak-suspected sorts before no-reproducible-command.
    expect(result.findings[0]?.code).toBe("leak-suspected");
    expect(result.findings[1]?.code).toBe("no-reproducible-command");
    // warning (user-home-leak) outranks note (absolute-path) even though "absolute-path" < "user-home-leak" alphabetically;
    // the two notes then break the tie by path ("a.ts" before "z.ts").
    expect(codes).toEqual([
      "leak-suspected",
      "no-reproducible-command",
      "user-home-leak",
      "absolute-path",
      "absolute-path",
    ]);
    expect(result.findings.slice(3).map((f) => f.path)).toEqual(["files/a.ts", "files/z.ts"]);
  });

  it("produces byte-identical output for repeated runs", async () => {
    const root = await build([
      staged("z.ts", 'const p = "C:\\Users\\alice\\app.ts";\n'),
      staged("a.ts", 'const key = "' + FAKE_KEY + '";\n'),
    ], { argv: ["sh", "-c", "node t.js"] });

    const first = await verifyBundle(root);
    const second = await verifyBundle(root);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(new Set(first.findings.map((f) => JSON.stringify(f))).size).toBe(first.findings.length);
  });
});
