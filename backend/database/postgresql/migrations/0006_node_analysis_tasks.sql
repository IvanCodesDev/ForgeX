BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS forgex.node_analysis_tasks (
    id varchar(64) PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_]+$'),
    tenant_id varchar(35) NOT NULL CHECK (tenant_id = 'tn_local' OR tenant_id ~ '^tn_[a-f0-9]{32}$'),
    owner_id varchar(35) NOT NULL CHECK (owner_id = 'ow_local' OR owner_id ~ '^ow_[a-f0-9]{32}$'),
    question varchar(500) NOT NULL,
    datasource_id varchar(128) NOT NULL,
    engine varchar(64) NOT NULL CHECK (length(engine) > 0),
    provider varchar(64) NOT NULL CHECK (length(provider) > 0),
    credential_scope varchar(128) NOT NULL,
    status varchar(16) NOT NULL CHECK (status IN ('running', 'done', 'failed')),
    progress double precision NOT NULL CHECK (progress >= 0 AND progress <= 1),
    phase varchar(64) NOT NULL,
    message text NOT NULL DEFAULT '',
    report_json jsonb,
    error_message text,
    upstream_task_id varchar(128),
    events_json jsonb NOT NULL CHECK (jsonb_typeof(events_json) = 'array'),
    created_at_utc timestamptz NOT NULL,
    finished_at_utc timestamptz,
    expires_at_utc timestamptz NOT NULL CHECK (expires_at_utc > created_at_utc),
    updated_at_utc timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_node_tasks_tenant_owner_created
    ON forgex.node_analysis_tasks (tenant_id, owner_id, created_at_utc DESC, id);

CREATE INDEX IF NOT EXISTS ix_node_tasks_expiry
    ON forgex.node_analysis_tasks (tenant_id, owner_id, expires_at_utc);

ALTER TABLE forgex.node_analysis_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY node_analysis_tasks_tenant_owner_policy ON forgex.node_analysis_tasks
    USING (
        tenant_id = current_setting('app.tenant_id', true)
        AND owner_id = current_setting('app.owner_id', true)
    )
    WITH CHECK (
        tenant_id = current_setting('app.tenant_id', true)
        AND owner_id = current_setting('app.owner_id', true)
    );

INSERT INTO forgex.schema_migrations (version, name)
VALUES (6, 'node_analysis_tasks')
ON CONFLICT (version) DO NOTHING;

COMMIT;
