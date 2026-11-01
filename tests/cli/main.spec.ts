import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { main } from "../../src/cli/main.js";
import { computeIntegrity } from "../../src/bundle/manifest.js";
import { TOOL_VERSION } from "../../src/version.js";

/**
 * main() writes with process.stdout/stderr.write and returns an exit code.
 * Both streams are captured here so a test can assert the hard split:
 * stdout is machine output, stderr is human output.
 */
interface Io {
  readonly stdout: () => string;
  readonly stderr: () => string;
}

const writers: Array<() => void> = [];

function captureIo(): Io {
  const out: string[] = [];
  const err: string[] = [];
  const push = (sink: string[]) => (chunk: string | Uint8Array): boolean => {
    sink.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };

  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(push(out) as typeof process.stdout.write);
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(push(err) as typeof process.stderr.write);
  writers.push(() => {
    outSpy.mockRestore();
    errSpy.mockRestore();
  });

  return { stdout: () => out.join(""), stderr: () => err.join("") };
}

afterEach(() => {
  while (writers.length > 0) writers.pop()?.();
  vi.restoreAllMocks();
});

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeFile(root: string, rel: string, body: string): void {
  const target = join(root, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body, "utf8");
}

/**
 * Rewrite a hand-built manifest with the integrity hash the reader demands.
 *
 * Tests that care about *what* gets packed should not fail just because they
 * wrote `integrity: ""`; the hash check has its own tests. This recomputes the
 * field the same way capture does, so the fixture reads as a real bundle.
 */
