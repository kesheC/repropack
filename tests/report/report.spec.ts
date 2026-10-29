import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildReport, reportTitle } from "../../src/report/index.js";
import type { Bundle, BundleFile } from "../../src/types.js";

/**
 * The report is what gets pasted into a public issue, so these tests are as
 * much a privacy contract as a formatting one: nothing that identifies the
 * reporter  machine may survive into the text.
 */

const dirs: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "repropack-report-"));
  dirs.push(dir);
  mkdirSync(join(dir, "logs"), { recursive: true });
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function file(path: string, bytes: number): BundleFile {
  return { path, bytes, sha256: "0".repeat(64), mode: "100644", reason: "input", truncated: false };
}

function makeBundle(overrides: Partial<Bundle> = {}): Bundle {
  const base: Bundle = {
    formatVersion: 1,
    id: "0123456789abcdef0123456789abcdef",
    createdAt: "2026-01-01T00:00:00.000Z",
    producer: { name: "repropack", version: "0.1.0", node: "v22.5.0" },
    command: {
      argv: ["node", "test.js"],
      cwd: ".",
      startedAt: "2026-01-01T00:00:00.000Z",
      exitCode: 1,
      signal: null,
      durationMs: 1234,
      stdoutPath: "logs/stdout.txt",
      stderrPath: "logs/stderr.txt",
      truncated: false,
    },
    environment: {
      platform: "linux",
      arch: "x64",
      release: "6.8.0",
      node: "v22.5.0",
      nodeAbi: "127",
      packageManager: { name: "npm", version: "10.8.1", lockfile: "package-lock.json" },
      env: { CI: "true" },
      timezone: "UTC",
      locale: "en_US.UTF-8",
      resources: { cpuCount: 4, totalMemoryMb: 8192, freeMemoryMb: 4096 },
    },
    repository: null,
    files: [file("src/a.ts", 2048)],
    redaction: { totalMatches: 0, byRule: [], bySurface: [], rulesVersion: "1", skipped: [] },
    warnings: [],
    integrity: "abc123",
  };
  return { ...base, ...overrides };
}

describe("reportTitle", () => {
  it("stays short enough for a GitHub issue list", () => {
    const bundle = makeBundle();
    const title = reportTitle({
      ...bundle,
      command: { ...bundle.command, argv: ["node", "a".repeat(200) + ".js"] },
    });
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith("(exit 1)")).toBe(true);
    expect(title).toContain("...");
  });

  it("keeps the budget on the signal branch too, where the suffix is longer", () => {
    const bundle = makeBundle();
    // "signal SIGABRT" is five characters longer than "exit 1"; a fixed slice
    // would produce an 83-character title that GitHub clips mid-word.
    for (const signal of ["SIGKILL", "SIGTERM", "SIGABRT"]) {
      const title = reportTitle({
        ...bundle,
        command: { ...bundle.command, argv: ["node", "a".repeat(200) + ".js"], exitCode: null, signal },
      });
      expect(title.length).toBeLessThanOrEqual(80);
      expect(title.endsWith("(signal " + signal + ")")).toBe(true);
      expect(title).toContain("...");
    }
  });

  it("reports a signal instead of an exit code when the process was killed", () => {
    const bundle = makeBundle();
    const title = reportTitle({
      ...bundle,
      command: { ...bundle.command, exitCode: null, signal: "SIGKILL" },
    });
    expect(title).toContain("SIGKILL");
    expect(title).not.toContain("exit");
  });
});

