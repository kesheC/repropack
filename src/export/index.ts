import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateDockerfile, generateReplayCmd, generateReplayScript } from "./dockerfile.js";
import type { Bundle } from "../types.js";

export { generateDockerfile, generateReplayScript, generateReplayCmd } from "./dockerfile.js";

export interface ExportResult {
  written: readonly string[];
}

/**
 * Write the replay artefacts next to a bundle.
 *
 * Called at the end of `capture` so a bundle is self-sufficient the moment it
 * is created: unzip it on another machine and there is a shell script, a batch
 * file and a Dockerfile, none of which require repropack to be installed.
 */
export async function writeExportArtifacts(root: string, bundle: Bundle): Promise<ExportResult> {
  const written: string[] = [];

  const dockerfile = join(root, "Dockerfile");
  await writeFile(dockerfile, generateDockerfile(bundle), "utf8");
  written.push("Dockerfile");

  const script = join(root, "replay.sh");
  await writeFile(script, generateReplayScript(bundle), { encoding: "utf8", mode: 0o755 });
  written.push("replay.sh");

  const batch = join(root, "replay.cmd");
  await writeFile(batch, generateReplayCmd(bundle), "utf8");
  written.push("replay.cmd");

  return { written };
}
