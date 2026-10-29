import { describe, expect, it } from "vitest";
import { generateDockerfile, generateReplayCmd, generateReplayScript } from "../../src/export/index.js";
import type { Bundle } from "../../src/types.js";

function bundle(overrides: Partial<Bundle> = {}): Bundle {
  return {
    formatVersion: 1,
    id: "0123456789abcdef0123456789abcdef",
    createdAt: "2026-01-01T00:00:00.000Z",
    producer: { name: "repropack", version: "0.1.0", node: "v20.11.0" },
    command: {
      argv: ["node", "test/fail.js"],
      cwd: ".",
      startedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 42,
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
      packageManager: { name: "npm", version: "10.0.0", lockfile: "package-lock.json" },
      env: { NODE_ENV: "test" },
      timezone: "UTC",
      locale: "en-US",
      resources: null,
    },
    repository: null,
    files: [],
    redaction: { rulesVersion: "1", totalMatches: 0, byRule: [], bySurface: [], skipped: [] },
    warnings: [],
    integrity: "deadbeef",
    ...overrides,
  };
}

describe("generateDockerfile", () => {
  it("picks a base image from the recorded node major version", () => {
    const text = generateDockerfile(bundle());
    expect(text).toContain("FROM node:20-bookworm-slim");
  });

  it("honours an explicit base image", () => {
    expect(generateDockerfile(bundle(), { baseImage: "ubuntu:24.04" })).toContain("FROM ubuntu:24.04");
  });

  it("copies the captured files and sets the recorded env", () => {
    const text = generateDockerfile(bundle());
    expect(text).toContain("COPY files/ /app/");
    expect(text).toContain('ENV NODE_ENV="test"');
    expect(text).toContain('ENV TZ="UTC"');
  });

  it("emits the recorded command as CMD", () => {
    expect(generateDockerfile(bundle())).toContain('CMD ["node","test/fail.js"]');
  });

  it("says plainly that the image is derived, not verified", () => {
    // Claiming otherwise would be the kind of quiet overstatement that makes a
    // reproduction tool untrustworthy.
    expect(generateDockerfile(bundle())).toContain("not from a verified build");
  });

  it("enables corepack for pnpm", () => {
    const text = generateDockerfile(
      bundle({
        environment: {
          ...bundle().environment,
          packageManager: { name: "pnpm", version: "9.0.0", lockfile: "pnpm-lock.yaml" },
        },
      }),
    );
    expect(text).toContain("corepack prepare pnpm@9.0.0 --activate");
  });

  it("omits the package manager block when none was recorded", () => {
    const text = generateDockerfile(
      bundle({ environment: { ...bundle().environment, packageManager: null } }),
    );
    expect(text).not.toContain("corepack");
  });
});

describe("generateReplayScript", () => {
  it("is a posix shell script that runs from the bundle's files/ directory", () => {
    const text = generateReplayScript(bundle());
    expect(text.startsWith("#!/bin/sh")).toBe(true);
    // The bundle keeps the project tree under files/, so the command has to run
    // there; at the bundle root the recorded relative path does not exist.
    expect(text).toContain('cd "$(dirname "$0")/files"');
  });

  it("runs the recorded command and reports the exit code", () => {
    const text = generateReplayScript(bundle());
    expect(text).toContain("node test/fail.js");
    expect(text).toContain("recorded: 1");
  });

  it("quotes arguments containing spaces", () => {
    const text = generateReplayScript(
      bundle({ command: { ...bundle().command, argv: ["node", "a b.js"] } }),
    );
    expect(text).toContain("'a b.js'");
  });

  it("exports the recorded environment", () => {
    expect(generateReplayScript(bundle())).toContain("export NODE_ENV=test");
  });
});

describe("generateReplayCmd", () => {
  it("is a batch file with crlf line endings", () => {
    const text = generateReplayCmd(bundle());
    expect(text.startsWith("@echo off")).toBe(true);
    expect(text).toContain("\r\n");
  });

  it("runs from the bundle's files/ directory and sets the environment", () => {
    const text = generateReplayCmd(bundle());
    expect(text).toContain('cd /d "%~dp0files"');
    expect(text).toContain("set NODE_ENV=test");
  });
});
