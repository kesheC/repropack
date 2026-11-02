/**
 * The release pipeline only runs on a tag push, so nothing else in the repo
 * would ever execute it: a gate that silently stopped working would stay
 * green until the day it mattered. This file pins the guards two ways.
 *
 *   1. structurally, against the YAML text - the guard exists and is ordered
 *      before the things it protects;
 *   2. behaviourally, by cutting the guard's own shell body out of the
 *      workflow and running it against a throwaway package.json.
 *
 * Only node's stdlib and vitest are used: the project ships zero runtime
 * dependencies and does not take a YAML parser just to read two files it
 * owns.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** The name this package is published under; CI imports it as a bare specifier. */
const PKG_NAME = "repropack";

function readWorkflow(name: string): string {
  return readFileSync(path.join(repoRoot, ".github", "workflows", name), "utf8");
}

/**
 * Cut the body of one step out of a workflow, keyed by its "- name:" line.
 * Every step here is a bash "run: |" block, so the body is whatever follows,
 * de-indented, up to the first line indented less than the first body line.
 */
function stepBody(workflow: string, stepName: string): string {
  const marker = "- name: " + stepName;
  const at = workflow.indexOf(marker);
  if (at < 0) throw new Error("step not found in workflow: " + stepName);
  const runAt = workflow.indexOf("run: |", at);
  if (runAt < 0) throw new Error("step has no run block: " + stepName);
  const bodyStart = workflow.indexOf("\n", runAt) + 1;
  const lines = workflow.slice(bodyStart).split("\n");
  const indents = lines
    .filter((line) => line.trim() !== "")
    .map((line) => (line.match(/^ */) as RegExpMatchArray)[0].length);
  const bodyIndent = Math.min(...indents);
  const body: string[] = [];
  for (const line of lines) {
    const indent = line.trim() === "" ? Number.POSITIVE_INFINITY : (line.match(/^ */) as RegExpMatchArray)[0].length;
    if (indent < bodyIndent) break;
    body.push(line.slice(bodyIndent));
  }
  return body.join("\n").trimEnd();
}

/** Extract the JavaScript out of an inline "node -e '...' \"$ARG\"" invocation. */
function inlineNodeScript(shell: string, nth = 0): string {
  const opener = "node -e '";
  let from = -1;
  for (let i = 0; i <= nth; i += 1) {
    from = shell.indexOf(opener, from + 1);
    if (from < 0) throw new Error("inline node -e number " + String(nth) + " not found");
  }
  const start = from + opener.length;
  const end = shell.indexOf("' \"$", start);
  if (end < 0) throw new Error("inline node -e has no closing quote and argument");
  return shell.slice(start, end);
}

interface GateResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run the real release gate against a synthetic package.json.
 *
 * The gate reads process.argv[1], which under "node -e" is the first user
 * argument but is the script path when node is handed a file, so the workflow
 * is reproduced exactly: the body goes to -e and the tag after it.
 */
function runGate(tag: string, version: string): GateResult {
  const gate = inlineNodeScript(stepBody(readWorkflow("release.yml"), "Publish release assets"), 0);
  const dir = mkdtempSync(path.join(tmpdir(), "gate-"));
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: PKG_NAME, version }), "utf8");
  const result = spawnSync(process.execPath, ["-e", gate, tag], { cwd: dir, encoding: "utf8" });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const REQUIRED_EXPORTS = [
  "capture",
  "replay",
  "verifyBundle",
  "readBundle",
  "packBundle",
];

