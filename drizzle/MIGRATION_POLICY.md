# Database migration policy

This project supports two explicit upgrade paths; they must not be mixed blindly.

1. **Tracked database.** A database whose Drizzle journal is current receives each numbered SQL migration exactly once, in order. Take a D1 backup/export first, test the same chain against a copy, then deploy application code that is compatible with both the old and new additive schema.
2. **Runtime-bootstrap database.** Older Sites deployments may have been created by `db/runtime.ts` without a Drizzle journal. Do not replay the historic SQL chain against such a database: SQLite `ALTER TABLE ... ADD COLUMN` is intentionally not rerunnable. Upgrade it through the idempotent runtime bootstrap (`CREATE ... IF NOT EXISTS`, `PRAGMA table_info`, conditional column additions and repair-before-index steps), verify it, then record a reviewed baseline before adopting a migration runner.

The runtime bootstrap is a rolling-release compatibility bridge, not a replacement for the numbered migration history. Future destructive changes require a shadow table/copy migration, row-count and constraint verification, and a tested rollback/export. Never drop or rename live columns in the same release that stops reading them.
