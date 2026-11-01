# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **A mistyped flag is reported even when `--help` is on the same line.** Every
  command answered `--help` before it looked at the rest of the line, so
  `repropack capture --bogus --help` printed the usage page and exited 0 -- an
  unrecognised option answered as if it had been read. The option table is now
  checked first; `capture --bogus --help` exits 2 with `error: unknown option
  '--bogus'` and the usual `hint:` line.
- **`--version` is a top-level request.** `repropack capture --version` printed
  the version and exited 0 without capturing anything. After a command it is now
  a usage error that says where the answer lives: `error: --version is not
  supported by 'capture'; it applies to 'repropack --version' on its own`.
- **Words after `--help` or `--version` are no longer ignored.** `repropack
  --version --bogus` printed the version and exited 0, and `help extra` was
  read as a request for help. Both exit 2 now, naming the stray word.
- **A dash-shaped first word is reported as an option, not as a command.**
  `repropack --bogus` answered `error: unknown command '--bogus'` plus the whole
  usage page, which sends the reader looking for a subcommand. It now says
  `error: unknown option '--bogus'` and keeps the `did you mean` hint.

## [0.1.10] - 2026-11-01

### Fixed

- **A flag that is short of its value is no longer called an unknown flag.**
  `repropack capture --out` answered `error: unknown option '--out'; did you
  mean '--out'?` -- it denied the flag existed and then suggested the flag the
  user had just typed. The parser now keeps the two failures apart: a known flag
  with nothing after it reports `--out needs a value`, and only a name that
  really is not in the table is reported as unknown.
- **The "did you mean" hint no longer charges every candidate for its dashes.**
  The distance was measured between the spelling from the command line
  (`--nope`) and candidate spellings that always carry their dashes
  (`--out`), so every candidate was charged the same two edits for the prefix
  and the ranking was effectively noise: `--nope` was answered with
  `did you mean '--scope'?`. Distances are now compared on the bare names, and a
  candidate equal to what the user wrote is never offered back.

### Quality

- 371 tests across 27 spec files, 4,856 lines of TypeScript.
- CI matrix: Ubuntu and Windows, Node 20 and 22.
- Zero runtime dependencies.

## [0.1.9] - 2026-11-01

### Added

- **The README is Chinese as well as English.** All twelve sections now carry a
  Chinese counterpart directly below the English original -- same commands, same
  transcripts, same caveats. 2,136 CJK characters, up from 22.

### Fixed

- **The 0.1.8 entries say what v0.1.7 actually guarded.** The "three guards the
  old test did not have" bullet claimed guards the previous release already had;
  `git show v0.1.7:package.json` has no `clean` script, so two of the three were
  new and one was not. Version headings had no link definitions, so `[0.1.7]` and
  `[0.1.8]` rendered as literal text, and `[Unreleased]` still compared against
  v0.1.6.

### Quality

- 369 tests across 27 spec files, 4,836 lines of TypeScript.
- CI matrix: Ubuntu and Windows, Node 20 and 22.
- Zero runtime dependencies.

## [0.1.8] - 2026-11-01

### Added

- **The release gates are executed, not spell-checked.** `tests/workflow.test.ts`
  used to assert that certain strings appeared in `release.yml` and `ci.yml`.
  That is a test of the YAML's spelling: a gate whose logic had been gutted
  still passed. Each guard's own shell body is now cut out of the workflow and
  run against throwaway fixtures -- the tag gate against matching, drifted,
  non-semver and prerelease tags; the package-contents assertion against a
  complete manifest, a stray `.js.map`, a tarball with no `dist/` at all, and a
  leaked `src/`. 21 cases, up from 6.
- **A version bump is no longer a test edit.** `tests/cli/main.spec.ts` pinned
  `--version` to a literal, so every release turned two unrelated cases red.
  It now compares against `TOOL_VERSION`, which `tests/version.spec.ts` already
  ties to `package.json` -- drift still fails CI, a bump does not.
- **Two guards the old test did not have.** The `repropack` bin is smoke tested
  from the installed package, and `npm run build` now clears `dist/` before
  compiling -- `clean` did not exist at v0.1.7, so a file tsc no longer emits
  survived an earlier build and `npm pack` shipped it. Until this release the
  build wrote into whatever `dist/` was already on disk.

## [0.1.7] - 2026-11-01

### Added

- **Unknown options are a usage error, with a suggestion.** A typo like `--ou`
  instead of `--out` used to be ignored, so the archive went to the default
  path while the caller believed they had chosen it. Every command now rejects
  an option outside its own flag table and offers the nearest name by edit
  distance.
- **`pack` runs the verify pass before it writes an archive.** A bundle whose
  manifest agrees with itself can still carry a stray `.env` next to the logs,
  and `pack` compressed that straight into the file people attach to an issue.
  Blockers now stop the pack; `--force` packs anyway and prints what it let
  through.
- **`replay` compares the recorded stderr after the exit codes agree.** Two
  different crashes that both exit 1 used to read as a faithful reproduction.
  A drifted first stderr line is now its own outcome, reported as drift rather
  than as success.

### Changed

- **Exit codes are named constants.** `EXIT_OK` / `EXIT_FINDINGS` /
  `EXIT_USAGE` / `EXIT_INTERNAL` replace the bare integers, so a script can
  tell "the bundle has findings" from "you called me wrong".
- **`--help` is generated from the flag tables.** An option that exists but is
  undocumented is no longer possible.

### Fixed

