import Database from "better-sqlite3";
import { MongoClient } from "mongodb";
import mysql from "mysql2/promise";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { mongoStore } from "../src/stores/mongodb";
import { sqlStore, type SqlQuery } from "../src/stores/sql";
import { runStoreConformance } from "../src/testing";

const harness = { describe, it, expect };
const unique = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}_`;

function sqliteQuery(db: Database.Database): SqlQuery {
  return async (sql, params) => {
    const statement = db.prepare(sql);
    if (statement.reader) return statement.all(...params) as Array<Record<string, unknown>>;
    statement.run(...params);
    return [];
  };
}

runStoreConformance("sqlStore (SQLite)", () => sqlStore({ dialect: "sqlite", query: sqliteQuery(new Database(":memory:")) }), harness);

describe("sqlStore", () => {
  it("creates its tables once, on first use", async () => {
    const statements: string[] = [];
    const db = new Database(":memory:");
    const query: SqlQuery = (sql, params) => {
      statements.push(sql);
      return sqliteQuery(db)(sql, params);
    };
    const store = sqlStore({ dialect: "sqlite", query, tablePrefix: "status_" });
    expect(statements).toHaveLength(0);
    await store.latest();
    await store.latest();
    expect(statements.filter((sql) => sql.startsWith("CREATE")).length).toBe(store.schema.length);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>;
    expect(tables.map((table) => table.name)).toEqual(["status_kv", "status_latest", "status_runs", "status_samples"]);
  });

  it("leaves migrations to you when autoMigrate is off", async () => {
    const db = new Database(":memory:");
    const store = sqlStore({ dialect: "sqlite", query: sqliteQuery(db), autoMigrate: false });
    await expect(store.latest()).rejects.toThrow(/no such table/);
    await store.migrate();
    await store.migrate();
    expect(await store.latest()).toEqual({});
  });

  it("retries the migration after a failure", async () => {
    const db = new Database(":memory:");
    let fail = true;
    const store = sqlStore({
      dialect: "sqlite",
      query: async (sql, params) => {
        if (fail && sql.startsWith("CREATE")) throw new Error("database is locked");
        return sqliteQuery(db)(sql, params);
      },
    });
    await expect(store.latest()).rejects.toThrow("database is locked");
    fail = false;
    expect(await store.latest()).toEqual({});
  });

  it("writes each dialect's placeholders and upserts", async () => {
    const seen: Record<string, string[]> = { postgres: [], mysql: [] };
    for (const dialect of ["postgres", "mysql"] as const) {
      const store = sqlStore({
        dialect,
        autoMigrate: false,
        query: async (sql) => {
          seen[dialect]!.push(sql);
          return [];
        },
      });
      await store.saveRun({
        summary: { at: 1, trigger: "manual", full: true, score: 100, label: "operational", failing: {} },
        results: [{ key: "api", status: "up", checkedAt: 1, probed: true }],
        samples: [{ key: "api", at: 1, status: "up" }],
      });
    }
    expect(seen.postgres![0]).toBe(
      "INSERT INTO sermon_latest (service_key, data) VALUES ($1, $2) ON CONFLICT (service_key) DO UPDATE SET data = excluded.data"
    );
    expect(seen.postgres![1]).toContain("VALUES ($1, $2, $3) ON CONFLICT (service_key, at_ms)");
    expect(seen.mysql![0]).toBe(
      "INSERT INTO sermon_latest (service_key, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)"
    );
    expect(sqlStore({ dialect: "mysql", query: async () => [] }).schema.join("\n")).toContain("MEDIUMTEXT");
    expect(sqlStore({ dialect: "postgres", query: async () => [] }).schema.join("\n")).toContain("CREATE INDEX IF NOT EXISTS");
  });

  it("rejects unsafe table prefixes", () => {
    expect(() => sqlStore({ dialect: "sqlite", query: async () => [], tablePrefix: "x; DROP TABLE users;--" })).toThrow(/tablePrefix/);
  });

  it("only reports a lock as held when it really is", async () => {
    const store = sqlStore({
      dialect: "sqlite",
      autoMigrate: false,
      query: async (sql) => {
        if (sql.startsWith("INSERT")) throw new Error("disk full");
        return [];
      },
    });
    await expect(store.lock!("x", 1000)).rejects.toThrow("disk full");
  });
});

// Real servers, when available:
//   SERMON_TEST_POSTGRES_URL, SERMON_TEST_MYSQL_URL, SERMON_TEST_MONGODB_URL
if (process.env.SERMON_TEST_POSTGRES_URL) {
  const pool = new pg.Pool({ connectionString: process.env.SERMON_TEST_POSTGRES_URL });
  const prefixes: string[] = [];
  runStoreConformance("sqlStore (real PostgreSQL)", () => {
    const tablePrefix = unique();
    prefixes.push(tablePrefix);
    return sqlStore({ dialect: "postgres", tablePrefix, query: async (sql, params) => (await pool.query(sql, params)).rows });
  }, harness);
  afterAll(async () => {
    for (const prefix of prefixes) {
      for (const table of ["latest", "runs", "samples", "kv"]) await pool.query(`DROP TABLE IF EXISTS ${prefix}${table}`);
    }
    await pool.end();
  });
}

if (process.env.SERMON_TEST_MYSQL_URL) {
  const pool = mysql.createPool(process.env.SERMON_TEST_MYSQL_URL);
  const prefixes: string[] = [];
  runStoreConformance("sqlStore (real MySQL)", () => {
    const tablePrefix = unique();
    prefixes.push(tablePrefix);
    return sqlStore({
      dialect: "mysql",
      tablePrefix,
      query: async (sql, params) => {
        const [rows] = await pool.query(sql, params);
        return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
      },
    });
  }, harness);
  afterAll(async () => {
    for (const prefix of prefixes) {
      for (const table of ["latest", "runs", "samples", "kv"]) await pool.query(`DROP TABLE IF EXISTS ${prefix}${table}`);
    }
    await pool.end();
  });
}

if (process.env.SERMON_TEST_MONGODB_URL) {
  const client = new MongoClient(process.env.SERMON_TEST_MONGODB_URL);
  const db = client.db("sermon_test");
  runStoreConformance("mongoStore (real MongoDB)", () => mongoStore({ db, collectionPrefix: unique() }), harness);
  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });
}
