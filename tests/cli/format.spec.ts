import { describe, expect, it } from "vitest";
import { formatBundle, formatVerify, shellish, sortFindings } from "../../src/cli/format.js";
import type { Bundle, BundleFile, VerifyFinding } from "../../src/types.js";

/** A minimal bundle: only the fields the formatter reads are interesting, the rest is filler. */
function makeBundle(overrides: Partial<Bundle> = {}): Bundle {
  const files: readonly BundleFile[] = [
    { path: "src/broken.js", bytes: 1024, sha256: "a".repeat(64), mode: "100644", reason: "input", truncated: false },
    { path: "package.json", bytes: 1024, sha256: "b".repeat(64), mode: "100644", reason: "input", truncated: false },
  ];
  return {
    formatVersion: 1,
    id: "0123456789abcdef0123456789abcdef",
    createdAt: "2026-10-29T23:00:00.000Z",
    producer: { name: "repropack", version: "0.1.0", node: "v24.0.0" },
    command: {
      argv: ["node", "src/broken.js"],
      cwd: ".",
      startedAt: "2026-10-29T23:00:00.000Z",
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
      release: "6.0.0",
      node: "v24.0.0",
      nodeAbi: "137",
      packageManager: null,
      env: {},
      timezone: "UTC",
      locale: "en-US",
      resources: null,
    },
    repository: null,
    files,
    redaction: { rulesVersion: "1", totalMatches: 0, byRule: [], bySurface: [], skipped: [] },
    warnings: [],
    integrity: "c".repeat(64),
    ...overrides,
  };
}

function finding(overrides: Partial<VerifyFinding> & Pick<VerifyFinding, "severity" | "code">): VerifyFinding {
  return { message: "m", ...overrides };
}

describe("sortFindings", () => {
  it("orders blocker before warning before note", () => {
    const sorted = sortFindings([
      finding({ severity: "note", code: "oversize" }),
      finding({ severity: "blocker", code: "leak-suspected" }),
      finding({ severity: "warning", code: "missing-file" }),
    ]);
    expect(sorted.map((f) => f.severity)).toEqual(["blocker", "warning", "note"]);
  });

  it("breaks ties on severity by code, ascending", () => {
    const sorted = sortFindings([
      finding({ severity: "warning", code: "oversize" }),
      finding({ severity: "warning", code: "missing-file" }),
      finding({ severity: "warning", code: "absolute-path" }),
    ]);
    expect(sorted.map((f) => f.code)).toEqual(["absolute-path", "missing-file", "oversize"]);
  });

  it("breaks ties on severity and code by path, ascending", () => {
    const sorted = sortFindings([
      finding({ severity: "warning", code: "missing-file", path: "src/z.js" }),
      finding({ severity: "warning", code: "missing-file", path: "src/a.js" }),
      finding({ severity: "warning", code: "missing-file", path: "src/m.js" }),
    ]);
    expect(sorted.map((f) => f.path)).toEqual(["src/a.js", "src/m.js", "src/z.js"]);
  });

  it("tolerates findings without a path and sorts them before pathed ones", () => {
    const sorted = sortFindings([
      finding({ severity: "note", code: "no-reproducible-command" }),
      finding({ severity: "note", code: "missing-file", path: "src/a.js" }),
      finding({ severity: "note", code: "integrity-mismatch" }),
    ]);
    // Code is compared before path, so the pathed finding lands in the middle.
    expect(sorted.map((f) => f.code)).toEqual(["integrity-mismatch", "missing-file", "no-reproducible-command"]);
    expect(sorted.map((f) => f.path)).toEqual([undefined, "src/a.js", undefined]);
  });

  it("does not mutate its input", () => {
    const input = [
      finding({ severity: "note", code: "oversize" }),
      finding({ severity: "blocker", code: "leak-suspected" }),
    ];
    const before = input.map((f) => f.severity);
    sortFindings(input);
    expect(input.map((f) => f.severity)).toEqual(before);
  });

  it("returns an empty array for empty input", () => {
    expect(sortFindings([])).toEqual([]);
  });
});

