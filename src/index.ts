/**
 * Public library API.
 *
 * The CLI is a thin shell over these functions; anything the CLI can do, an
 * embedding application can do too. Keeping the surface small is the point:
 * five verbs, plain data in, plain data out, no globals.
 */

export { capture, type CaptureInput, type CaptureResult } from "./capture/index.js";
export { replay, materialize } from "./replay/index.js";
export { verifyBundle, type VerifyOptions } from "./verify/index.js";
export { readBundle, readBundleFile, type LoadedBundle } from "./bundle/read.js";
export { writeBundle, type StagedFile, type WriteBundleInput, type WriteBundleResult } from "./bundle/write.js";
export { computeIntegrity, checkIntegrity, parseManifest, isUnsafeRelativePath } from "./bundle/manifest.js";
export { main } from "./cli/main.js";
export { formatBundle, formatVerify, sortFindings, shellish } from "./cli/format.js";
export { parseArgs, flagString, flagBool, flagNumber, flagList, type ParsedArgs, type FlagSpec } from "./cli/args.js";
export {
  packBundle,
  unpackBundle,
  ARCHIVE_SUFFIX,
  MAX_ARCHIVE_BYTES,
  type PackOptions,
  type PackResult,
  type UnpackOptions,
  type UnpackResult,
} from "./archive/index.js";
export { readTar, writeTar, gzipTar, TarError, type TarEntry } from "./archive/tar.js";
export { buildReport, reportTitle, type Report, type ReportOptions } from "./report/index.js";
export { scanWorktree, type ScanEntry, type ScanOptions, type ScanResult } from "./capture/scan.js";
export { probeEnvironment, probePackageManager, captureEnv, DEFAULT_ENV_ALLOWLIST } from "./capture/env.js";
export { probeRepository, stripCredentials } from "./capture/git.js";
export {
  redactText,
  mergeReports,
  firedRules,
  findResidualSecrets,
  collectEnvLiterals,
  REDACTION_RULES,
  RULES_VERSION,
  type RedactionResult,
  type RedactSurfaceOptions,
} from "./redact/index.js";
export { parseStackFrames, isRuntimePath, stripFileUrl, type StackFrameRef } from "./util/stack.js";
export { TOOL_VERSION } from "./version.js";
export type * from "./types.js";