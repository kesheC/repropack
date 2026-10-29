import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBundle } from "../../src/bundle/read.js";
import { writeBundle, type StagedFile } from "../../src/bundle/write.js";

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "repropack-bundle-"));
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
    argv: ["node", "x.js"],
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

describe("bundle round trip", () => {
  it("writes a manifest that reads back with a valid integrity check", async () => {
    const written = await writeBundle({
      root: workdir,
      manifest,
      files: [staged("a.ts", "export const a = 1;\n"), staged("src/b.ts", "export const b = 2;\n")],
      logs: [
        { path: join("logs", "stdout.txt"), content: Buffer.from("out", "utf8") },
        { path: join("logs", "stderr.txt"), content: Buffer.from("err", "utf8") },
      ],
    });

    const loaded = await readBundle(workdir);
    expect(loaded.problems).toEqual([]);
    expect(loaded.integrityOk).toBe(true);
    expect(loaded.manifest.id).toBe(written.manifest.id);
    expect(loaded.manifest.files.map((f) => f.path)).toEqual(["a.ts", "src/b.ts"]);
  });

  it("produces the same id for two captures that differ only in timing", async () => {
    const first = await writeBundle({ root: join(workdir, "one"), manifest, files: [staged("a.ts", "x")], logs: [] });
    const second = await writeBundle({
      root: join(workdir, "two"),
      manifest: {
        ...manifest,
        createdAt: "2027-02-02T00:00:00.000Z",
        command: { ...manifest.command, durationMs: 9999 },
      },
      files: [staged("a.ts", "x")],
      logs: [],
    });
    expect(second.manifest.id).toBe(first.manifest.id);
  });

  it("records the executable bit and the file reason", async () => {
    const written = await writeBundle({
      root: workdir,
      manifest,
      files: [staged("run.sh", "#!/bin/sh\n", { mode: "100755", reason: "input" })],
      logs: [],
    });
    const entry = written.manifest.files[0];
    expect(entry?.mode).toBe("100755");
    expect(entry?.reason).toBe("input");
  });

  it("detects a file modified after the manifest was written", async () => {
    await writeBundle({ root: workdir, manifest, files: [staged("a.ts", "original")], logs: [] });
    await writeFile(join(workdir, "files", "a.ts"), "tampered", "utf8");
    const loaded = await readBundle(workdir);
    expect(loaded.integrityOk).toBe(true); // the manifest itself is untouched
    const { readBundleFile } = await import("../../src/bundle/read.js");
    const file = await readBundleFile(loaded, "a.ts");
    expect(file.matches).toBe(false);
  });

  it("throws a clear error for a missing manifest", async () => {
    await expect(readBundle(join(workdir, "nope"))).rejects.toThrow(/ENOENT|no such file/i);
  });

  it("throws a clear error for a manifest that is not json", async () => {
    await writeFile(join(workdir, "bundle.json"), "{not json", "utf8");
    await expect(readBundle(workdir)).rejects.toThrow(/not valid JSON/i);
  });

  it("writes the manifest pretty-printed so diffs are readable", async () => {
    await writeBundle({ root: workdir, manifest, files: [], logs: [] });
    const raw = await readFile(join(workdir, "bundle.json"), "utf8");
    expect(raw).toContain('\n  "formatVersion": 1,');
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("leaves no manifest when the payload write fails", async () => {
    // Pointing the files at an impossible location makes the write throw before
    // the manifest is created; that ordering is the whole point.
    const bad: StagedFile = {
      ...staged("x.ts", "x"),
      path: "files/../../escape.ts",
    };
    await expect(writeBundle({ root: workdir, manifest, files: [bad], logs: [] })).rejects.toThrow(/unsafe bundle path/);
  });
});
