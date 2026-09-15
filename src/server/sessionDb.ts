import { createHash } from "node:crypto";
import pg from "pg";

const { Pool, types } = pg;

types.setTypeParser(20, (value) => Number(value));

const defaultLocalPostgresUrl = "postgres://threadex:threadex@127.0.0.1:55432/threadex";

export type SessionDbValue =
  | string
  | number
  | boolean
  | Date
  | Buffer
  | null
  | undefined
  | unknown[]
  | Record<string, unknown>;

export type SessionDbResult = {
  rowCount: number;
  getRowObjectsJS(): Promise<Record<string, unknown>[]>;
};

export type SessionDbConnection = {
  readonly backend: "postgres";
  run(sql: string, params?: Record<string, SessionDbValue>): Promise<SessionDbResult>;
  checkpoint(): Promise<void>;
  close(): Promise<void>;
  startDuckDbUi(assetUrl: string, uiPort: number): Promise<void>;
  stopDuckDbUi(): Promise<void>;
  tryLoadVss(): Promise<boolean>;
};

class RowResult implements SessionDbResult {
  constructor(
    private readonly rows: Record<string, unknown>[],
    readonly rowCount = rows.length
  ) {}

  async getRowObjectsJS() {
    return this.rows;
  }
}

export function postgresConnectionString(): string {
  return process.env.SESSION_DATABASE_URL ?? process.env.DATABASE_URL ?? defaultLocalPostgresUrl;
}

export function postgresSchemaFromStoreId(storeId?: string | null): string | null {
  const explicit = process.env.SESSION_PG_SCHEMA?.trim();
  if (explicit) {
    return explicit;
  }

  const normalized = storeId?.trim();
  if (
    !normalized ||
    normalized === "default" ||
    normalized === "data/threadex.duckdb" ||
    normalized.endsWith("/data/threadex.duckdb")
  ) {
    return null;
  }

  return `sm_${createHash("sha1").update(normalized).digest("hex").slice(0, 24)}`;
}

export async function openPostgresSessionConnection(
  connectionString = postgresConnectionString(),
  schema = postgresSchemaFromStoreId()
): Promise<SessionDbConnection> {
  const pool = new Pool({ connectionString });
  const connection = new PostgresSessionConnection(pool, schema);
  await connection.installCompatibilityFunctions();
  return connection;
}

class PostgresSessionConnection implements SessionDbConnection {
  readonly backend = "postgres" as const;

  constructor(
    private readonly pool: pg.Pool,
    private readonly schema: string | null
  ) {}

  async installCompatibilityFunctions() {
    if (this.schema) {
      await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(this.schema)}`);
    }

    await this.withClient(async (client) => {
      await client.query(`
        CREATE OR REPLACE FUNCTION contains(haystack text, needle text)
        RETURNS boolean
        LANGUAGE sql
        IMMUTABLE
        RETURNS NULL ON NULL INPUT
        AS $$ SELECT position(needle in haystack) > 0 $$;
      `);
      await client.query(`
        CREATE OR REPLACE FUNCTION json_extract_string(doc json, path text)
        RETURNS text
        LANGUAGE sql
        IMMUTABLE
        RETURNS NULL ON NULL INPUT
        AS $$ SELECT doc #>> string_to_array(regexp_replace(path, '^\\$\\.?', ''), '.') $$;
      `);
      await client.query(`
        CREATE OR REPLACE FUNCTION json_extract(doc json, path text)
        RETURNS text
        LANGUAGE sql
        IMMUTABLE
        RETURNS NULL ON NULL INPUT
        AS $$ SELECT doc #>> string_to_array(regexp_replace(path, '^\\$\\.?', ''), '.') $$;
      `);
      await client.query(`
        CREATE OR REPLACE FUNCTION encode(input text)
        RETURNS bytea
        LANGUAGE sql
        IMMUTABLE
        RETURNS NULL ON NULL INPUT
        AS $$ SELECT convert_to(input, 'UTF8') $$;
      `);
    });
  }

  async run(sql: string, params?: Record<string, SessionDbValue>) {
    const normalized = normalizePostgresSql(sql);
    if (normalized.noop) {
      return new RowResult([]);
    }
    const translated = translateNamedParams(normalized.sql, params ?? {});
    return this.withClient(async (client) => {
      const result = await client.query(translated.sql, translated.values);
      return new RowResult(result.rows as Record<string, unknown>[], result.rowCount ?? 0);
    });
  }

  async checkpoint() {
    return;
  }

  async close() {
    await this.pool.end();
  }

  async startDuckDbUi() {
    console.warn("DuckDB admin UI is unavailable because Threadex now uses PostgreSQL.");
  }

  async stopDuckDbUi() {
    return;
  }

  async tryLoadVss() {
    return false;
  }

  private async withClient<T>(operation: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      if (this.schema) {
        await client.query(`SET search_path TO ${quoteIdentifier(this.schema)}`);
      }
      return await operation(client);
    } finally {
      client.release();
    }
  }
}

function normalizePostgresSql(sql: string): { sql: string; noop: boolean } {
  const trimmed = sql.trim();
  const normalized = trimmed.replace(/\s+/g, " ").toUpperCase();
  if (
    normalized === "CHECKPOINT" ||
    normalized === "INSTALL FTS" ||
    normalized === "LOAD FTS" ||
    normalized === "INSTALL VSS" ||
    normalized === "LOAD VSS" ||
    normalized.startsWith("PRAGMA CREATE_FTS_INDEX(")
  ) {
    return { sql: "", noop: true };
  }
  return {
    sql: sql
      .replace(/\[([0-9eE+\-.,\s]+)\]::DOUBLE\[\]/g, "ARRAY[$1]::DOUBLE PRECISION[]")
      .replace(/\bDOUBLE\[\]/g, "DOUBLE PRECISION[]")
      .replace(/\bDOUBLE\b(?!\s+PRECISION)/g, "DOUBLE PRECISION"),
    noop: false
  };
}

function translateNamedParams(sql: string, params: Record<string, SessionDbValue>) {
  const values: SessionDbValue[] = [];
  let output = "";
  let quote: "'" | "\"" | "`" | null = null;
  let dollarQuote: string | null = null;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];

    if (dollarQuote) {
      if (sql.startsWith(dollarQuote, index)) {
        output += dollarQuote;
        index += dollarQuote.length - 1;
        dollarQuote = null;
      } else {
        output += char;
      }
      continue;
    }

    if (quote) {
      output += char;
      if (char === quote) {
        if (next === quote) {
          output += next;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      output += char;
      continue;
    }

    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", index + 2);
      if (end === -1) {
        output += sql.slice(index);
        break;
      }
      output += sql.slice(index, end + 1);
      index = end;
      continue;
    }

    if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      if (end === -1) {
        output += sql.slice(index);
        break;
      }
      output += sql.slice(index, end + 2);
      index = end + 1;
      continue;
    }

    if (char === "$") {
      const dollarMatch = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$/);
      if (dollarMatch) {
        dollarQuote = dollarMatch[0];
        output += dollarQuote;
        index += dollarQuote.length - 1;
        continue;
      }

      const nameMatch = sql.slice(index + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
      if (nameMatch) {
        const name = nameMatch[0];
        values.push(params[name]);
        output += `$${values.length}`;
        if (/^\s+IS\s+(?:NOT\s+)?NULL\b/i.test(sql.slice(index + 1 + name.length))) {
          output += "::text";
        }
        index += name.length;
        continue;
      }
    }

    output += char;
  }

  return { sql: output, values };
}

function quoteIdentifier(value: string) {
  return `"${value.replace(/"/g, "\"\"")}"`;
}
