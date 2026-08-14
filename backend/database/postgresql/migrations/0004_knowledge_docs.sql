BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS forgex.knowledge_docs (
    id varchar(19) PRIMARY KEY CHECK (id ~ '^kb_[a-f0-9]{16}$'),
    tenant_id varchar(35) NOT NULL CHECK (tenant_id = 'tn_local' OR tenant_id ~ '^tn_[a-f0-9]{32}$'),
    owner_id varchar(35) NOT NULL CHECK (owner_id = 'ow_local' OR owner_id ~ '^ow_[a-f0-9]{32}$'),
    name varchar(80) NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    text text NOT NULL CHECK (length(text) BETWEEN 1 AND 524288),
    created_at_utc timestamptz NOT NULL,
    expires_at_utc timestamptz,
    CHECK (expires_at_utc IS NULL OR expires_at_utc >= created_at_utc)
);

CREATE INDEX IF NOT EXISTS ix_knowledge_docs_tenant_owner_created
    ON forgex.knowledge_docs (tenant_id, owner_id, created_at_utc ASC, id ASC);

CREATE INDEX IF NOT EXISTS ix_knowledge_docs_expiry
    ON forgex.knowledge_docs (tenant_id, owner_id, expires_at_utc)
    WHERE expires_at_utc IS NOT NULL;

ALTER TABLE forgex.knowledge_docs ENABLE ROW LEVEL SECURITY;

CREATE POLICY knowledge_docs_tenant_owner_policy ON forgex.knowledge_docs
    USING (
        tenant_id = current_setting('app.tenant_id', true)
        AND owner_id = current_setting('app.owner_id', true)
    )
    WITH CHECK (
        tenant_id = current_setting('app.tenant_id', true)
        AND owner_id = current_setting('app.owner_id', true)
    );

INSERT INTO forgex.schema_migrations (version, name)
VALUES (4, 'knowledge_docs')
ON CONFLICT (version) DO NOTHING;

COMMIT;