describe("release workflow: the tag must agree with package.json", () => {
  it("accepts a tag that matches package.json", () => {
    const result = runGate("v0.1.7", "0.1.7");
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("matches package.json version 0.1.7");
    expect(result.code).toBe(0);
  });

  it("rejects a tag that drifted, and prints both sides", () => {
    const result = runGate("v0.1.8", "0.1.7");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("tag/version mismatch: tag says 0.1.8, package.json says 0.1.7");
    expect(result.stdout).toBe("");
  });

  it("rejects a tag that is not vX.Y.Z at all", () => {
    const result = runGate("nightlies", "0.1.7");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("tag is not a vX.Y.Z tag: nightlies");
  });

  it("rejects a prerelease tag, which can never equal a plain version", () => {
    const result = runGate("v0.1.7-rc.1", "0.1.7");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("tag says 0.1.7-rc.1");
  });

  it("gates before the CHANGELOG lookup and before any gh call", () => {
    const publish = stepBody(readWorkflow("release.yml"), "Publish release assets");
    const gateAt = publish.indexOf("tag/version mismatch");
    const changelogAt = publish.indexOf("CHANGELOG.md");
    const ghAt = publish.indexOf("gh release");
    expect(gateAt).toBeGreaterThan(-1);
    expect(changelogAt).toBeGreaterThan(-1);
    expect(ghAt).toBeGreaterThan(-1);
    // Otherwise a drifted tag is reported as "CHANGELOG has no section for ...",
    // which sends whoever pushed the tag to the wrong file entirely.
    expect(gateAt).toBeLessThan(changelogAt);
    expect(gateAt).toBeLessThan(ghAt);
  });
});

describe("CI workflow: the packed artifact is the thing under test", () => {
  it("keeps the engines floor on the oldest matrix column", () => {
    // `engines.node` is the promise to users; the matrix is the versions we
    // actually run. If the matrix drops 20, an engines floor of 20 is a claim
    // nobody tests any more; if it grows only on the right, the promise is a
    // version we never ran. Bind the two so neither can move alone.
    const ci = readWorkflow("ci.yml");
    const matrix = /node:\s*\[([^\]]*)\]/.exec(ci);
    if (matrix?.[1] === undefined) throw new Error("ci.yml no longer declares a node matrix");
    const majors = matrix[1].split(",").map((entry) => Number(entry.trim()));
    const oldest = Math.min(...majors);
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      engines?: { node?: string };
    };
    const engines = pkg.engines;
    const floor = /^>=(\d+)\.(\d+)$/.exec(engines?.node ?? "");
    if (floor?.[1] === undefined) throw new Error("engines.node is not a >=X.Y floor: " + engines?.node);
    expect(Number(floor[1])).toBe(oldest);
  });
  const smoke = stepBody(readWorkflow("ci.yml"), "Smoke test the packed tarball");

  it("fails the build on a high or critical advisory in the toolchain", () => {
    // The package ships zero runtime dependencies, so dev dependencies are the
    // whole supply chain. The gate is only worth having if it runs after the
    // install: npm audit before npm ci reads an empty tree and exits 0, which
    // would be a check that can never fail.
    const ci = readWorkflow("ci.yml");
    const installAt = ci.indexOf("run: npm ci");
    const auditAt = ci.indexOf("npm audit --audit-level=high");
    expect(installAt).toBeGreaterThan(-1);
    expect(auditAt).toBeGreaterThan(-1);
    expect(auditAt).toBeGreaterThan(installAt);
  });

  it("inspects the tarball from the repo root, before changing directory", () => {
    const packAt = smoke.indexOf("npm pack --dry-run --json > pack-meta.json");
    const cdAt = smoke.indexOf('cd "$SMOKE"');
    expect(packAt).toBeGreaterThan(-1);
    expect(cdAt).toBeGreaterThan(-1);
    // npm pack packs the current directory; inspecting after cd would check a
    // throwaway empty package and stay green forever.
    expect(packAt).toBeLessThan(cdAt);
  });

  it("asserts the required entries, the leak prefixes and the absence of maps", () => {
    for (const needle of [
      "dist/index.js",
      "dist/cli.js",
      "dist/index.d.ts",
      "the tarball leaks ",
      "'tests/', 'src/', 'node_modules/'",
      ".js.map",
    ]) {
      expect(smoke).toContain(needle);
    }
  });

  it("imports the installed package instead of the checkout", () => {
    expect(smoke).toContain("node --input-type=module");
    expect(smoke).toContain("await import('" + PKG_NAME + "')");
    expect(smoke.indexOf("await import('" + PKG_NAME + "')")).toBeGreaterThan(smoke.indexOf('cd "$SMOKE"'));
  });

  it("names library exports that this package actually exports", async () => {
    const entry = path.join(repoRoot, "dist", "index.js");
    const api = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
    for (const name of REQUIRED_EXPORTS) {
      expect(smoke, name + " is asserted by CI but is not exported").toContain("'" + name + "'");
      expect(typeof api[name], name + " must be a function").toBe("function");
    }
  });

  it("keeps the generated pack-meta.json out of version control", () => {
    const gitignore = readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
    expect(gitignore.split(/\r?\n/)).toContain("pack-meta.json");
  });
});