describe("shellish", () => {
  it("leaves simple arguments unquoted", () => {
    expect(shellish(["node", "src/broken.js", "--flag=1", "-x"])).toBe("node src/broken.js --flag=1 -x");
  });

  it("quotes arguments containing whitespace", () => {
    expect(shellish(["echo", "hello world"])).toBe('echo "hello world"');
    // Parentheses are shell metacharacters too, so a JS one-liner gets quoted.
    expect(shellish(["node", "-e", "console.log(1)"])).toBe('node -e "console.log(1)"');
  });

  it("quotes shell metacharacters", () => {
    expect(shellish(["sh", "-c", "a && b"])).toBe('sh -c "a && b"');
    expect(shellish(["echo", "$HOME"])).toBe('echo "$HOME"');
    expect(shellish(["echo", "a;b"])).toBe('echo "a;b"');
  });

  it("returns an empty string for an empty argv", () => {
    expect(shellish([])).toBe("");
  });
});

describe("formatBundle", () => {
  it("starts with the id prefix", () => {
    const text = formatBundle(makeBundle());
    expect(text.split("\n")[0]).toBe("repropack bundle 0123456789ab");
  });

  it("renders command, exit, files and redaction rows", () => {
    const text = formatBundle(makeBundle());
    expect(text).toContain("node src/broken.js");
    expect(text).toMatch(/exit\s+1/);
    expect(text).toMatch(/files\s+2 \(2 KB\)/);
    expect(text).toMatch(/redacted\s+0 match\(es\) in 0 rule\(s\)/);
  });

  it("renders a null exit code as the signal", () => {
    const bundle = makeBundle();
    const text = formatBundle({
      ...bundle,
      command: { ...bundle.command, exitCode: null, signal: "SIGKILL" },
    });
    expect(text).toMatch(/exit\s+signal SIGKILL/);
  });

  it("prints repo none when there is no repository snapshot", () => {
    expect(formatBundle(makeBundle())).toMatch(/repo\s+none/);
  });

  it("shortens the commit and marks a dirty worktree", () => {
    const bundle = makeBundle();
    const text = formatBundle({
      ...bundle,
      repository: {
        vcs: "git",
        root: "/repo",
        commit: "abcdef1234567890",
        branch: "main",
        describe: null,
        dirty: true,
        statusLines: [],
        remotes: [],
      },
    });
    expect(text).toContain("abcdef1234 (dirty) on main");
  });

  it("appends warnings after a blank line", () => {
    const bundle = makeBundle();
    const text = formatBundle({ ...bundle, warnings: ["not a git repository", "log truncated"] });
    expect(text).toContain("\n\nwarnings:\n  - not a git repository\n  - log truncated");
  });

  it("omits the warnings section when there are none", () => {
    expect(formatBundle(makeBundle())).not.toContain("warnings:");
  });

  it("quotes a command argument that contains a space", () => {
    const bundle = makeBundle();
    const text = formatBundle({ ...bundle, command: { ...bundle.command, argv: ["node", "my script.js"] } });
    expect(text).toContain('node "my script.js"');
  });
});

describe("formatVerify", () => {
  it("says no findings when clean", () => {
    expect(formatVerify({ ok: true, findings: [] })).toBe("no findings");
  });

  it("renders one line per finding in sorted order", () => {
    const result = formatVerify({
      ok: false,
      findings: [
        finding({ severity: "note", code: "oversize", message: "too big" }),
        finding({ severity: "blocker", code: "leak-suspected", message: "token found", path: "src/a.js" }),
      ],
    });
    const lines = result.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("leak-suspected");
    expect(lines[0]).toContain("src/a.js");
    expect(lines[0]).toContain("token found");
    expect(lines[1]).toContain("oversize");
  });
});
