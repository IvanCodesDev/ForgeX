BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS forgex.shares (
    token char(18) PRIMARY KEY CHECK (token ~ '^[a-f0-9]{18}$'),
    tenant_id varchar(35) NOT NULL CHECK (tenant_id = 'tn_local' OR tenant_id ~ '^tn_[a-f0-9]{32}$'),
    owner_id varchar(35) NOT NULL CHECK (owner_id = 'ow_local' OR owner_id ~ '^ow_[a-f0-9]{32}$'),
    revoke_hash char(64) NOT NULL CHECK (revoke_hash ~ '^[a-f0-9]{64}$'),
    report_json jsonb NOT NULL CHECK (jsonb_typeof(report_json) = 'object'),
    question varchar(500) NOT NULL,
    engine varchar(64) NOT NULL CHECK (length(engine) > 0),
    upstream_task_id varchar(128),
    created_at_utc timestamptz NOT NULL,
    expires_at_utc timestamptz NOT NULL CHECK (expires_at_utc > created_at_utc),
    access_count bigint NOT NULL DEFAULT 0 CHECK (access_count >= 0),
    last_accessed_at_utc timestamptz
);

CREATE INDEX IF NOT EXISTS ix_shares_tenant_owner_created
    ON forgex.shares (tenant_id, owner_id, created_at_utc ASC, token ASC);

CREATE INDEX IF NOT EXISTS ix_shares_expiry
    ON forgex.shares (tenant_id, owner_id, expires_at_utc);

ALTER TABLE forgex.shares ENABLE ROW LEVEL SECURITY;

CREATE POLICY shares_public_read_policy ON forgex.shares
    FOR SELECT
    USING (
        current_setting('app.share_public', true) = '1'
        OR (
            tenant_id = current_setting('app.tenant_id', true)
            AND owner_id = current_setting('app.owner_id', true)
        )
    );

CREATE POLICY shares_owner_write_policy ON forgex.shares
    FOR ALL
    USING (
        tenant_id = current_setting('app.tenant_id', true)
        AND owner_id = current_setting('app.owner_id', true)
    )
    WITH CHECK (
        tenant_id = current_setting('app.tenant_id', true)
        AND owner_id = current_setting('app.owner_id', true)
    );

INSERT INTO forgex.schema_migrations (version, name)
VALUES (5, 'shares')
ON CONFLICT (version) DO NOTHING;

COMMIT;
