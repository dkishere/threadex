import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { openPostgresSessionConnection, postgresConnectionString, postgresSchemaFromStoreId } from "./sessionDb";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

for (const kind of ["transaction", "schema lock"] as const) {
  test(`a disconnected checked-out ${kind} rejects without crashing and the pool reconnects`, { timeout: 15_000 }, async () => {
    if (process.env.SESSION_PG_SCHEMA) throw new Error("Requires an isolated generated schema.");
    const schema = postgresSchemaFromStoreId(`/private/tmp/pg-disconnect-${randomUUID()}`);
    const connection = await openPostgresSessionConnection(undefined, schema);
    const killer = new pg.Client({ connectionString: postgresConnectionString() });
    const entered = deferred(), disconnected = deferred(), release = deferred();
    let backendPid = 0;
    const pool = (connection as unknown as { pool: pg.Pool }).pool;
    pool.once("acquire", client => {
      backendPid = (client as pg.PoolClient & { processID: number }).processID;
      client.once("end", disconnected.resolve);
    });
    try {
      const operation = async () => { entered.resolve(); await release.promise; };
      const pending = kind === "transaction" ? connection.withTransaction(operation) : connection.withSchemaLock(operation);
      const rejected = assert.rejects(pending, /terminat|not queryable|connection.*closed/i);
      await entered.promise;
      await killer.connect();
      const result = await killer.query("SELECT pg_terminate_backend($1) AS terminated", [backendPid]);
      assert.equal(result.rows[0].terminated, true);
      // The socket closes while the application is between SQL statements.
      await disconnected.promise;
      release.resolve();
      await rejected;
      assert.deepEqual(await (await connection.run("SELECT 42 AS value")).getRowObjectsJS(), [{ value: 42 }]);
    } finally {
      release.resolve();
      await killer.end();
      await connection.close();
    }
  });
}
