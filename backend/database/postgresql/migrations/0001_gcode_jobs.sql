BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE SCHEMA IF NOT EXISTS forgex;

CREATE TABLE IF NOT EXISTS forgex.schema_migrations (
    version integer PRIMARY KEY CHECK (version > 0),
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
    applied_at_utc timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS forgex.gcode_analysis_jobs (
    id char(32) PRIMARY KEY CHECK (id ~ '^[a-f0-9]{32}$'),
    tenant_id varchar(35) NOT NULL CHECK (tenant_id = 'tn_local' OR tenant_id ~ '^tn_[a-f0-9]{32}$'),
    owner_id varchar(35) NOT NULL CHECK (owner_id = 'ow_local' OR owner_id ~ '^ow_[a-f0-9]{32}$'),
    idempotency_key varchar(128),
    fingerprint char(64) NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
    input_sha256 char(64) NOT NULL CHECK (input_sha256 ~ '^[a-f0-9]{64}$'),
    input_bytes bigint NOT NULL CHECK (input_bytes >= 0),
    options_json jsonb NOT NULL CHECK (jsonb_typeof(options_json) = 'object'),
    status varchar(16) NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'degraded', 'failed', 'cancelled')),
    progress double precision NOT NULL CHECK (progress >= 0 AND progress <= 1),
    phase varchar(32) NOT NULL CHECK (length(phase) > 0),
    created_at_utc timestamptz NOT NULL,
    started_at_utc timestamptz,
    finished_at_utc timestamptz,
    engine_version varchar(64),
    result_json jsonb,
    error_code varchar(64),
    error_message text,
    trace_id varchar(128),
    row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
    updated_at_utc timestamptz NOT NULL DEFAULT now(),
    CHECK (started_at_utc IS NULL OR started_at_utc >= created_at_utc),
    CHECK (finished_at_utc IS NULL OR finished_at_utc >= created_at_utc)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_gcode_jobs_tenant_owner_idempotency
    ON forgex.gcode_analysis_jobs (tenant_id, owner_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_gcode_jobs_status_created
    ON forgex.gcode_analysis_jobs (status, created_at_utc, id);

CREATE INDEX IF NOT EXISTS ix_gcode_jobs_tenant_owner_created
    ON forgex.gcode_analysis_jobs (tenant_id, owner_id, created_at_utc DESC, id);

CREATE TABLE IF NOT EXISTS forgex.gcode_job_events (
    job_id char(32) NOT NULL REFERENCES forgex.gcode_analysis_jobs(id) ON DELETE CASCADE,
    sequence bigint NOT NULL CHECK (sequence > 0),
    event_type varchar(16) NOT NULL CHECK (event_type IN ('progress', 'heartbeat', 'terminal')),
    at_utc timestamptz NOT NULL,
    status varchar(16) NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'degraded', 'failed', 'cancelled')),
    progress double precision NOT NULL CHECK (progress >= 0 AND progress <= 1),
    phase varchar(32) NOT NULL CHECK (length(phase) > 0),
    error_code varchar(64),
    PRIMARY KEY (job_id, sequence)
);

CREATE INDEX IF NOT EXISTS ix_gcode_job_events_job_sequence
    ON forgex.gcode_job_events (job_id, sequence);

ALTER TABLE forgex.gcode_analysis_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE forgex.gcode_job_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY gcode_jobs_tenant_owner_policy ON forgex.gcode_analysis_jobs
    USING (
        tenant_id = current_setting('app.tenant_id', true)
        AND owner_id = current_setting('app.owner_id', true)
    )
    WITH CHECK (
        tenant_id = current_setting('app.tenant_id', true)
        AND owner_id = current_setting('app.owner_id', true)
    );

CREATE POLICY gcode_job_events_tenant_owner_policy ON forgex.gcode_job_events
    USING (
        EXISTS (
            SELECT 1
            FROM forgex.gcode_analysis_jobs AS job
            WHERE job.id = gcode_job_events.job_id
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1
            FROM forgex.gcode_analysis_jobs AS job
            WHERE job.id = gcode_job_events.job_id
        )
    );

INSERT INTO forgex.schema_migrations (version, name)
VALUES (1, 'gcode_jobs')
ON CONFLICT (version) DO NOTHING;

COMMIT;
