// Loaded with `--import` by `npm test`. Every test store gets a fresh hash-derived
// PostgreSQL schema; left behind, tens of thousands of them starved autovacuum of
// the live public tables. Drop this process's schemas once its tests finish.
import pg from "pg";
import { generatedSchemasOpened, postgresConnectionString } from "./sessionDb";

let cleaned = false;

process.once("beforeExit", async () => {
  if (cleaned || generatedSchemasOpened.size === 0) return;
  cleaned = true;
  const client = new pg.Client({ connectionString: postgresConnectionString() });
  try {
    await client.connect();
    for (const schema of generatedSchemasOpened) {
      if (!/^sm_[a-f0-9]{24}$/.test(schema)) continue;
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch((error: Error) =>
        console.warn(`Failed to drop test schema ${schema}: ${error.message}`));
    }
  } catch (error) {
    console.warn(`Test schema cleanup skipped: ${(error as Error).message}`);
  } finally {
    await client.end().catch(() => undefined);
  }
});
