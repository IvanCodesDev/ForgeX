"use strict";

const { Pool } = require("pg");

function createPool(cfg) {
  if (!cfg || !cfg.postgresUrl) throw new Error("POSTGRES_URL is required for PostgreSQL persistence");
  return cfg.postgresPool || new Pool({
    connectionString: cfg.postgresUrl,
    max: cfg.postgresPoolMax || 10,
    ssl: cfg.postgresSsl ? { rejectUnauthorized: false } : undefined,
    application_name: "forgex-node",
  });
}

async function withTransaction(pool, tenantId, ownerId, work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.owner_id', $2, true)", [
      tenantId,
      ownerId,
    ]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      error.rollbackError = rollbackError;
    }
    throw error;
  } finally {
    client.release();
  }
}

async function withPublicTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.share_public', '1', true)");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      error.rollbackError = rollbackError;
    }
    throw error;
  } finally {
    client.release();
  }
}

async function closePool(pool, owned) {
  if (owned && pool) await pool.end();
}

module.exports = { createPool, withTransaction, withPublicTransaction, closePool };