/**
 * Cut one inline node program out of a shell step.
 *
 * Both quoting styles are in use: release.yml wraps the tag gate in single
 * quotes and passes the tag after them, ci.yml wraps the pack assertion in
 * double quotes. The terminator is the same indent and the same quote.
 */
function programAfter(shell: string, marker: string): string {
  const lines = shell.split("\n");
  const at = lines.findIndex((line) => line.includes(marker));
  if (at < 0) throw new Error("marker not found in the step: " + marker);
  for (let index = at; index < lines.length; index += 1) {
    const opener = /^(\s*)node (?:--input-type=module )?-e (")$/.exec(lines[index] ?? "");
    if (!opener) continue;
    const indent = opener[1] ?? "";
    const quote = opener[2] ?? '"';
    const collected: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] ?? "";
      if (new RegExp("^" + indent + quote).test(line)) return collected.join("\n");
      collected.push(line.slice(indent.length));
    }
    throw new Error("unterminated node program after " + marker);
  }
  throw new Error("no node program follows " + marker);
}

describe("CI workflow: the package-contents assertion rejects rotten input", () => {
  const smoke = stepBody(readWorkflow("ci.yml"), "Smoke test the packed tarball");
  const contents = programAfter(smoke, "npm pack --dry-run --json > pack-meta.json");
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    main: string;
    types?: string;
    bin?: Record<string, string>;
  };

  /** The entries package.json promises, in the form npm records them. */
  const promised = [
    "LICENSE",
    "README.md",
    "package.json",
    ...new Set(
      [manifest.main, manifest.types, ...Object.values(manifest.bin ?? {})]
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.replace(/^\.\//, "")),
    ),
  ];

  function packMeta(paths: string[]): string {
    return JSON.stringify([{ name: PKG_NAME, version: "0.0.0", files: paths.map((entry) => ({ path: entry, size: 1 })) }]);
  }

  function run(contents: string, files: Record<string, string>): GateResult {
    const dir = mkdtempSync(path.join(tmpdir(), "pack-"));
    for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content, "utf8");
    const result = spawnSync(process.execPath, ["-e", contents], { cwd: dir, encoding: "utf8" });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it("passes on a tarball that carries exactly what package.json promises", () => {
    const result = run(contents, { "pack-meta.json": packMeta(promised) });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("package contents ok");
  });

  it("rejects a sourcemap that points into a src/ the tarball does not ship", () => {
    const result = run(contents, { "pack-meta.json": packMeta([...promised, promised[3] + ".map"]) });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(".js.map");
  });

  it("rejects a tarball with no dist/ at all instead of passing on size", () => {
    const result = run(contents, { "pack-meta.json": packMeta(["LICENSE", "README.md", "package.json"]) });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no dist/ entries at all");
  });

  it("rejects a tarball that leaked the source tree", () => {
    const result = run(contents, { "pack-meta.json": packMeta([...promised, "src/index.ts"]) });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("leaks src/");
  });
});
/**
 * Read a tsconfig the way tsc does: these files carry // comments, so plain
 * JSON.parse would throw on the config that is actually shipped.
 */
function readTsconfig(name: string): { compilerOptions: Record<string, unknown> } {
  const raw = readFileSync(path.join(repoRoot, name), "utf8");
  const stripped = raw.replace(/^\s*\/\/.*$/gm, "");
  return JSON.parse(stripped) as { compilerOptions: Record<string, unknown> };
}

