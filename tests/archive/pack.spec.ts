import { mkdir, mkdtemp, readFile, readdir, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_ARCHIVE_BYTES, packBundle, unpackBundle } from "../../src/archive/index.js";
import { gzipTar } from "../../src/archive/tar.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "repropack-archive-"));
}

async function makeBundle(root: string): Promise<void> {
  await mkdir(join(root, "files"), { recursive: true });
  await mkdir(join(root, "logs"), { recursive: true });
  await writeFile(join(root, "bundle.json"), '{"formatVersion":1}', "utf8");
  await writeFile(join(root, "files", "main.ts"), "export const x = 1;", "utf8");
  await writeFile(join(root, "logs", "stderr.txt"), "boom", "utf8");
  await writeFile(join(root, "replay.sh"), "#!/bin/sh", { encoding: "utf8", mode: 0o755 });
}

describe("packBundle", () => {
  it("packs every file in the bundle", async () => {
    const dir = await tempDir();
    const root = join(dir, "bundle");
    await makeBundle(root);
    const result = await packBundle({ root, out: join(dir, "b.repropack") });
    expect(result.entries).toBe(4);
    expect(result.bytes).toBeGreaterThan(0);
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
    expect(await readFile(join(out, "bundle.json"), "utf8")).toBe('{"formatVersion":1}');
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