function sealManifest(manifestPath: string): void {
  const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown> & { integrity?: string };
  const { integrity: _ignored, ...payload } = parsed;
  parsed.integrity = computeIntegrity(payload as never);
  writeFileSync(manifestPath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
}

/** A two-file project whose entry point calls a function that does not exist. */
function makeFixture(): { root: string; out: string } {
  const root = tempDir("repropack-cli-fixture-");
  writeFile(root, "package.json", JSON.stringify({ name: "fixture", version: "1.0.0" }, null, 2) + "\n");
  writeFile(root, "src/broken.js", "function greet() {\n  return missingFunction();\n}\n\ngreet();\n");
  return { root, out: join(root, "out-bundle") };
}

describe("main: dispatch and usage", () => {
  it("explains itself and fails when no command is given", async () => {
    // Succeeding on an empty invocation reads as "did what you asked". A caller
    // that forgot the subcommand has to be able to notice.
    const io = captureIo();
    await expect(main([])).resolves.toBe(2);
    expect(io.stderr()).toContain("error: no command given");
    expect(io.stderr()).toContain("repropack capture");
    expect(io.stdout()).toBe("");
  });

  it("prints usage for --help", async () => {
    const io = captureIo();
    await expect(main(["--help"])).resolves.toBe(0);
    expect(io.stdout()).toContain("repropack capture");
  });

  // Compared against TOOL_VERSION rather than a literal: the literal turned
  // every version bump into a test failure in a file that has nothing to do
  // with versioning. tests/version.spec.ts already pins TOOL_VERSION to
  // package.json, so drift still fails CI.
  it("prints the version for --version", async () => {
    const io = captureIo();
    await expect(main(["--version"])).resolves.toBe(0);
    expect(io.stdout().trim()).toBe(TOOL_VERSION);
    expect(io.stdout().trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("prints the version for the version subcommand", async () => {
    const io = captureIo();
    await expect(main(["version"])).resolves.toBe(0);
    expect(io.stdout().trim()).toBe(TOOL_VERSION);
  });

  it("rejects an unknown command with exit 2 and writes the error to stderr", async () => {
    const io = captureIo();
    await expect(main(["nope"])).resolves.toBe(2);
    expect(io.stderr()).toContain("unknown command 'nope'");
    // stdout stays clean so a caller can still parse it.
    expect(io.stdout()).toBe("");
  });
});

describe("main: usage errors exit 2", () => {
  it("capture without a command", async () => {
    const io = captureIo();
    await expect(main(["capture"])).resolves.toBe(2);
    expect(io.stderr()).toContain("capture needs a command after --");
    expect(io.stdout()).toBe("");
  });

  it("capture with an unknown --scope value", async () => {
    const io = captureIo();
    await expect(main(["capture", "--scope", "bogus", "--", "node", "-v"])).resolves.toBe(2);
    expect(io.stderr()).toContain("--scope must be one of changed, tracked, all");
  });

  it("replay without a bundle directory", async () => {
    const io = captureIo();
    await expect(main(["replay"])).resolves.toBe(2);
    expect(io.stderr()).toContain("replay needs a bundle directory");
  });

  it("verify without a bundle directory", async () => {
    const io = captureIo();
    await expect(main(["verify"])).resolves.toBe(2);
    expect(io.stderr()).toContain("verify needs a bundle directory");
  });

  it("verify on a directory that does not exist", async () => {
    const io = captureIo();
    await expect(main(["verify", "/definitely/not/here"])).resolves.toBe(2);
    expect(io.stderr()).toContain("no such bundle");
    expect(io.stdout()).toBe("");
  });

  it("inspect without a bundle directory", async () => {
    const io = captureIo();
    await expect(main(["inspect"])).resolves.toBe(2);
    expect(io.stderr()).toContain("inspect needs a bundle directory");
  });

  it("inspect on a directory that does not exist reports a clean error and exits 2", async () => {
    const io = captureIo();
    expect(await main(["inspect", "/definitely/not/here"])).toBe(2);
    expect(io.stderr()).toContain("error: no such bundle:");
    // The raw ENOENT used to escape and the wrapper turned it into exit 70,
    // which reads like a repropack bug rather than a typo in the argument.
    expect(io.stderr()).not.toContain("ENOENT");
  });
});

describe("main: capture end to end", () => {
  it(
    "captures a failing command, writes the bundle, and reports JSON on stdout",
    { timeout: 20_000 },
    async () => {
      const fixture = makeFixture();
      const previous = process.cwd();
      process.chdir(fixture.root);
      try {
        const io = captureIo();
        const code = await main([
          "capture",
          "--out",
          fixture.out,
          "--no-git",
          "--json",
          "--",
          "node",
          "src/broken.js",
        ]);

        expect(code).toBe(0);
        expect(existsSync(join(fixture.out, "bundle.json"))).toBe(true);

        const payload = JSON.parse(io.stdout()) as { out?: unknown; id?: unknown; warnings?: unknown };
        expect(typeof payload.id).toBe("string");
        expect((payload.id as string).length).toBeGreaterThan(0);
        expect(payload.out).toBe(fixture.out);
        expect(Array.isArray(payload.warnings)).toBe(true);

        // Human progress lines belong on stderr, never on the JSON stream.
        expect(io.stdout()).not.toContain("bundle written to");
        expect(io.stderr()).toContain("running node src/broken.js");

        const manifest = JSON.parse(readFileSync(join(fixture.out, "bundle.json"), "utf8")) as {
          command: { argv: string[]; exitCode: number | null };
          files: { path: string }[];
          repository: unknown;
        };
        expect(manifest.command.argv).toEqual(["node", "src/broken.js"]);
        expect(manifest.command.exitCode).toBe(1);
        expect(manifest.repository).toBeNull();
        const paths = manifest.files.map((file) => file.path);
        expect(paths).toContain("src/broken.js");
        expect(paths).toContain("package.json");
      } finally {
        process.chdir(previous);
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it(
    "prints a human summary on stdout unless --json is given",
    { timeout: 20_000 },
    async () => {
      const fixture = makeFixture();
      const previous = process.cwd();
      process.chdir(fixture.root);
      try {
        const io = captureIo();
        const code = await main(["capture", "--out", fixture.out, "--no-git", "--", "node", "src/broken.js"]);

        expect(code).toBe(0);
        expect(io.stdout()).toContain("repropack bundle ");
        expect(io.stdout()).toContain("node src/broken.js");
        expect(io.stderr()).toContain("bundle written to " + fixture.out);
      } finally {
        process.chdir(previous);
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it(
    "honours the -o alias for --out",
    { timeout: 20_000 },
    async () => {
      const fixture = makeFixture();
      const previous = process.cwd();
      process.chdir(fixture.root);
      try {
        const io = captureIo();
        expect(await main(["capture", "-o", fixture.out, "--no-git", "--json", "--", "node", "src/broken.js"])).toBe(0);
        expect(existsSync(join(fixture.out, "bundle.json"))).toBe(true);
        expect((JSON.parse(io.stdout()) as { out: string }).out).toBe(fixture.out);
      } finally {
        process.chdir(previous);
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it(
    "records a zero exit as a success but still returns 0 from the CLI",
    { timeout: 20_000 },
    async () => {
      const fixture = makeFixture();
      const previous = process.cwd();
      process.chdir(fixture.root);
      try {
        const io = captureIo();
        const code = await main([
          "capture",
          "--out",
          fixture.out,
          "--no-git",
          "--json",
          "--",
          "node",
          "-e",
          "process.exit(0)",
        ]);

        expect(code).toBe(0);
        const payload = JSON.parse(io.stdout()) as { warnings: string[] };
        // A bundle of a passing run is still a bundle, but capture says so out loud.
        expect(payload.warnings.some((w) => w.includes("records a success"))).toBe(true);
      } finally {
        process.chdir(previous);
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it(
    "keeps a secret in argv out of the progress line on stderr",
    { timeout: 20_000 },
    async () => {
      // Regression: `running <argv>` printed the command verbatim while the
      // manifest stored a redacted copy. The bundle was safe and the CI log was
      // not, which is the half that outlives the artifact.
      const fixture = makeFixture();
      const previous = process.cwd();
      process.chdir(fixture.root);
      const key = "sk-" + "proj-" + "A".repeat(24);
      try {
        const io = captureIo();
        const code = await main([
          "capture",
          "--out",
          fixture.out,
          "--no-git",
          "--json",
          "--",
          "node",
          "src/broken.js",
          "--token",
          key,
        ]);

        expect(code).toBe(0);
        expect(io.stderr()).toContain("running node src/broken.js --token");
        expect(io.stderr()).not.toContain(key);
        expect(io.stdout()).not.toContain(key);

        const manifest = JSON.parse(readFileSync(join(fixture.out, "bundle.json"), "utf8")) as {
          command: { argv: string[] };
        };
        expect(manifest.command.argv).toContain("REDACTED_OPENAI_KEY");
      } finally {
        process.chdir(previous);
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it(
    "rejects an unknown option instead of running with it",
    { timeout: 20_000 },
    async () => {
      // Accepting the flag with a warning was worse than it looked: the parser
      // never consumes the value of a flag it does not know, so '--scop all'
      // warned and then tried to run the command 'all'.
      const fixture = makeFixture();
      const previous = process.cwd();
      process.chdir(fixture.root);
      try {
        const io = captureIo();
        const code = await main([
          "capture",
          "--nope",
          "--out",
          fixture.out,
          "--no-git",
          "--json",
          "--",
          "node",
          "-e",
          "process.exit(2)",
        ]);

        expect(code).toBe(2);
        expect(io.stderr()).toContain("unknown option '--nope'");
        expect(io.stderr()).toContain("hint: run 'repropack capture --help'");
        expect(io.stdout()).toBe("");
        expect(existsSync(join(fixture.out, "bundle.json"))).toBe(false);
      } finally {
        process.chdir(previous);
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it(
    "points a mistyped option at the one the user meant",
    { timeout: 20_000 },
    async () => {
      const fixture = makeFixture();
      const previous = process.cwd();
      process.chdir(fixture.root);
      try {
        const io = captureIo();
        // '--scop all' used to warn, leave 'all' in the positionals and try to
        // execute a program called 'all'.
        expect(await main(["capture", "--scop", "all", "--out", fixture.out, "--no-git", "--", "node", "src/broken.js"])).toBe(2);
        expect(io.stderr()).toContain("unknown option '--scop'");
        expect(io.stderr()).toContain("did you mean '--scope'?");
        expect(io.stderr()).not.toContain("ENOENT");
      } finally {
        process.chdir(previous);
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );
});

describe("main: pack and report", () => {
  it("pack without a bundle directory exits 2", async () => {
    const io = captureIo();
    await expect(main(["pack"])).resolves.toBe(2);
    expect(io.stderr()).toContain("pack needs a bundle directory");
  });

  it("report without a bundle directory exits 2", async () => {
    const io = captureIo();
    await expect(main(["report"])).resolves.toBe(2);
    expect(io.stderr()).toContain("report needs a bundle directory");
  });

  it("pack on a directory that does not exist reports a clean error and exits 2", async () => {
    const io = captureIo();
    expect(await main(["pack", "/definitely/not/here"])).toBe(2);
    expect(io.stderr()).toContain("error: no such bundle:");
    expect(io.stderr()).not.toContain("ENOENT");
  });

  it(
    "packs a fresh bundle into a single archive file",
    { timeout: 60_000 },
    async () => {
      const fixture = makeFixture();
      const previous = process.cwd();
      process.chdir(fixture.root);
      try {
        captureIo();
        expect(await main(["capture", "--out", fixture.out, "--no-git", "--json", "--", "node", "src/broken.js"])).toBe(0);

        const archive = join(fixture.root, "bundle.repropack");
        const io = captureIo();
        expect(await main(["pack", "--json", "--out", archive, fixture.out])).toBe(0);
        expect(existsSync(archive)).toBe(true);

        const packed = JSON.parse(io.stdout()) as { out: string; bytes: number; entries: number };
        expect(packed.out).toBe(archive);
        expect(packed.bytes).toBeGreaterThan(0);
        expect(packed.entries).toBeGreaterThan(0);
      } finally {
        process.chdir(previous);
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it(
    "report renders a markdown body for a fresh bundle",
    { timeout: 60_000 },
    async () => {
      const fixture = makeFixture();
      const previous = process.cwd();
      process.chdir(fixture.root);
      try {
        captureIo();
        expect(await main(["capture", "--out", fixture.out, "--no-git", "--json", "--", "node", "src/broken.js"])).toBe(0);

        const io = captureIo();
        expect(await main(["report", fixture.out])).toBe(0);
        // stdout carries only the report body; progress belongs on stderr.
        expect(io.stdout().length).toBeGreaterThan(0);
        expect(io.stdout()).toContain("src/broken.js");
      } finally {
        process.chdir(previous);
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );
});

describe("main: help is generated from the flag table", () => {
  it("shows the general help with the exit codes", async () => {
    const io = captureIo();
    await expect(main(["--help"])).resolves.toBe(0);
    expect(io.stdout()).toContain("Exit codes:");
    expect(io.stdout()).toContain("  2  usage or input error");
    expect(io.stdout()).toContain("Run 'repropack <command> --help'");
  });

  it("gives verify its own help, including --strict", async () => {
    // --strict was parseable for months while no help text mentioned it, so the
    // one flag that turns warnings into failures was undiscoverable.
    const io = captureIo();
    await expect(main(["verify", "--help"])).resolves.toBe(0);
    expect(io.stdout()).toContain("repropack verify  [options] <bundle-dir>");
    expect(io.stdout()).toContain("--strict");
    expect(io.stdout()).toContain("fail on warnings as well as blockers");
    expect(io.stdout()).not.toContain("--scope");
  });

  it("gives each command a different help page", async () => {
    const pages = new Set<string>();
    for (const command of ["capture", "replay", "verify", "inspect", "pack", "report"]) {
      const io = captureIo();
      await expect(main([command, "--help"])).resolves.toBe(0);
      pages.add(io.stdout());
    }
    // They used to be one string printed six times.
    expect(pages.size).toBe(6);
  });
});

describe("main: pack refuses what verify rejects", () => {
  it(
    "refuses to pack a bundle with blocker findings",
    { timeout: 60_000 },
    async () => {
      const fixture = makeFixture();
      const previous = process.cwd();
      process.chdir(fixture.root);
      try {
        captureIo();
        expect(await main(["capture", "--out", fixture.out, "--no-git", "--json", "--", "node", "src/broken.js"])).toBe(0);

        // A secret in a captured file: capture's own redaction never sees this
        // because the file is written after the fact.
        writeFile(fixture.out, "files/leaked.txt", "token = sk-" + "proj-" + "B".repeat(24) + "\n");

        const archive = join(fixture.root, "blocked.repropack");
        const io = captureIo();
        expect(await main(["pack", "--out", archive, fixture.out])).toBe(1);
        expect(io.stderr()).toContain("refusing to pack a bundle that does not verify");
        expect(io.stderr()).toContain("leak-suspected");
        expect(io.stderr()).toContain("--force");
        expect(existsSync(archive)).toBe(false);
      } finally {
        process.chdir(previous);
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it(
    "packs anyway when --force is given",
    { timeout: 60_000 },
    async () => {
      const fixture = makeFixture();
      const previous = process.cwd();
      process.chdir(fixture.root);
      try {
        captureIo();
        expect(await main(["capture", "--out", fixture.out, "--no-git", "--json", "--", "node", "src/broken.js"])).toBe(0);
        writeFile(fixture.out, "files/leaked.txt", "token = sk-" + "proj-" + "B".repeat(24) + "\n");

        const archive = join(fixture.root, "forced.repropack");
        const io = captureIo();
        expect(await main(["pack", "--force", "--json", "--out", archive, fixture.out])).toBe(0);
        expect(existsSync(archive)).toBe(true);
        // The escape hatch is not silent: it says what it ignored.
        expect(io.stderr()).toContain("leak-suspected");
      } finally {
        process.chdir(previous);
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it("keeps an undeclared file out of the archive", async () => {
    const dir = tempDir("repropack-cli-pack-");
    try {
      const bundleRoot = join(dir, "bundle");
      mkdirSync(join(bundleRoot, "files"), { recursive: true });
      mkdirSync(join(bundleRoot, "logs"), { recursive: true });
      writeFileSync(
        join(bundleRoot, "bundle.json"),
        JSON.stringify({
          formatVersion: 1,
          id: "deadbeefdeadbeef",
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
          files: [],
          redaction: { rulesVersion: "1", totalMatches: 0, byRule: [], bySurface: [], skipped: [] },
          warnings: [],
          integrity: "",
        }),
        "utf8",
      );
      writeFileSync(join(bundleRoot, "logs", "stderr.txt"), "boom", "utf8");
      writeFileSync(join(bundleRoot, "notes.txt"), "not part of the bundle", "utf8");

      // readBundle refuses a manifest whose integrity hash does not match, and
      // --force only relaxes *verify's* findings -- it never relaxes the
      // reader. Sealing the fixture is what keeps this test about the
      // whitelist instead of about the hash check that already has its own.
      sealManifest(join(bundleRoot, "bundle.json"));

      const io = captureIo();
      // --force still stands in for any verify finding the bare fixture earns;
      // the assertion is that the whitelist bounds the archive.
      const code = await main(["pack", "--force", "--json", "--out", join(dir, "b.repropack"), bundleRoot]);
      expect(code).toBe(0);
      const packed = JSON.parse(io.stdout()) as { entries: number };
      // bundle.json + logs/stderr.txt
      expect(packed.entries).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("main: capture then replay then verify then inspect", () => {
  it(
    "round-trips one bundle through every subcommand",
    { timeout: 60_000 },
    async () => {
      const fixture = makeFixture();
      const previous = process.cwd();
      process.chdir(fixture.root);
      try {
        // 1. capture
        const captureIoResult = captureIo();
        expect(
          await main(["capture", "--out", fixture.out, "--no-git", "--json", "--", "node", "src/broken.js"]),
        ).toBe(0);
        const captured = JSON.parse(captureIoResult.stdout()) as { id: string };
        expect(captured.id.length).toBeGreaterThan(0);

        // 2. replay reproduces the recorded exit code, so it is a faithful replay.
        const replayIo = captureIo();
        expect(await main(["replay", "--json", fixture.out])).toBe(0);
        const replayed = JSON.parse(replayIo.stdout()) as { ok: boolean; exitCode: number | null; expectedExitCode: number | null };
        expect(replayed.ok).toBe(true);
        expect(replayed.exitCode).toBe(1);
        expect(replayed.expectedExitCode).toBe(1);

        // 3. verify: a freshly captured bundle must be publishable.
        const verifyIo = captureIo();
        expect(await main(["verify", "--json", fixture.out])).toBe(0);
        expect((JSON.parse(verifyIo.stdout()) as { ok: boolean }).ok).toBe(true);

        // 4. inspect prints the same summary shape.
        const inspectIo = captureIo();
        expect(await main(["inspect", fixture.out])).toBe(0);
        expect(inspectIo.stdout()).toContain("repropack bundle " + captured.id.slice(0, 12));

        // 5. inspect --json is the pipe-into-jq path, so stdout must parse whole.
        const inspectJsonIo = captureIo();
        expect(await main(["inspect", "--json", fixture.out])).toBe(0);
        const manifest = JSON.parse(inspectJsonIo.stdout()) as { id: string };
        expect(manifest.id).toBe(captured.id);
      } finally {
        process.chdir(previous);
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );
});