describe("build config: no sourcemaps for sources that are not shipped", () => {
  it("turns sourceMap and declarationMap off in the build layer", () => {
    const build = readTsconfig("tsconfig.build.json");
    expect(build.compilerOptions.sourceMap).toBe(false);
    expect(build.compilerOptions.declarationMap).toBe(false);
  });

  it("leaves the editor config with sourcemaps", () => {
    const editor = readTsconfig("tsconfig.json");
    expect(editor.compilerOptions.sourceMap).toBe(true);
  });

  it("does not publish a source tree that the tarball does not contain", () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { files: string[] };
    // A .js.map points at src/*.ts; "src" is not in "files", so every map that
    // used to ship was a dead link to a file the user never receives.
    expect(pkg.files).not.toContain("src");
  });
  it("clears dist/ before compiling, so a stale artifact cannot survive a config change", () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    // tsc never deletes: turning a gate off would leave the previous build's
    // output in dist/ and npm pack would ship it anyway, so the build has to
    // start from an empty directory.
    expect(pkg.scripts.build).toContain("npm run clean");
    expect(pkg.scripts.clean).toContain("rmSync");
    expect(pkg.scripts.clean).toContain("dist");
  });
});

describe("release workflow: the release is published, not left as a draft", () => {
  const publish = stepBody(readWorkflow("release.yml"), "Publish release assets");

  it("re-publishes an existing release explicitly", () => {
    // GitHub turns a release into a draft when its tag is deleted and pushed
    // again. Creating it once is not enough: the job has to publish whatever
    // state it found.
    expect(publish).toContain("gh release edit");
    expect(publish).toContain("--draft=false");
  });

  it("publishes before uploading, so the upload target is not a draft", () => {
    const publishAt = publish.indexOf("--draft=false");
    const uploadAt = publish.indexOf("gh release upload");
    // Both have to be present: indexOf returns -1 for a missing needle, and
    // -1 is less than every real offset, so a bare comparison would pass.
    expect(publishAt).toBeGreaterThan(-1);
    expect(uploadAt).toBeGreaterThan(-1);
    expect(publishAt).toBeLessThan(uploadAt);
  });
});

describe("CI workflow: every command package.json declares is smoke tested", () => {
  const smoke = stepBody(readWorkflow("ci.yml"), "Smoke test the packed tarball");
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    bin?: Record<string, string>;
  };

  it("runs the version flag of each declared bin", () => {
    const names = Object.keys(manifest.bin ?? {});
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      // Each alias can break on its own: a typo in one entry of "bin" leaves
      // the other one working, so a single check would not notice.
      expect(smoke, name + " is in package.json but CI never runs it").toContain("./node_modules/.bin/" + name + " --version");
    }
  });
});

describe("the contributor-facing gate list", () => {
  // CONTRIBUTING.md opens its gate section with "the commands CI runs" and then
  // lists them. That sentence is a claim about the workflow, so it drifts the
  // moment a step is added to one and not the other -- which is what happened
  // when the audit step landed and the list still said "the same three commands".
  it("names the same commands the workflow runs", () => {
    const contrib = readFileSync(path.join(repoRoot, "CONTRIBUTING.md"), "utf8");
    const ci = readWorkflow("ci.yml");
    const commands = ["npm run typecheck", "npm run build", "npm test", "npm run coverage", "npm audit --audit-level=high"];
    for (const command of commands) {
      expect(ci).toContain("run: " + command);
      expect(contrib).toContain(command);
    }
  });

  it("enforces the coverage floors somewhere, on one leg", () => {
    // A threshold in vitest.config.ts is read by `vitest run --coverage` and by
    // nothing else. The floors and the step that consults them therefore have
    // to be pinned together: drop the step and the four numbers become a policy
    // nobody applies, still sitting there looking enforced.
    const config = readFileSync(path.join(repoRoot, "vitest.config.ts"), "utf8");
    const thresholds = /thresholds:\s*\{([^}]*)\}/.exec(config);
    if (thresholds?.[1] === undefined) {
      throw new Error("vitest.config.ts declares no coverage.thresholds");
    }
    for (const key of ["statements", "branches", "functions", "lines"]) {
      expect(thresholds[1], "no floor for " + key).toContain(key);
    }

    // Coverage is a second full run of the suite. Running it on all six legs
    // would double what CI costs without telling anyone anything new, so the
    // step is expected to be gated to a single leg -- and it has to run after
    // the install, or it measures an empty tree.
    const ci = readWorkflow("ci.yml");
    const at = ci.indexOf("run: npm run coverage");
    expect(at).toBeGreaterThan(ci.indexOf("run: npm ci"));
    const step = ci.slice(ci.lastIndexOf("- name:", at), at);
    expect(step, "the coverage step runs on every matrix leg").toContain("if:");
  });
});

