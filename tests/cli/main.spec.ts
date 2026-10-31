import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { main } from "../../src/cli/main.js";

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

/** A two-file project whose entry point calls a function that does not exist. */
function makeFixture(): { root: string; out: string } {
  const root = tempDir("repropack-cli-fixture-");
  writeFile(root, "package.json", JSON.stringify({ name: "fixture", version: "1.0.0" }, null, 2) + "\n");
  writeFile(root, "src/broken.js", "function greet() {\n  return missingFunction();\n}\n\ngreet();\n");
  return { root, out: join(root, "out-bundle") };
}

describe("main: dispatch and usage", () => {
  it("prints usage and succeeds when no command is given", async () => {
    const io = captureIo();
    await expect(main([])).resolves.toBe(0);
    expect(io.stdout()).toContain("repropack capture");
    expect(io.stderr()).toBe("");
  });

  it("prints usage for --help", async () => {
    const io = captureIo();
    await expect(main(["--help"])).resolves.toBe(0);
    expect(io.stdout()).toContain("repropack capture");
  });

  it("prints the version for --version", async () => {
    const io = captureIo();
    await expect(main(["--version"])).resolves.toBe(0);
    expect(io.stdout().trim()).toBe("0.1.1");
  });

  it("prints the version for the version subcommand", async () => {
    const io = captureIo();
    await expect(main(["version"])).resolves.toBe(0);
    expect(io.stdout().trim()).toBe("0.1.1");
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
    "warns about an unknown option without changing the exit code",
    { timeout: 20_000 },
    async () => {
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

        expect(code).toBe(0);
        expect(io.stderr()).toContain("unknown option(s): --nope");
        expect(() => JSON.parse(io.stdout())).not.toThrow();
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