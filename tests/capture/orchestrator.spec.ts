import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capture } from "../../src/capture/index.js";
import { readBundle } from "../../src/bundle/read.js";

let workdir: string;
const node = process.execPath;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "repropack-capture-"));
  await mkdir(join(workdir, "src"), { recursive: true });
  await writeFile(
    join(workdir, "src", "broken.js"),
    "function ok() { return 1; }\nconsole.error('ReferenceError: nope is not defined');\nprocess.exit(1);\n",
    "utf8",
  );
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("capture", () => {
  it("produces a readable bundle recording the failure", async () => {
    const out = join(workdir, "bundle");
    const result = await capture({
      argv: [node, "src/broken.js"],
      out,
      scope: "all",
      noGit: true,
      cwd: workdir,
      toolVersion: "0.1.0",
    });

    expect(result.bundle.command.exitCode).toBe(1);
    expect(result.bundle.command.argv).toEqual([node, "src/broken.js"]);
    expect(result.bundle.repository).toBeNull();
    expect(result.bundle.warnings.some((w) => w.includes("exited 0"))).toBe(false);

    const loaded = await readBundle(out);
    expect(loaded.integrityOk).toBe(true);
    expect(loaded.manifest.files.some((f) => f.path === "src/broken.js")).toBe(true);

    const stderr = await readFile(join(out, "logs", "stderr.txt"), "utf8");
    expect(stderr).toContain("ReferenceError");
  });

  it("redacts secrets that appear in the program output before writing them", async () => {
    const out = join(workdir, "bundle");
    const fakeToken = "ghp_" + "Z".repeat(36);
    await writeFile(join(workdir, "leak.js"), "console.log('token=" + fakeToken + "');\nprocess.exit(1);\n", "utf8");

    await capture({
      argv: [node, "leak.js"],
      out,
      scope: "all",
      noGit: true,
      cwd: workdir,
      toolVersion: "0.1.0",
    });

    const stdout = await readFile(join(out, "logs", "stdout.txt"), "utf8");
    expect(stdout).not.toContain(fakeToken);
    expect(stdout).toContain("REDACTED_GITHUB_TOKEN");

    const manifest = await readFile(join(out, "bundle.json"), "utf8");
    expect(manifest).not.toContain(fakeToken);
  });

  it("redacts secrets inside captured source files", async () => {
    const out = join(workdir, "bundle");
    const fakeKey = "sk-" + "proj-" + "q".repeat(32);
    await writeFile(join(workdir, "src", "config.js"), "module.exports = { apiKey: '" + fakeKey + "' };\n", "utf8");

    await capture({
      argv: [node, "src/broken.js"],
      out,
      scope: "all",
      noGit: true,
      cwd: workdir,
      toolVersion: "0.1.0",
    });

    const shipped = await readFile(join(out, "files", "src", "config.js"), "utf8");
    expect(shipped).not.toContain(fakeKey);
  });

  it("redacts secrets typed on the command line before they reach the manifest", async () => {
    const out = join(workdir, "bundle");
    // argv is the only field that reaches the report verbatim, so a token
    // passed as an argument would otherwise be published twice.
    const token = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    await capture({
      argv: [node, "src/broken.js", "--token", token],
      out,
      scope: "all",
      noGit: true,
      cwd: workdir,
      toolVersion: "0.1.0",
    });

    const raw = await readFile(join(out, "bundle.json"), "utf8");
    expect(raw).not.toContain(token);
    const loaded = await readBundle(out);
    const argv = loaded.manifest.command.argv;
    expect(argv[2]).toBe("--token");
    expect(argv[3]).not.toContain(token);
    expect(argv[3]).toContain("REDACTED");
    // The leak report has to name the surface it fixed, or the user cannot
    // tell that their command line was rewritten.
    expect(loaded.manifest.redaction.bySurface.some((surface) => surface.surface === "command")).toBe(true);
  });

  it("leaves an argv with nothing secret in it untouched", async () => {
    const out = join(workdir, "bundle");
    await capture({
      argv: [node, "src/broken.js", "--verbose"],
      out,
      scope: "all",
      noGit: true,
      cwd: workdir,
      toolVersion: "0.1.0",
    });
    const loaded = await readBundle(out);
    expect(loaded.manifest.command.argv).toEqual([node, "src/broken.js", "--verbose"]);
    expect(loaded.manifest.redaction.bySurface.some((surface) => surface.surface === "command")).toBe(false);
  });
  it("records a warning when the command succeeds", async () => {
    const out = join(workdir, "ok-bundle");
    await writeFile(join(workdir, "fine.js"), "process.exit(0);\n", "utf8");
    const result = await capture({
      argv: [node, "fine.js"],
      out,
      scope: "changed",
      noGit: true,
      cwd: workdir,
      toolVersion: "0.1.0",
    });
    expect(result.bundle.command.exitCode).toBe(0);
    expect(result.bundle.warnings.some((w) => w.includes("exited 0"))).toBe(true);
  });

  it("does not ship node_modules or the bundle it is writing", async () => {
    const out = join(workdir, "bundle");
    await mkdir(join(workdir, "node_modules", "junk"), { recursive: true });
    await writeFile(join(workdir, "node_modules", "junk", "index.js"), "module.exports = 1;\n", "utf8");

    const result = await capture({
      argv: [node, "src/broken.js"],
      out,
      scope: "all",
      noGit: true,
      cwd: workdir,
      toolVersion: "0.1.0",
    });

    expect(result.bundle.files.some((f) => f.path.includes("node_modules"))).toBe(false);
  });

  it("carries binary files byte-for-byte without redaction corrupting them", async () => {
    const out = join(workdir, "bundle");
    const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
    await writeFile(join(workdir, "asset.bin"), binary);

    const result = await capture({
      argv: [node, "src/broken.js"],
      out,
      scope: "all",
      noGit: true,
      cwd: workdir,
      toolVersion: "0.1.0",
    });

    const entry = result.bundle.files.find((f) => f.path === "asset.bin");
    expect(entry).toBeTruthy();
    if (entry) {
      const shipped = await readFile(join(out, "files", "asset.bin"));
      expect(shipped.equals(binary)).toBe(true);
    }
  });
});