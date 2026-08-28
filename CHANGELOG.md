# Changelog

## 0.1.0

- Extracted the Pi lifecycle, warden, skills, dispatch, session, model-context,
  and Python runner runtime into a publishable package.
- Added the versioned `ProjectAdapterV1` integration boundary and Gaia parity
  fixture.
- Added declaration-producing builds, package exports, CI, and consumer
  tarball smoke coverage.
- Declared Pi as an exact peer contract so consumers share the host runtime,
  and replaced project-owned runtime marker names with package-neutral names.
- Preserved immutable Gaia source provenance without hashing evolving package
  sources.
