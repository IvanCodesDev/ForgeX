BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS forgex.datasources (
    id varchar(32) PRIMARY KEY CHECK (id ~ '^ds_[a-f0-9]{24}$'),
    tenant_id varchar(35) NOT NULL CHECK (tenant_id = 'tn_local' OR tenant_id ~ '^tn_[a-f0-9]{32}$'),
    owner_id varchar(35) NOT NULL CHECK (owner_id = 'ow_local' OR owner_id ~ '^ow_[a-f0-9]{32}$'),
    name varchar(80) NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    csv text NOT NULL CHECK (length(csv) > 0),
    rows_json jsonb NOT NULL CHECK (jsonb_typeof(rows_json) = 'array'),
    content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
    cache_key char(64) NOT NULL CHECK (cache_key ~ '^[a-f0-9]{64}$'),
    warnings_json jsonb NOT NULL CHECK (jsonb_typeof(warnings_json) = 'array'),
    provenance_json jsonb NOT NULL CHECK (jsonb_typeof(provenance_json) = 'object'),
    created_at_utc timestamptz NOT NULL,
    expires_at_utc timestamptz,
    CHECK (expires_at_utc IS NULL OR expires_at_utc >= created_at_utc)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_datasources_tenant_owner_cache
    ON forgex.datasources (tenant_id, owner_id, cache_key);

CREATE INDEX IF NOT EXISTS ix_datasources_expiry
    ON forgex.datasources (tenant_id, owner_id, expires_at_utc)
    WHERE expires_at_utc IS NOT NULL;

ALTER TABLE forgex.datasources ENABLE ROW LEVEL SECURITY;

CREATE POLICY datasources_tenant_owner_policy ON forgex.datasources
    USING (
        tenant_id = current_setting('app.tenant_id', true)
        AND owner_id = current_setting('app.owner_id', true)
    )
    WITH CHECK (
        tenant_id = current_setting('app.tenant_id', true)
        AND owner_id = current_setting('app.owner_id', true)
    );

INSERT INTO forgex.schema_migrations (version, name)
VALUES (3, 'datasources')
ON CONFLICT (version) DO NOTHING;

COMMIT;
