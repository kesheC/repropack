import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gzipTar, readTar, TarError, writeTar } from "../../src/archive/tar.js";

function entry(path: string, text: string, mtime = 0, executable = false) {
  return { path, data: Buffer.from(text, "utf8"), mtime, executable };
}

describe("writeTar / readTar", () => {
  it("round-trips a single file", () => {
    const back = readTar(writeTar([entry("a.txt", "hello")]));
    expect(back).toHaveLength(1);
    expect(back[0]?.path).toBe("a.txt");
    expect(back[0]?.data.toString("utf8")).toBe("hello");
  });

  it("round-trips many files preserving content and order", () => {
    const input = [entry("a.txt", "one"), entry("dir/b.txt", "two"), entry("dir/sub/c.txt", "three")];
    const back = readTar(writeTar(input));
    expect(back.map((e) => e.path)).toEqual(["a.txt", "dir/b.txt", "dir/sub/c.txt"]);
    expect(back.map((e) => e.data.toString("utf8"))).toEqual(["one", "two", "three"]);
  });

  it("pads entries to the block boundary", () => {
    // 513 bytes spans two blocks plus padding; a reader that forgets the pad
    // reads the next header from the wrong offset.
    const back = readTar(writeTar([entry("a.bin", "x".repeat(513)), entry("b.txt", "after")]));
    expect(back[1]?.path).toBe("b.txt");
    expect(back[1]?.data.toString("utf8")).toBe("after");
  });

  it("preserves an empty file", () => {
    const back = readTar(writeTar([entry("empty.txt", "")]));
    expect(back[0]?.data.length).toBe(0);
  });

  it("records the executable bit", () => {
    const back = readTar(writeTar([entry("run.sh", "#!/bin/sh", 0, true), entry("plain.txt", "x")]));
    expect(back[0]?.executable).toBe(true);
    expect(back[1]?.executable).toBe(false);
  });

  it("round-trips mtime", () => {
    const back = readTar(writeTar([entry("a.txt", "x", 1_700_000_000)]));
    expect(back[0]?.mtime).toBe(1_700_000_000);
  });

  it("uses the ustar prefix field for paths over 100 bytes", () => {
    const long = "d".repeat(60) + "/" + "e".repeat(60) + "/file.txt";
    const back = readTar(writeTar([entry(long, "deep")]));
    expect(back[0]?.path).toBe(long);
  });

  it("refuses a path too long for ustar", () => {
    expect(() => writeTar([entry("x".repeat(300), "y")])).toThrow(TarError);
  });

  it("rejects an archive with no end-of-archive marker", () => {
    const archive = writeTar([entry("a.txt", "hello")]);
    // Drop the two trailing zero blocks: a truncated download looks like this.
    expect(() => readTar(archive.subarray(0, archive.length - 1024))).toThrow(/end-of-archive/);
  });

  it("rejects a truncated file body", () => {
    const archive = writeTar([entry("a.txt", "x".repeat(2048))]);
    const cut = archive.subarray(0, 512 + 100);
    expect(() => readTar(cut)).toThrow(TarError);
  });

  it("rejects unsupported entry types instead of skipping them", () => {
    const archive = writeTar([entry("a.txt", "x")]);
    // Rewrite the typeflag to a symlink ("2") and fix the checksum.
    const tampered = Buffer.from(archive);
    tampered[156] = "2".charCodeAt(0);
    const copy = Buffer.from(tampered.subarray(0, 512));
    copy.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of copy) sum += byte;
    copy.write(sum.toString(8).padStart(6, "0") + "\u0000 ", 148, 8, "ascii");
    copy.copy(tampered, 0);
    expect(() => readTar(tampered)).toThrow(/unsupported entry type/);
  });

  it("accepts a plain tar as well as a gzipped one", () => {
    const plain = writeTar([entry("a.txt", "hello")]);
    expect(readTar(plain)[0]?.data.toString("utf8")).toBe("hello");
    expect(readTar(gzipTar([entry("a.txt", "hello")]))[0]?.data.toString("utf8")).toBe("hello");
  });

  it("produces identical bytes for identical input", () => {
    const a = gzipTar([entry("a.txt", "hello", 100), entry("b.txt", "world", 100)]);
    const b = gzipTar([entry("a.txt", "hello", 100), entry("b.txt", "world", 100)]);
    expect(a.equals(b)).toBe(true);
  });
});

describe("interoperability with system tar", () => {
  it("writes an archive GNU tar can extract", async () => {
    const dir = await mkdtemp(join(tmpdir(), "repropack-tar-"));
    const archivePath = join(dir, "bundle.tar.gz");
    await writeFile(
      archivePath,
      gzipTar([entry("bundle.json", '{"a":1}', 0), entry("files/x.txt", "payload", 0)]),
    );
    await ensureDir(join(dir, "extracted"));
    // Relative names with cwd: GNU tar on Windows reads "C:..." as a remote
    // host and tries to open an rsh connection.
    execFileSync("tar", ["-xzf", "bundle.tar.gz", "-C", "extracted"], { cwd: dir, stdio: "pipe" });
    expect(await readFile(join(dir, "extracted", "bundle.json"), "utf8")).toBe('{"a":1}');
    expect(await readFile(join(dir, "extracted", "files", "x.txt"), "utf8")).toBe("payload");
  });

  it("reads an archive GNU tar produced", async () => {
    const dir = await mkdtemp(join(tmpdir(), "repropack-tar-"));
    const src = await ensureDir(join(dir, "src"));
    await writeFile(join(src, "notes.txt"), "from tar");
    execFileSync("tar", ["-cf", "out.tar", "-C", "src", "notes.txt"], { cwd: dir, stdio: "pipe" });
    const entries = readTar(await readFile(join(dir, "out.tar")));
    expect(entries.map((e) => e.path)).toContain("notes.txt");
    expect(entries.find((e) => e.path === "notes.txt")?.data.toString("utf8")).toBe("from tar");
  });
});

async function ensureDir(path: string): Promise<string> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path, { recursive: true });
  return path;
}