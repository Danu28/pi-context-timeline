# Changelog

All notable changes to pi-context-timeline.

## [1.0.2] - 2026-10-12
### Fixed
- `session_shutdown`: clear status before nulling context (status leak)
- `Esc` in timeline: clears filter first when filtered, otherwise closes (was dead code)
- Package `files` now includes `index.ts` shim for `pi --extension ./` compat
- Remove dead `safeJoinCwd` helper
- `index.ts` shim: avoid duplicate default re-export

### Added
- Minimal CI (typecheck + pi extension smoke)
- CHANGELOG.md

## [1.0.1] - 2026-10-12
### Fixed
- ESM-safe export (dynamic import, no require)
- Sanitize export filenames, prevent traversal, async write
- Fix token/compaction double-counting
- Deduplicate package (single pi.extensions, pack 68k->37k)
- README deduplication, filter completeness, status polish

## [1.0.0] - 2026-10-12
- Initial public release: interactive context timeline (/ctx)
