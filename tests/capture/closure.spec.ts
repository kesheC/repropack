import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectLocalImports } from "../../src/capture/closure.js";

const roots: string[] = [];

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "repropack-closure-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

function known(files: Record<string, string>): Set<string> {
  return new Set(Object.keys(files));
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("collectLocalImports", () => {
  it("follows a relative esm import to a sibling module", async () => {
    const files = {
      "src/main.js": "import { add } from \"./math.js\";\nadd(1, 2);\n",
      "src/math.js": "export function add(a, b) { return a + b; }\n",
      "src/unused.js": "export const nope = 1;\n",
    };
    const root = await project(files);
    const result = await collectLocalImports({ root, seeds: ["src/main.js"], known: known(files) });
    expect(result).toContain("src/main.js");
    expect(result).toContain("src/math.js");
    // Reachability, not reachability-plus-neighbours: an unused module in the
    // same directory stays out, or the closure failed at its only job.
    expect(result).not.toContain("src/unused.js");
  });

  it("resolves an extensionless specifier the way node would", async () => {
    const files = {
      "src/a.js": "import b from \"./b\";\n",
      "src/b.js": "export default 1;\n",
    };
    const root = await project(files);
    const result = await collectLocalImports({ root, seeds: ["src/a.js"], known: known(files) });
    expect(result).toContain("src/b.js");
  });

  it("follows a chain and returns every hop", async () => {
    const files = {
      "src/a.js": "import \"./b.js\";\n",
      "src/b.js": "require(\"./c.js\");\n",
      "src/c.js": "export const c = 1;\n",
    };
    const root = await project(files);
    const result = await collectLocalImports({ root, seeds: ["src/a.js"], known: known(files) });
    expect([...result].sort()).toEqual(["src/a.js", "src/b.js", "src/c.js"]);
  });

  it("never returns a path outside the project or one the walk would not ship", async () => {
    const files = {
      "src/a.js": "import \"../outside.js\";\nimport \"left-pad\";\nimport \"./ghost.js\";\n",
    };
    const root = await project(files);
    const result = await collectLocalImports({ root, seeds: ["src/a.js"], known: known(files) });
    // node_modules is not in `known`, an escaping specifier is refused, and a
    // missing file simply has no candidate; only the seed survives.
    expect([...result]).toEqual(["src/a.js"]);
  });

  it("stops at the limit instead of walking a pathological graph", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i += 1) {
      files["src/m" + String(i) + ".js"] = "import \"./m" + String(i + 1) + ".js\";\n";
    }
    const root = await project(files);
    const result = await collectLocalImports({ root, seeds: ["src/m0.js"], known: known(files), limit: 3 });
    expect(result).toHaveLength(3);
  });
});
