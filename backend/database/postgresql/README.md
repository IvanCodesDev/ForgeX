# ForgeX PostgreSQL migration contract

The SQL in `migrations/` is a forward-only, transactional schema contract for the durable G-code
job repository. Stage 3-E keeps `Persistence:Provider=file` as the executable default while the
runtime PostgreSQL driver and an isolated PostgreSQL test service are introduced separately.

Before deployment, validate the pinned migration bytes:

```bash
npm run postgres:migrations:check
```

The command checks `manifest.json`, SHA-256, sequential versions, transactional boundaries,
tenant/owner isolation fields, idempotency uniqueness, event persistence, RLS policies, and rejects
destructive `DROP` or `TRUNCATE` statements.

## Runtime-role boundary

- The HTTP runtime role must not own the tables and must not have `BYPASSRLS`.
- Each transaction sets `SET LOCAL app.tenant_id = '<opaque tn_ id>'` and
  `SET LOCAL app.owner_id = '<opaque ow_ id>'` before accessing jobs or events.
- A background worker that scans all tenants uses a separately managed worker role. That role is
  not used by HTTP endpoints and its credential is not exposed to Node or React.
- Migration credentials are separate from both runtime roles.

## Apply in a provisioned environment

```bash
psql "$FORGEX_MIGRATION_DATABASE_URL" \
  --set=ON_ERROR_STOP=1 \
  --file backend/database/postgresql/migrations/0001_gcode_jobs.sql
```

Validate the installed version:

```bash
psql "$FORGEX_MIGRATION_DATABASE_URL" --set=ON_ERROR_STOP=1 \
  --command="SELECT version, name FROM forgex.schema_migrations ORDER BY version;"
```

## Backup and restore drill

Create a PostgreSQL custom-format backup:

```bash
pg_dump "$FORGEX_DATABASE_URL" \
  --format=custom \
  --schema=forgex \
  --file=forgex-postgresql.backup
```

Restore into a newly created drill database, never over the active database:

```bash
createdb "$FORGEX_RESTORE_DATABASE_NAME"
pg_restore --exit-on-error --clean --if-exists \
  --dbname="$FORGEX_RESTORE_DATABASE_URL" \
  forgex-postgresql.backup
psql "$FORGEX_RESTORE_DATABASE_URL" --set=ON_ERROR_STOP=1 \
  --command="SELECT count(*) AS jobs FROM forgex.gcode_analysis_jobs;" \
  --command="SELECT count(*) AS events FROM forgex.gcode_job_events;"
```

Record the backup SHA-256, source schema version, restored row counts, command exit statuses, and
the time at which the drill database is deleted. Application rollback switches the repository
provider back to `file`; applied expand migrations remain in place during the rollback window.
