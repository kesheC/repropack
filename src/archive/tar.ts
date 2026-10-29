/**
 * Minimal ustar reader/writer.
 *
 * The point of hand-rolling this instead of taking a dependency is that a
 * .repropack file must be readable by any archive tool a user already has:
 * 'tar -xf bundle.repropack' has to work, and so does 7z, and so does the
 * GitHub issue attachment preview. ustar is the format every one of them
 * understands, and it is small enough to implement correctly.
 *
 * Limitations are stated rather than hidden: we write POSIX ustar without pax
 * extensions, so a path longer than 255 characters is refused at write time
 * instead of being silently truncated.
 */

import { gzipSync, gunzipSync } from "node:zlib";

const BLOCK = 512;
/** ustar: 100 bytes of name, 155 of prefix. */
const NAME_MAX = 100;
const PREFIX_MAX = 155;
/** Owner fields are cosmetic for a repro bundle; a fixed value keeps bundles byte-identical. */
const FIXED_UID = 0;
const FIXED_GID = 0;
const FIXED_UNAME = "repropack";
const FIXED_GNAME = "repropack";

export interface TarEntry {
  /** POSIX relative path, forward slashes, no leading slash. */
  readonly path: string;
  readonly data: Buffer;
  /** Seconds since epoch; clamped to zero because a negative field is not representable. */
  readonly mtime: number;
  /** Executable bit; the only permission bit that changes behaviour. */
  readonly executable?: boolean;
}

export class TarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarError";
  }
}

/**
 * Serialise entries to an uncompressed ustar archive.
 *
 * Entries are written in the order given; callers sort for determinism.
 */
export function writeTar(entries: readonly TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const { name, prefix } = splitPath(entry.path);
    const header = Buffer.alloc(BLOCK, 0);

    header.write(name, 0, NAME_MAX, "utf8");
    writeOctal(header, 100, 8, entry.executable ? 0o755 : 0o644);
    writeOctal(header, 108, 8, FIXED_UID);
    writeOctal(header, 116, 8, FIXED_GID);
    writeOctal(header, 124, 12, entry.data.length);
    writeOctal(header, 136, 12, Math.max(0, Math.floor(entry.mtime)));
    // Checksum is computed with the field filled by spaces, then written as
    // six octal digits plus NUL plus space.
    header.fill(0x20, 148, 156);
    header.write("0", 156, 1, "ascii"); // regular file
    header.write("ustar", 257, 5, "ascii");
    header.write("00", 263, 2, "ascii");
    header.write(FIXED_UNAME, 265, 32, "ascii");
    header.write(FIXED_GNAME, 297, 32, "ascii");
    writeOctal(header, 329, 8, 0); // devmajor
    writeOctal(header, 337, 8, 0); // devminor
    if (prefix.length > 0) header.write(prefix, 345, PREFIX_MAX, "utf8");

    let sum = 0;
    for (const byte of header) sum += byte;
    writeOctal(header, 148, 7, sum);
    header.write(" ", 155, 1, "ascii");

    blocks.push(header, entry.data);
    const pad = entry.data.length % BLOCK;
    if (pad !== 0) blocks.push(Buffer.alloc(BLOCK - pad, 0));
  }
  // Two zero blocks end the archive.
  blocks.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(blocks);
}

