# Changelog

## [0.1.0] - 2026-08-16

### Added

- `ScheduleRegistry` — zero-dependency persistent scheduler core (SQLite archive, lease-claim dispatch, wall-clock discipline).
- C-hybrid dispatch driver (nearest-deadline single timer + fallback poll) — EXP-2.
- Cold-start recovery split: lease release fast path + overdue flip unified into sweep — EXP-1.
- `time.ts` — RFC3339 / IANA / DST round-trip detection — EXP-5.
- `schedule-invariant.ts` — record-level validation adopting the upstream rule set.
- Test battery: unit 37 + clock-disorder fuzz (200 seeds / 7770 ops) + implementation×model diff (644 assertions).

### Fixed

- DST round-trip check compared against the intermediate quantity instead of the input — normal non-zero-offset times were misclassified as DST gaps (caught by the new normal-conversion unit tests; fix back-ported to the origin implementation).
