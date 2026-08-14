BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS forgex.calibration_submissions (
    tenant_id varchar(35) NOT NULL CHECK (tenant_id = 'tn_local' OR tenant_id ~ '^tn_[a-f0-9]{32}$'),
    owner_id varchar(35) NOT NULL CHECK (owner_id = 'ow_local' OR owner_id ~ '^ow_[a-f0-9]{32}$'),
    key varchar(256) NOT NULL,
    bundle_id varchar(128) NOT NULL CHECK (length(bundle_id) BETWEEN 1 AND 128),
    revision integer NOT NULL CHECK (revision > 0),
    status varchar(16) NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
    digest char(64) NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
    bundle_json jsonb NOT NULL CHECK (jsonb_typeof(bundle_json) = 'object'),
    created_at_utc timestamptz NOT NULL,
    updated_at_utc timestamptz NOT NULL,
    submitted_by varchar(128) NOT NULL CHECK (length(submitted_by) > 0),
    note varchar(500) NOT NULL DEFAULT '',
    reviewed_by varchar(128),
    review_reason varchar(500),
    events_json jsonb NOT NULL CHECK (jsonb_typeof(events_json) = 'array'),
    PRIMARY KEY (tenant_id, owner_id, key),
    UNIQUE (tenant_id, owner_id, bundle_id, revision)
);

CREATE INDEX IF NOT EXISTS ix_calibration_submissions_status_created
    ON forgex.calibration_submissions (tenant_id, owner_id, status, created_at_utc DESC);

CREATE TABLE IF NOT EXISTS forgex.calibration_releases (
    tenant_id varchar(35) NOT NULL CHECK (tenant_id = 'tn_local' OR tenant_id ~ '^tn_[a-f0-9]{32}$'),
    owner_id varchar(35) NOT NULL CHECK (owner_id = 'ow_local' OR owner_id ~ '^ow_[a-f0-9]{32}$'),
    bundle_id varchar(128) NOT NULL CHECK (length(bundle_id) BETWEEN 1 AND 128),
    revision integer NOT NULL CHECK (revision > 0),
    digest char(64) NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
    bundle_json jsonb NOT NULL CHECK (jsonb_typeof(bundle_json) = 'object'),
    approved_at_utc timestamptz NOT NULL,
    approved_by varchar(128) NOT NULL CHECK (length(approved_by) > 0),
    PRIMARY KEY (tenant_id, bundle_id)
);

ALTER TABLE forgex.calibration_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE forgex.calibration_releases ENABLE ROW LEVEL SECURITY;

CREATE POLICY calibration_submissions_tenant_owner_policy ON forgex.calibration_submissions
    USING (
        tenant_id = current_setting('app.tenant_id', true)
        AND owner_id = current_setting('app.owner_id', true)
    )
    WITH CHECK (
        tenant_id = current_setting('app.tenant_id', true)
        AND owner_id = current_setting('app.owner_id', true)
    );

CREATE POLICY calibration_releases_tenant_policy ON forgex.calibration_releases
    USING (tenant_id = current_setting('app.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

INSERT INTO forgex.schema_migrations (version, name)
VALUES (2, 'calibration_governance')
ON CONFLICT (version) DO NOTHING;

COMMIT;
