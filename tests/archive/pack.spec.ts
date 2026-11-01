import { mkdir, mkdtemp, readFile, readdir, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_ARCHIVE_BYTES, packBundle, unpackBundle } from "../../src/archive/index.js";
import { gzipTar } from "../../src/archive/tar.js";
import { writeBundle, type StagedFile } from "../../src/bundle/write.js";
import type { Bundle } from "../../src/types.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "repropack-archive-"));
}

const manifest: Omit<Bundle, "files" | "integrity" | "id"> = {
  formatVersion: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  producer: { name: "repropack", version: "0.1.0", node: "v20.11.0" },
  command: {
    argv: ["node", "main.js"],
    cwd: ".",
    startedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 10,
    exitCode: 1,
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
};

function staged(path: string, text: string): StagedFile {
  return {
    path: "files/" + path,
    sourcePath: path,
    content: Buffer.from(text, "utf8"),
    mode: "100644",
    reason: "changed",
    truncated: false,
  };
}

/**
 * A real bundle, not a hand-written bundle.json.
 *
 * packBundle reads the manifest to decide what belongs to the bundle, so a
 * fixture with a placeholder manifest would test a bundle the tool can never
 * produce.
 */
async function makeBundle(root: string): Promise<void> {
  await writeBundle({
    root,
    files: [staged("main.ts", "export const x = 1;")],
    logs: [{ path: join("logs", "stderr.txt"), content: Buffer.from("boom", "utf8") }],
    manifest,
  });
  await writeFile(join(root, "replay.sh"), "#!/bin/sh", { encoding: "utf8", mode: 0o755 });
}

describe("packBundle", () => {
  it("packs the files the manifest declares", async () => {
    const dir = await tempDir();
    const root = join(dir, "bundle");
    await makeBundle(root);
    const result = await packBundle({ root, out: join(dir, "b.repropack") });
    // bundle.json, files/main.ts, logs/stderr.txt, replay.sh
    expect(result.entries).toBe(4);
    expect(result.bytes).toBeGreaterThan(0);
  });

  it("leaves out files the manifest does not declare", async () => {
    // The archive is the artifact that gets published. A .env sitting next to
    // the logs is invisible to verify when it is only on disk; it becomes a
    // leak the moment it is compressed and attached to an issue.
    const dir = await tempDir();
    const root = join(dir, "bundle");
    await makeBundle(root);
    await writeFile(join(root, ".env"), "AWS_SECRET_ACCESS_KEY=hunter2", "utf8");
    await writeFile(join(root, "files", "untracked.txt"), "not in the manifest", "utf8");
    const archive = join(dir, "b.repropack");
    await packBundle({ root, out: archive });

    const out = join(dir, "out");
    await unpackBundle({ archive, out });
    expect(await readdir(out)).not.toContain(".env");
    expect(await readdir(join(out, "files"))).toEqual(["main.ts"]);
    // And the bytes really are absent, not just the entry name.
    expect((await readFile(archive)).includes(Buffer.from("hunter2"))).toBe(false);
  });

  it("refuses a directory that is not a bundle", async () => {
    const dir = await tempDir();
    const root = join(dir, "not-a-bundle");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "notes.txt"), "hello", "utf8");
    await expect(packBundle({ root, out: join(dir, "x.repropack") })).rejects.toThrow(/bundle.json/);
  });

  it("produces byte-identical output for the same bundle", async () => {
    // Two packs of one bundle must be comparable by hash; that is what lets a
    // maintainer tell an edited attachment from a re-uploaded one.
    const dir = await tempDir();
    const root = join(dir, "bundle");
    await makeBundle(root);
    const a = await packBundle({ root, out: join(dir, "a.repropack") });
    const b = await packBundle({ root, out: join(dir, "b.repropack") });
    expect(a.bytes).toBe(b.bytes);
    const first = await readFile(join(dir, "a.repropack"));
    const second = await readFile(join(dir, "b.repropack"));
    expect(first.equals(second)).toBe(true);
  });

  it("refuses an empty directory", async () => {
    const dir = await tempDir();
    const root = join(dir, "empty");
    await mkdir(root, { recursive: true });
    await expect(packBundle({ root, out: join(dir, "x.repropack") })).rejects.toThrow(/empty/);
  });
});

describe("unpackBundle", () => {
  it("round-trips a bundle directory", async () => {
    const dir = await tempDir();
    const root = join(dir, "bundle");
    await makeBundle(root);
    const archive = join(dir, "b.repropack");
    await packBundle({ root, out: archive });

    const out = join(dir, "out");
    const result = await unpackBundle({ archive, out });
    expect(result.entries).toBe(4);
    expect(JSON.parse(await readFile(join(out, "bundle.json"), "utf8"))).toMatchObject({ formatVersion: 1 });
    expect(await readFile(join(out, "files", "main.ts"), "utf8")).toBe("export const x = 1;");
    expect((await readdir(out)).sort()).toEqual(["bundle.json", "files", "logs", "replay.sh"]);
  });

  it("restores the executable bit on the replay script", async () => {
    const dir = await tempDir();
    const root = join(dir, "bundle");
    await makeBundle(root);
    const archive = join(dir, "b.repropack");
    await packBundle({ root, out: archive });
    const out = join(dir, "out");
    await unpackBundle({ archive, out });
    const info = await stat(join(out, "replay.sh"));
    // Windows has no execute bit; anywhere else the script must stay runnable.
    if (process.platform !== "win32") expect(info.mode & 0o111).not.toBe(0);
    expect(info.isFile()).toBe(true);
  });

  it("rejects an archive whose entry escapes the output directory", async () => {
    const dir = await tempDir();
    const archive = join(dir, "evil.repropack");
    await writeFile(
      archive,
      gzipTar([{ path: "../escape.txt", data: Buffer.from("pwned"), mtime: 0 }]),
    );
    await expect(unpackBundle({ archive, out: join(dir, "out") })).rejects.toThrow(/escapes/);
    // Nothing may be written before the whole entry list is validated.
    expect(await readdir(dir)).not.toContain("escape.txt");
  });

  it("rejects an absolute path in the archive", async () => {
    const dir = await tempDir();
    const archive = join(dir, "evil.repropack");
    await writeFile(archive, gzipTar([{ path: "/etc/passwd", data: Buffer.from("x"), mtime: 0 }]));
    await expect(unpackBundle({ archive, out: join(dir, "out") })).rejects.toThrow(/escapes|unsafe/);
  });

  it("rejects an archive over the size limit", async () => {
    const dir = await tempDir();
    const archive = join(dir, "big.repropack");
    await writeFile(archive, gzipTar([{ path: "a.txt", data: Buffer.from("x"), mtime: 0 }]));
    // The limit is checked on stat before reading, so a sparse file is enough.
    await truncate(archive, MAX_ARCHIVE_BYTES + 1);
    await expect(unpackBundle({ archive, out: join(dir, "out") })).rejects.toThrow(/limit/);
  });
});