/** Wrap an archive in gzip, producing the on-disk .repropack payload. */
export function gzipTar(entries: readonly TarEntry[]): Buffer {
  // gzip stores the mtime in its header; zeroing it makes the output
  // reproducible for identical input.
  return gzipSync(writeTar(entries), { level: 9 });
}
/** Parse a gzipped or plain ustar archive. */
export function readTar(input: Buffer): readonly TarEntry[] {
  let archive = input;
  // gzip magic; a plain tar is also accepted so 'tar -cf' round-trips.
  if (archive.length >= 2 && archive[0] === 0x1f && archive[1] === 0x8b) {
    try {
      archive = gunzipSync(archive);
    } catch (error) {
      throw new TarError("gzip decompression failed: " + String((error as Error).message));
    }
  }

  const entries: TarEntry[] = [];
  let offset = 0;
  let sawTerminator = false;

  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK);
    if (isZeroBlock(header)) {
      sawTerminator = true;
      break;
    }
    const name = readString(header, 0, NAME_MAX);
    const prefix = readString(header, 345, PREFIX_MAX);
    const path = prefix.length > 0 ? prefix + "/" + name : name;
    const size = readOctal(header, 124, 12);
    const mode = readOctal(header, 100, 8);
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const mtime = readOctal(header, 136, 12);

    if (size < 0) throw new TarError("negative size for entry " + path);
    offset += BLOCK;

    if (typeflag === "0" || typeflag === NUL_CHAR || typeflag === "") {
      if (offset + size > archive.length) {
        throw new TarError("truncated archive: " + path + " needs " + String(size) + " bytes");
      }
      entries.push({
        path,
        data: Buffer.from(archive.subarray(offset, offset + size)),
        mtime,
        executable: (mode & 0o111) !== 0,
      });
      offset += size;
      // Entries are padded to the next block boundary.
      const pad = size % BLOCK;
      if (pad !== 0) offset += BLOCK - pad;
      continue;
    }
    if (typeflag === "5") {
      // Directory entry: nothing to extract, and we never write them ourselves.
      continue;
    }
    // Symlinks, hardlinks, char devices and pax headers are refused rather than
    // ignored: an archive containing them is not something capture produces, so
    // silently dropping the entry would hide tampering.
    throw new TarError("unsupported entry type " + JSON.stringify(typeflag) + " for " + path);
  }

  if (!sawTerminator) throw new TarError("archive has no end-of-archive marker; it is probably truncated");
  return entries;
}

function splitPath(path: string): { name: string; prefix: string } {
  if (path.length === 0) throw new TarError("empty entry path");
  if (path.length <= NAME_MAX) return { name: path, prefix: "" };
  // Scan separators from the right: the first one found gives the shortest
  // tail, so it is the most likely to fit in `name`. Scanning from the left
  // instead would walk past every valid split before finding one.
  for (let cut = path.length - 1; cut > 0; cut -= 1) {
    if (path[cut] !== "/") continue;
    const prefix = path.slice(0, cut);
    const name = path.slice(cut + 1);
    if (name.length === 0 || name.length > NAME_MAX) continue;
    if (prefix.length > PREFIX_MAX) continue;
    return { name, prefix };
  }
  throw new TarError("path too long for ustar (max " + String(NAME_MAX + 1 + PREFIX_MAX) + "): " + path);
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8);
  if (text.length > length - 1) throw new TarError("number too large for octal field: " + String(value));
  buffer.write(text.padStart(length - 1, "0"), offset, length - 1, "ascii");
  buffer.write(NUL_CHAR, offset + length - 1, 1, "ascii");
}

function readOctal(buffer: Buffer, offset: number, length: number): number {
  const raw = buffer.toString("ascii", offset, offset + length).replace(NUL_TAIL, "").trim();
  if (raw.length === 0) return 0;
  const value = Number.parseInt(raw, 8);
  return Number.isNaN(value) ? 0 : value;
}

function readString(buffer: Buffer, offset: number, length: number): string {
  const slice = buffer.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.toString("utf8", 0, end === -1 ? slice.length : end);
}

function isZeroBlock(block: Buffer): boolean {
  for (const byte of block) if (byte !== 0) return false;
  return true;
}
/** NUL as a one-character string, spelled out to keep the literals readable. */
const NUL_CHAR = String.fromCharCode(0);
/** Everything from the first NUL, used to drop the padding an octal field carries. */
const NUL_TAIL = new RegExp(String.fromCharCode(0) + ".*$", "s");
