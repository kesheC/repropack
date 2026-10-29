import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ENV_ALLOWLIST,
  captureEnv,
  probeEnvironment,
  probePackageManager,
} from "../../src/capture/env.js";

const dirs: string[] = [];

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "repropack-env-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("captureEnv allowlist", () => {
  it("keeps only allowlisted variables", () => {
    const captured = captureEnv(
      {
        PATH: "/usr/bin",
        SECRET_TOKEN: "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        RANDOM_VAR: "nothing to see",
        NODE_ENV: "test",
      },
      ["PATH", "NODE_ENV"],
    );
    expect(Object.keys(captured).sort()).toEqual(["NODE_ENV", "PATH"]);
  });

  it("drops a secret that is allowlisted under a different name", () => {
    const captured = captureEnv({ SECRET_TOKEN: "s3cr3t-value", PATH: "/bin" }, ["PATH"]);
    expect(JSON.stringify(captured)).not.toContain("s3cr3t-value");
    expect(JSON.stringify(captured)).not.toContain("SECRET_TOKEN");
  });

  it("matches allowlist entries case-insensitively and normalises the key", () => {
    const captured = captureEnv({ path: "C:\\bin", Path: "C:\\other", Node_Env: "ci" }, ["PATH", "NODE_ENV"]);
    // Sorted iteration means "Path" is seen before "path"; both upper-case to PATH.
    expect(captured["PATH"]).toBe("C:\\bin");
    expect(captured["NODE_ENV"]).toBe("ci");
    expect(Object.keys(captured).every((key) => key === key.toUpperCase())).toBe(true);
  });

  it("redacts the user name out of PATH", () => {
    const captured = captureEnv({ PATH: "C:\\Users\\alice\\AppData\\Roaming\\npm" }, ["PATH"]);
    expect(captured["PATH"]).toBeDefined();
    expect(captured["PATH"]).not.toContain("alice");
    expect(captured["PATH"]).toContain("REDACTED_");
  });

  it("redacts a POSIX home directory in HOME", () => {
    const captured = captureEnv({ HOME: "/home/bob" }, ["HOME"]);
    expect(captured["HOME"]).not.toContain("bob");
  });

  it("skips undefined values rather than writing the string 'undefined'", () => {
    const captured = captureEnv({ PATH: undefined, LANG: "en_US.UTF-8" }, ["PATH", "LANG"]);
    expect(captured).toEqual({ LANG: "en_US.UTF-8" });
  });

  it("returns an empty object for an empty environment", () => {
    expect(captureEnv({}, ["PATH"])).toEqual({});
  });

  it("default allowlist does not name any secret-ish variable", () => {
    for (const name of DEFAULT_ENV_ALLOWLIST) {
      expect(name).not.toMatch(/SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE/i);
    }
  });
});

describe("probeEnvironment", () => {
  it("fills every scalar field from the running node", async () => {
    const dir = await makeDir();
    const fingerprint = await probeEnvironment({ cwd: dir, env: {} });
    expect(fingerprint.platform).toBe(process.platform);
    expect(fingerprint.arch).toBe(process.arch);
    expect(fingerprint.release.length).toBeGreaterThan(0);
    expect(fingerprint.node).toBe(process.version);
    expect(fingerprint.nodeAbi).toMatch(/^\d+$/);
    expect(fingerprint.timezone.length).toBeGreaterThan(0);
    expect(fingerprint.locale.length).toBeGreaterThan(0);
    expect(fingerprint.env).toEqual({});
    expect(fingerprint.packageManager).toBeNull();
  });

  it("reports positive resource limits", async () => {
    const dir = await makeDir();
    const fingerprint = await probeEnvironment({ cwd: dir, env: {} });
    expect(fingerprint.resources).not.toBeNull();
    expect(fingerprint.resources?.cpuCount).toBeGreaterThan(0);
    expect(fingerprint.resources?.totalMemoryMb).toBeGreaterThan(0);
    expect(fingerprint.resources?.freeMemoryMb).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(fingerprint.resources?.totalMemoryMb)).toBe(true);
  });

  it("never leaks a non-allowlisted secret into the fingerprint", async () => {
    const dir = await makeDir();
    const fingerprint = await probeEnvironment({
      cwd: dir,
      env: {
        PATH: "/usr/bin",
        SECRET_TOKEN: "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        DATABASE_URL: "postgres://u:hunter2@localhost/db",
      },
    });
    const serialised = JSON.stringify(fingerprint);
    expect(serialised).not.toContain("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(serialised).not.toContain("hunter2");
    expect(Object.keys(fingerprint.env)).toEqual(["PATH"]);
  });

  it("honours an extra allowlist entry", async () => {
    const dir = await makeDir();
    const fingerprint = await probeEnvironment({
      cwd: dir,
      env: { MY_BUILD_FLAG: "1", OTHER: "2" },
      envAllowlist: ["MY_BUILD_FLAG"],
    });
    expect(fingerprint.env["MY_BUILD_FLAG"]).toBe("1");
    expect(fingerprint.env["OTHER"]).toBeUndefined();
  });
});

describe("probePackageManager", () => {
  const lockfileCases: { file: string; name: string }[] = [
    { file: "package-lock.json", name: "npm" },
    { file: "pnpm-lock.yaml", name: "pnpm" },
    { file: "yarn.lock", name: "yarn" },
    { file: "bun.lockb", name: "bun" },
  ];

  for (const testCase of lockfileCases) {
    it("detects " + testCase.name + " from " + testCase.file, async () => {
      const dir = await makeDir();
      await writeFile(join(dir, testCase.file), "", "utf8");
      const fingerprint = await probePackageManager(dir);
      expect(fingerprint?.name).toBe(testCase.name);
      expect(fingerprint?.lockfile).toBe(testCase.file);
      expect(typeof fingerprint?.version).toBe("string");
    });
  }

  it("returns null when no lockfile is present", async () => {
    const dir = await makeDir();
    await expect(probePackageManager(dir)).resolves.toBeNull();
  });

  it("still names the manager when its binary is missing", async () => {
    const dir = await makeDir();
    await writeFile(join(dir, "yarn.lock"), "", "utf8");
    const fingerprint = await probePackageManager(dir);
    expect(fingerprint?.name).toBe("yarn");
    // yarn is absent on this box; the probe must degrade rather than throw.
    expect(fingerprint?.version.length).toBeGreaterThan(0);
  });
});
