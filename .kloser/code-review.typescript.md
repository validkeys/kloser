# TypeScript Review Guidelines

- Enforce strict typing: flag `any`, unchecked casts, and non-null assertions (`!`).
- Flag missing error handling around I/O, and unawaited or unhandled promises.
- Prefer early returns; flag deeply nested branches.
- Flag leaked resources and missing cleanup (subscriptions, timers, file handles).