describe("buildReport", () => {
  it("never leaks the reporter home directory or bundle root", async () => {
    const root = workspace();
    writeFileSync(join(root, "logs", "stderr.txt"), "boom\n");
    writeFileSync(join(root, "logs", "stdout.txt"), "");
    const report = await buildReport({ bundle: makeBundle(), root });
    expect(report.body).not.toContain(homedir());
    expect(report.body).not.toContain(root);
  });

  it("quotes the tail of stderr under a Reproduce section", async () => {
    const root = workspace();
    const stderr = Array.from({ length: 40 }, (_, i) => "line " + String(i + 1)).join("\n");
    writeFileSync(join(root, "logs", "stderr.txt"), stderr + "\n");
    writeFileSync(join(root, "logs", "stdout.txt"), "");
    const report = await buildReport({ bundle: makeBundle(), root, tailLines: 5 });
    expect(report.body).toContain("## Reproduce");
    // Not "npx repropack": that registry name belongs to an unrelated package.
    expect(report.body).toContain("repropack replay ");
    expect(report.body).not.toContain("npx repropack");
    expect(report.body).toContain("line 40");
    expect(report.body).toContain("line 36");
    expect(report.body).not.toContain("line 35");
  });

  it("falls back to stdout when stderr is empty", async () => {
    const root = workspace();
    writeFileSync(join(root, "logs", "stderr.txt"), "");
    writeFileSync(join(root, "logs", "stdout.txt"), "all good until it was not\n");
    const report = await buildReport({ bundle: makeBundle(), root });
    expect(report.body).toContain("## stdout");
    expect(report.body).toContain("all good until it was not");
  });

  it("omits the log section entirely when both streams are empty", async () => {
    const root = workspace();
    writeFileSync(join(root, "logs", "stderr.txt"), "");
    writeFileSync(join(root, "logs", "stdout.txt"), "");
    const report = await buildReport({ bundle: makeBundle(), root });
    expect(report.body).not.toContain("## stderr");
    expect(report.body).not.toContain("## stdout");
    // The Reproduce section legitimately fenced; what must not appear is an
    // EMPTY fenced block, which renders as a stray grey box in the issue.
    const lines = report.body.split("\n");
    const emptyBlock = lines.some((line, i) => line === "```" && lines[i + 1] === "```");
    expect(emptyBlock).toBe(false);
  });
});

describe("buildReport: contents and redaction", () => {
  it("lists bundle files with their sizes and elides the remainder", async () => {
    const root = workspace();
    writeFileSync(join(root, "logs", "stderr.txt"), "x\n");
    writeFileSync(join(root, "logs", "stdout.txt"), "");
    const files = Array.from({ length: 25 }, (_, i) => file("src/f" + String(i) + ".ts", 1024));
    const report = await buildReport({ bundle: makeBundle({ files }), root });
    expect(report.body).toContain("25 file(s)");
    expect(report.body).toContain("src/f0.ts");
    expect(report.body).toContain("... and 5 more");
  });

  it("describes redaction only when something was redacted", async () => {
    const root = workspace();
    writeFileSync(join(root, "logs", "stderr.txt"), "x\n");
    writeFileSync(join(root, "logs", "stdout.txt"), "");
    const clean = await buildReport({ bundle: makeBundle(), root });
    expect(clean.body).not.toContain("## Redaction");
    const redacted = await buildReport({
      bundle: makeBundle({
        redaction: {
          totalMatches: 2,
          byRule: [{ rule: "github-token", count: 2, example: "REDACTED_GITHUB_TOKEN" }],
          bySurface: [{ surface: "files/src/a.ts", count: 2 }],
          rulesVersion: "1",
          skipped: [],
        },
      }),
      root,
    });
    expect(redacted.body).toContain("## Redaction");
    expect(redacted.body).toContain("github-token: 2 match(es)");
    expect(redacted.body).toContain("REDACTED_GITHUB_TOKEN");
  });

  it("surfaces capture warnings so a weak bundle cannot look trustworthy", async () => {
    const root = workspace();
    writeFileSync(join(root, "logs", "stderr.txt"), "x\n");
    writeFileSync(join(root, "logs", "stdout.txt"), "");
    const report = await buildReport({
      bundle: makeBundle({ warnings: ["not a git repository"] }),
      root,
    });
    expect(report.body).toContain("## Capture warnings");
    expect(report.body).toContain("not a git repository");
  });

  it("records the integrity hash so a reader can verify before trusting", async () => {
    const root = workspace();
    writeFileSync(join(root, "logs", "stderr.txt"), "x\n");
    writeFileSync(join(root, "logs", "stdout.txt"), "");
    const report = await buildReport({ bundle: makeBundle(), root });
    expect(report.body).toContain("abc123");
    expect(report.body).toContain("repropack verify");
  });
});