- **The repository root is redacted before it reaches `bundle.json`.** A
  bundle captured inside a home directory used to record that absolute path.
- **The command line is redacted in `capture`'s progress output.** It was
  already redacted in the bundle, but the terminal echoed it.

### Security

- `pack` is a new exit for a bundle that carries a blocker, so the last cheap
  gate before a bundle leaves the machine is now enforced by the tool.

## [0.1.6] - 2026-11-01

### Changed

- **The install note now names the project that owns the npm name.** `repropack` on npm belongs to [`saivarun1410/repropack`](https://github.com/saivarun1410/repropack), which solves a similar problem; the README used to call it "an unrelated package" without saying which, which is a claim a reader cannot check.
- Sample transcripts in the README show the version this release actually prints.

## [0.1.5] - 2026-11-01

### Changed

- **The release page now explains the release.** The workflow used to publish a body containing only a compare link, so the one page a prospective user lands on said nothing about what changed. The body is now the `CHANGELOG.md` section for the tag, and a tag with no written section fails the job instead of shipping an empty release.

## [0.1.4] - 2026-11-01

### Changed

- **README examples and the changelog stayed behind the version the tarball ships.** The released tarball bundles the README, so a stale `0.1.2` in a sample transcript was shipping to users. Every version string in it now matches the package.
- The install section documents the `repropack.tgz.sha256` checksum every release publishes, so a download can be verified before it is executed.

## [0.1.3] - 2026-11-01

### Changed

- **CI and the release job now assert the version the binary prints**, not just
  that it exited 0. A broken entry guard can make a CLI exit 0 having printed
  nothing, and the old step passed anyway. This package's entry point never had
  that bug, but the assertion is what would catch it if it appeared.

## [0.1.2] - 2026-11-01

### Changed

- **CI runs every Node version the package claims to support.** The matrix was
  Node 20 and 22; it is now 20, 22 and 24. The floor still matches `engines`,
  and 24 is the current active LTS.
- **CI now installs the packed tarball and runs the binary from it.** Tests
  prove the source compiles; this proves the thing users download works.
- GitHub Actions moved from `checkout@v4` / `setup-node@v4` to `v5`, which runs
  on Node 24 and clears the Node 20 deprecation warning on every job.
- The README install commands point at
  `releases/latest/download/NAME.tgz` instead of a version-pinned URL, so the
  documented command keeps working across releases. Each release now uploads a
  stable-named copy next to the versioned tarball.

## [0.1.1] - 2026-10-31

### Fixed

- **Install instructions that could not work.** The README told you to run
  `npm install -g github:kesheC/repropack`, which resolves to an SSH URL, and in
  the case of `repropack` also implied an npm registry package that does not exist.
  Both paths are gone. The documented install path is now the release tarball,
  which is built, smoke-tested and uploaded by CI on every tag.

### Added

- `.github/workflows/release.yml`: on a `v*` tag, build, test, `npm pack`, install
  the resulting tarball in a clean directory, run the packaged binary, then upload
  the tarball and its `.sha256` to the GitHub Release.
- `SECURITY.md` with a supported-versions table, a private reporting channel and an
  explicit in-scope / out-of-scope list.
- `prepack` script, so `npm pack` always ships a freshly built `dist/`.
- `author`, `bugs` and `homepage` fields in `package.json`.

### Changed

- `engines.node` is now `>=20.11` for every release artefact, matching the oldest
  Node version the test matrix exercises.
- The build hook moved from `prepare` to `prepack`. `prepare` ran on every
  consumer's machine during install — where `devDependencies` are absent — and npm
  11 warns loudly about unreviewed install scripts, so the documented install path
  printed a warning for no benefit. The tarball now ships a prebuilt `dist/`.

### Removed

- npm registry badges and `npm install -D repropack` snippets that pointed at an
  unrelated (or non-existent) registry package.

## [0.1.0] - 2026-10-29

### Added

- Initial release: Turn a failing command into a self-contained, secret-free repro bundle that anyone can replay with one command.

- `repropack capture` snapshots a failing run: command, exit code, cwd, environment fingerprint, package manager state, git state and the files needed to replay it.
- Capture scopes `changed` / `tracked` / `all`, include and exclude globs, plus byte budgets (`--max-file-bytes`, `--max-bundle-bytes`).
- Redaction engine that strips credentials from env values, URLs, headers and config files, with a per-bundle redaction report.
- `repropack replay` restores the bundle into a temporary workdir and re-runs the original command with `shell: false`.
- `repropack verify` audits a bundle before it is shared: secret leaks, integrity mismatches, missing files, oversize entries, absolute paths, home-directory leaks.
- `repropack inspect` prints a bundle summary; `repropack pack` / `unpack` move bundles as a single archive; `repropack report` renders the report.
- Path-closure resolution: files reachable from the failing stack trace are captured even when they are not in the changed set.
- Generated `Dockerfile` for replay on a machine that has nothing installed.

### Quality

- 324 tests across 25 spec files, 4396 lines of TypeScript.
- CI matrix: Ubuntu and Windows, Node 20 and 22.
- Zero runtime dependencies.

[Unreleased]: https://github.com/kesheC/repropack/compare/v0.1.10...HEAD
[0.1.10]: https://github.com/kesheC/repropack/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/kesheC/repropack/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/kesheC/repropack/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/kesheC/repropack/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/kesheC/repropack/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/kesheC/repropack/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/kesheC/repropack/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/kesheC/repropack/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/kesheC/repropack/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/kesheC/repropack/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/kesheC/repropack/releases/tag/v0.1.0