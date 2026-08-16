# Security Policy

## Supported versions

Latest tag only. Early public preview — breaking changes may occur.

## Reporting a vulnerability

Private reporting only: https://github.com/Wang-Lin-Chang/schedule-core/security/advisories/new

Include: affected version, reproduction steps, impact.

## Scope

Reportable when an attacker can:

- Dispatch the same schedule twice concurrently (lease protocol violation)
- Trigger a dispatch earlier than its scheduled anchor (clock discipline violation)
- Corrupt the schedule archive without the event log recording it

## Out of scope

- at-least-once duplicate dispatch across crash windows (documented design contract)
- Host-injected executor side effects (out of this package's trust boundary)
