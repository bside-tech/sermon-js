import type { CheckSample, LockResult, RunSummary, StatusStore } from "../store";
import type { CheckResult } from "../types";

export type SqlDialect = "postgres" | "mysql" | "sqlite";

/**
 * Runs one statement and resolves with its rows (an empty array for writes). Placeholders
 * are `$1, $2…` for postgres and `?` for mysql and sqlite, matching each driver's own style.
 */
export type SqlQuery = (sql: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>;

export type SqlStoreOptions = {
  query: SqlQuery;
  dialect: SqlDialect;
  /** Prefix of the four tables (default "sermon_") */
  tablePrefix?: string;
  /** Create the tables on first use (default true). Turn off to run `migrate()` yourself. */
  autoMigrate?: boolean;
};

export type SqlStore = StatusStore & {
  /** Create the tables and indexes if they don't exist. Safe to call repeatedly. */
  migrate(): Promise<void>;
  /** The statements `migrate()` runs, for migration tools */
  readonly schema: string[];
};

function schemaFor(dialect: SqlDialect, t: Record<"latest" | "runs" | "samples" | "kv", string>): string[] {
  const text = dialect === "mysql" ? "MEDIUMTEXT" : "TEXT";
  const key = "VARCHAR(255)";
  if (dialect === "mysql") {
    // MySQL has no CREATE INDEX IF NOT EXISTS: indexes are declared with the tables
    return [
      `CREATE TABLE IF NOT EXISTS ${t.latest} (service_key ${key} NOT NULL PRIMARY KEY, data ${text} NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS ${t.runs} (id ${key} NOT NULL PRIMARY KEY, at_ms BIGINT NOT NULL, data ${text} NOT NULL, INDEX ${t.runs}_at (at_ms))`,
      `CREATE TABLE IF NOT EXISTS ${t.samples} (service_key ${key} NOT NULL, at_ms BIGINT NOT NULL, data ${text} NOT NULL, PRIMARY KEY (service_key, at_ms), INDEX ${t.samples}_at (at_ms))`,
      `CREATE TABLE IF NOT EXISTS ${t.kv} (k ${key} NOT NULL PRIMARY KEY, v ${text} NOT NULL, expires_at BIGINT NOT NULL)`,
    ];
  }
  return [
    `CREATE TABLE IF NOT EXISTS ${t.latest} (service_key ${key} NOT NULL PRIMARY KEY, data ${text} NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${t.runs} (id ${key} NOT NULL PRIMARY KEY, at_ms BIGINT NOT NULL, data ${text} NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS ${t.runs}_at ON ${t.runs} (at_ms)`,
    `CREATE TABLE IF NOT EXISTS ${t.samples} (service_key ${key} NOT NULL, at_ms BIGINT NOT NULL, data ${text} NOT NULL, PRIMARY KEY (service_key, at_ms))`,
    `CREATE INDEX IF NOT EXISTS ${t.samples}_at ON ${t.samples} (at_ms)`,
    `CREATE TABLE IF NOT EXISTS ${t.kv} (k ${key} NOT NULL PRIMARY KEY, v ${text} NOT NULL, expires_at BIGINT NOT NULL)`,
  ];
}

function parse<T>(value: unknown): T | undefined {
  if (typeof value !== "string") return value && typeof value === "object" ? (value as T) : undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

/**
 * Store on any SQL database, with the driver you already use. You provide a `query` function;
 * the store only needs four small tables, which it creates on first use.
 *
 * ```ts
 * // PostgreSQL (pg)
 * sqlStore({ dialect: "postgres", query: async (sql, params) => (await pool.query(sql, params)).rows });
 * // MySQL / MariaDB (mysql2)
 * sqlStore({ dialect: "mysql", query: async (sql, params) => { const [rows] = await pool.query(sql, params); return Array.isArray(rows) ? rows : []; } });
 * // SQLite (better-sqlite3)
 * sqlStore({ dialect: "sqlite", query: async (sql, params) => { const s = db.prepare(sql); return s.reader ? s.all(...params) : (s.run(...params), []); } });
 * ```
 */
export function sqlStore({ query, dialect, tablePrefix = "sermon_", autoMigrate = true }: SqlStoreOptions): SqlStore {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tablePrefix)) {
    throw new Error("sermon-js: sqlStore tablePrefix may only contain letters, digits and underscores");
  }
  const t = {
    latest: `${tablePrefix}latest`,
    runs: `${tablePrefix}runs`,
    samples: `${tablePrefix}samples`,
    kv: `${tablePrefix}kv`,
  };
  const schema = schemaFor(dialect, t);

  /** Write statements with `?` and convert to `$n` for postgres */
  const run = (sql: string, params: unknown[] = []) => {
    let index = 0;
    return query(dialect === "postgres" ? sql.replace(/\?/g, () => `$${++index}`) : sql, params);
  };
  const upsert = (table: string, columns: string[], conflict: string[]) => {
    const updates = columns.filter((column) => !conflict.includes(column));
    const insert = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
    return dialect === "mysql"
      ? `${insert} ON DUPLICATE KEY UPDATE ${updates.map((column) => `${column} = VALUES(${column})`).join(", ")}`
      : `${insert} ON CONFLICT (${conflict.join(", ")}) DO UPDATE SET ${updates.map((column) => `${column} = excluded.${column}`).join(", ")}`;
  };
  const placeholders = (count: number) => Array.from({ length: count }, () => "?").join(", ");

  let migrated: Promise<void> | undefined;
  const migrate = async () => {
    for (const statement of schema) await query(statement, []);
  };
  const ready = () => {
    if (!autoMigrate) return Promise.resolve();
    migrated ??= migrate().catch((error) => {
      // Let the next call try again
      migrated = undefined;
      throw error;
    });
    return migrated;
  };

  let sequence = 0;
  const runId = (at: number) => `${at}-${(sequence++).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  return {
    schema,
    migrate,

    async saveRun({ summary, results, samples }) {
      await ready();
      for (const result of results) {
        await run(upsert(t.latest, ["service_key", "data"], ["service_key"]), [result.key, JSON.stringify(result)]);
      }
      for (const sample of samples) {
        await run(upsert(t.samples, ["service_key", "at_ms", "data"], ["service_key", "at_ms"]), [
          sample.key,
          sample.at,
          JSON.stringify(sample),
        ]);
      }
      await run(`INSERT INTO ${t.runs} (id, at_ms, data) VALUES (?, ?, ?)`, [
        runId(summary.at),
        summary.at,
        JSON.stringify(summary),
      ]);
    },

    async latest() {
      await ready();
      const rows = await run(`SELECT service_key, data FROM ${t.latest}`);
      const latest: Record<string, CheckResult> = {};
      for (const row of rows) {
        const result = parse<CheckResult>(row.data);
        if (result) latest[String(row.service_key)] = result;
      }
      return latest;
    },

    async runs({ since, until }) {
      await ready();
      const rows = await run(`SELECT data FROM ${t.runs} WHERE at_ms >= ? AND at_ms <= ? ORDER BY at_ms ASC`, [since, until]);
      return rows.map((row) => parse<RunSummary>(row.data)).filter((item): item is RunSummary => !!item);
    },

    async samples(key, { since, until }) {
      await ready();
      const rows = await run(
        `SELECT data FROM ${t.samples} WHERE service_key = ? AND at_ms >= ? AND at_ms <= ? ORDER BY at_ms ASC`,
        [key, since, until]
      );
      return rows.map((row) => parse<CheckSample>(row.data)).filter((item): item is CheckSample => !!item);
    },

    async prune({ before, keepKeys }) {
      await ready();
      await run(`DELETE FROM ${t.runs} WHERE at_ms < ?`, [before]);
      await run(`DELETE FROM ${t.samples} WHERE at_ms < ?`, [before]);
      if (!keepKeys) return;
      if (keepKeys.length === 0) {
        await run(`DELETE FROM ${t.latest}`);
        await run(`DELETE FROM ${t.samples}`);
        return;
      }
      await run(`DELETE FROM ${t.latest} WHERE service_key NOT IN (${placeholders(keepKeys.length)})`, keepKeys);
      await run(`DELETE FROM ${t.samples} WHERE service_key NOT IN (${placeholders(keepKeys.length)})`, keepKeys);
    },

    async lock(name, ttlMs): Promise<LockResult> {
      await ready();
      const key = `lock:${name}`;
      const now = Date.now();
      await run(`DELETE FROM ${t.kv} WHERE k = ? AND expires_at <= ?`, [key, now]);
      try {
        // The primary key makes this atomic: only one caller can insert the row
        await run(`INSERT INTO ${t.kv} (k, v, expires_at) VALUES (?, ?, ?)`, [key, "1", now + Math.max(1, Math.round(ttlMs))]);
        return { ok: true };
      } catch (error) {
        const rows = await run(`SELECT expires_at FROM ${t.kv} WHERE k = ?`, [key]);
        const expiresAt = Number(rows[0]?.expires_at);
        // No row means the insert failed for another reason than "already locked"
        if (!rows.length || !Number.isFinite(expiresAt)) throw error;
        return { ok: false, retryAfterMs: Math.max(1, expiresAt - Date.now()) };
      }
    },

    async unlock(name) {
      await ready();
      await run(`DELETE FROM ${t.kv} WHERE k = ?`, [`lock:${name}`]);
    },

    cache: {
      async get(key) {
        await ready();
        const rows = await run(`SELECT v FROM ${t.kv} WHERE k = ? AND expires_at > ?`, [`cache:${key}`, Date.now()]);
        const value = rows[0]?.v;
        return value === undefined || value === null ? null : String(value);
      },
      async set(key, value, ttlMs) {
        await ready();
        await run(upsert(t.kv, ["k", "v", "expires_at"], ["k"]), [
          `cache:${key}`,
          value,
          Date.now() + Math.max(1, Math.round(ttlMs)),
        ]);
      },
    },
  };
}
