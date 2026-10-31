# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/kesheC/repropack/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/kesheC/repropack/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/kesheC/repropack/releases/tag/v0.1.0