describe("the actions the workflows run", () => {
  // A tag on a third-party action is a mutable pointer: `actions/checkout@v5`
  // means whatever that repository's maintainers pushed to the v5 tag today.
  // These workflows run with the repository's own token, so a moved pointer is
  // a supply-chain entry point that no test would ever notice -- CI would just
  // start running different code and stay green.
  //
  // Pin the commit, keep the readable version beside it. Dependabot bumps both
  // halves together, so the comment cannot drift away from the sha.
  const workflows = ["ci.yml", "release.yml"];

  it("pins every action to a commit sha", () => {
    for (const name of workflows) {
      const lines = readWorkflow(name).split(/\r?\n/);
      const uses = lines.filter((line) => line.includes("uses:"));
      expect(uses.length, name + " runs no actions at all").toBeGreaterThan(0);
      for (const line of uses) {
        const ref = line.slice(line.indexOf("uses:") + "uses:".length).trim().split(/\s+/)[0] ?? "";
        // Both halves matter. A 40-character sha alone is unreadable six months
        // later; a tag alone is the mutable pointer this test exists to stop.
        expect(ref, name + ": " + ref + " is not pinned to a commit sha").toMatch(/@[0-9a-f]{40}$/);
        expect(line, name + ": " + ref + " has no version comment").toMatch(/# v\d+\.\d+\.\d+\s*$/);
      }
    }
  });
});


describe("the dependencies dependabot is told to leave alone", () => {
  // The list in dependabot.yml is a claim about the tree: "these upgrades
  // cannot install here". Nothing executes that file on a pull request, so a
  // stale entry and a missing one both stay silent until a bot opens the pull
  // request -- which is how coverage-v8 arrived with no ignore line beside
  // vitest's, and every CI leg failed on ERESOLVE. Read the manifest, the
  // lockfile and the config together and hold them to each other.
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    devDependencies?: Record<string, string>;
  };
  const lock = JSON.parse(readFileSync(path.join(repoRoot, "package-lock.json"), "utf8")) as {
    packages?: Record<string, { peerDependencies?: Record<string, string> }>;
  };
  const dependabot = readFileSync(path.join(repoRoot, ".github", "dependabot.yml"), "utf8");
  const dev = Object.keys(manifest.devDependencies ?? {});

  /** Dependencies whose version-update:semver-major is refused. */
  function ignoredMajors(): string[] {
    const lines = dependabot.split(/\r?\n/);
    const names: string[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const match = /^\s*-\s*dependency-name:\s*"([^"]+)"\s*$/.exec(lines[index] ?? "");
      const name = match?.[1];
      if (name === undefined) continue;
      // The update-types list is the line after the name, possibly blank-separated.
      let next = index + 1;
      while (next < lines.length && (lines[next] ?? "").trim() === "") next += 1;
      const following = lines[next];
      if (following !== undefined && following.includes("version-update:semver-major")) names.push(name);
    }
    return names;
  }

  it("holds back both halves of a pair npm resolves as one version", () => {
    // An exact peer pin means the two packages release in lockstep: bumping
    // one alone is a dependency graph npm refuses to resolve. Ignoring one
    // and not the other is therefore not a cautious default, it is a pull
    // request that cannot install.
    const ignored = new Set(ignoredMajors());
    let pairs = 0;
    for (const name of dev) {
      const peers = lock.packages?.["node_modules/" + name]?.peerDependencies ?? {};
      for (const [peerName, range] of Object.entries(peers)) {
        if (!dev.includes(peerName)) continue; // an optional peer this package never installs
        if (!/^\d+\.\d+\.\d+$/.test(range)) continue; // a range npm can resolve on its own
        pairs += 1;
        expect(
          ignored.has(name),
          name + " is pinned to " + peerName + " " + range + ", so both majors move together",
        ).toBe(ignored.has(peerName));
      }
    }
    expect(pairs, "no exact peer pin was found to check").toBeGreaterThan(0);
  });

  it("only holds back packages the repository still declares", () => {
    // An ignore outlives the dependency it names: remove a package and the
    // entry keeps sitting there, quietly announcing a constraint on nothing.
    for (const name of ignoredMajors()) {
      expect(dev, "dependabot ignores " + name + " but nothing declares it").toContain(name);
    }
  });
});
