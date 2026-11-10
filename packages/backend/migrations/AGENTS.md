# AGENTS.md: database migrations

Plain SQL files applied in numeric order by `src/migrate.ts` at backend startup.
Read `packages/backend/AGENTS.md` for the rest of the backend.

## Rules

- **Never edit, rename or delete a migration that has been applied or
  committed.** The SHA-256 checksum of each applied file is stored in
  `schema_migrations`; if a file changes or goes missing, startup stops with a
  diagnostic. To change the schema, add a new migration.
- **Add the next number**: `NNNN_name.sql`, four digits, then letters, digits,
  `_` or `-`, ending in `.sql` (the loader's pattern is
  `/^(\d+)_([A-Za-z0-9_-]+)\.sql$/`). Look at the highest existing number and
  use the one after it.
- **No down migrations.** There is no rollback.
- Each migration runs in its own transaction (`BEGIN IMMEDIATE`). Do not put
  `BEGIN` or `COMMIT` in the file.
- Only `.sql` files are read from this folder; this file and any other file are
  ignored by the loader.

## Writing one

- Start with a comment saying what the migration is for and which design
  document it comes from, as the existing ones do.
- Migrations must work on **existing databases** with data in them, not only on
  a fresh one. Give new `NOT NULL` columns a `DEFAULT`; backfill when needed.
- SQLite cannot change a `CHECK` constraint or drop most column constraints:
  rebuild the table. `0030_workspace_index.sql` is the model: it saves the
  dependent vectors first, rebuilds `chunks`, rebuilds the full-text index and
  its triggers, and restores the vectors. Keep ids stable when rebuilding.
- **Versioned records** (`entries`, `agents`, `skills`, `schemas`, `data`) have
  a current table and a `*_versions` table; keep both consistent.
- **Built-in records** (the Dispatcher agent, built-in schemas and skills) are
  inserted by migrations with `builtin = 1` and live in a scope of their own so
  a user's record can share a name. Changing a built-in's text means a new
  migration that updates it, never an edit to the old one.
- Changes SQL cannot make, such as rewriting the JSON inside `messages.message`,
  belong in a data step (`src/data-steps.ts`), which runs once after the
  migrations and is recorded in `data_steps`. `0031_branches.sql` adds columns and
  its data step `branches-backfill` fills them for existing messages.
- Foreign keys are on (`foreign_keys=ON`) and the database uses WAL; the
  `sqlite-vec` extension is loaded before migrations run.

## Testing

`src/migrate.test.ts` covers the runner; `tempDatabase()` in
`src/test-helpers.ts` applies every migration in this folder to a fresh
encrypted database, so most backend tests already exercise yours. If a
migration moves or rebuilds data, add a test that builds the earlier schema
state, applies the migration and checks the result.

`repairMigration(version)` stores a new checksum for an intentional change that
the database already matches. It is for repairing a database, not a way to edit
history; do not use it to justify changing a committed file.
