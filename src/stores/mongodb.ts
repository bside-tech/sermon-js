import type { CheckSample, LockResult, RunSummary, StatusStore } from "../store";
import type { CheckResult } from "../types";

// Structural types for the few driver methods used, so the `mongodb` package isn't required
// to build against (any 5.x / 6.x `Db` fits).
type Doc = Record<string, unknown>;
type MongoCursor = { sort(spec: Record<string, 1 | -1>): MongoCursor; toArray(): Promise<Doc[]> };
/* eslint-disable @typescript-eslint/no-explicit-any -- the driver's own generics are stricter than we need */
type MongoCollection = {
  find(filter: any): MongoCursor;
  findOne(filter: any): Promise<Doc | null>;
  insertOne(doc: any): Promise<unknown>;
  insertMany(docs: any[]): Promise<unknown>;
  updateOne(filter: any, update: any, options?: any): Promise<unknown>;
  bulkWrite(operations: any[]): Promise<unknown>;
  deleteOne(filter: any): Promise<unknown>;
  deleteMany(filter: any): Promise<unknown>;
  createIndex(spec: any, options?: any): Promise<unknown>;
};
/* eslint-enable @typescript-eslint/no-explicit-any */
export type MongoDbLike = { collection(name: string): MongoCollection };

export type MongoStoreOptions = {
  /** A `Db` from a connected MongoClient: `client.db("status")` */
  db: MongoDbLike;
  /** Prefix of the four collections (default "sermon_") */
  collectionPrefix?: string;
};

const DUPLICATE_KEY = 11000;

/**
 * Store on MongoDB, with the client you already have:
 *
 * ```ts
 * mongoStore({ db: client.db("status") })
 * ```
 *
 * It uses four small collections and creates their indexes on first use.
 */
export function mongoStore({ db, collectionPrefix = "sermon_" }: MongoStoreOptions): StatusStore {
  const latest = db.collection(`${collectionPrefix}latest`);
  const runs = db.collection(`${collectionPrefix}runs`);
  const samples = db.collection(`${collectionPrefix}samples`);
  const kv = db.collection(`${collectionPrefix}kv`);

  let indexed: Promise<unknown> | undefined;
  const ready = () => {
    indexed ??= Promise.all([
      runs.createIndex({ at: 1 }),
      samples.createIndex({ key: 1, at: 1 }),
      samples.createIndex({ at: 1 }),
    ]).catch((error) => {
      indexed = undefined;
      throw error;
    });
    return indexed;
  };

  /** Stored documents carry Mongo's own `_id`: give back exactly what was saved */
  const strip = <T>(doc: Doc): T => {
    const { _id, ...rest } = doc;
    void _id;
    return rest as T;
  };

  return {
    async saveRun({ summary, results, samples: newSamples }) {
      await ready();
      if (results.length) {
        await latest.bulkWrite(
          results.map((result) => ({
            replaceOne: { filter: { _id: result.key }, replacement: { ...result }, upsert: true },
          }))
        );
      }
      if (newSamples.length) await samples.insertMany(newSamples.map((sample) => ({ ...sample })));
      await runs.insertOne({ ...summary });
    },

    async latest() {
      await ready();
      const docs = await latest.find({}).toArray();
      return Object.fromEntries(docs.map((doc) => [String(doc._id), strip<CheckResult>(doc)]));
    },

    async runs({ since, until }) {
      await ready();
      const docs = await runs.find({ at: { $gte: since, $lte: until } }).sort({ at: 1 }).toArray();
      return docs.map((doc) => strip<RunSummary>(doc));
    },

    async samples(key, { since, until }) {
      await ready();
      const docs = await samples.find({ key, at: { $gte: since, $lte: until } }).sort({ at: 1 }).toArray();
      return docs.map((doc) => strip<CheckSample>(doc));
    },

    async prune({ before, keepKeys }) {
      await ready();
      await Promise.all([runs.deleteMany({ at: { $lt: before } }), samples.deleteMany({ at: { $lt: before } })]);
      if (keepKeys) {
        await Promise.all([
          latest.deleteMany({ _id: { $nin: keepKeys } }),
          samples.deleteMany({ key: { $nin: keepKeys } }),
        ]);
      }
    },

    async lock(name, ttlMs): Promise<LockResult> {
      const id = `lock:${name}`;
      const now = Date.now();
      const expiresAt = now + Math.max(1, Math.round(ttlMs));
      try {
        // Takes the lock if it is free or expired. If a live lock exists the filter doesn't
        // match, the upsert tries to insert the same _id, and the duplicate key tells us so.
        await kv.updateOne({ _id: id, expiresAt: { $lte: now } }, { $set: { expiresAt } }, { upsert: true });
        return { ok: true };
      } catch (error) {
        if ((error as { code?: number }).code !== DUPLICATE_KEY) throw error;
        const held = await kv.findOne({ _id: id });
        const until = Number(held?.expiresAt);
        return { ok: false, retryAfterMs: Number.isFinite(until) ? Math.max(1, until - Date.now()) : ttlMs };
      }
    },

    async unlock(name) {
      await kv.deleteOne({ _id: `lock:${name}` });
    },

    cache: {
      async get(key) {
        const doc = await kv.findOne({ _id: `cache:${key}`, expiresAt: { $gt: Date.now() } });
        return typeof doc?.value === "string" ? doc.value : null;
      },
      async set(key, value, ttlMs) {
        await kv.updateOne(
          { _id: `cache:${key}` },
          { $set: { value, expiresAt: Date.now() + Math.max(1, Math.round(ttlMs)) } },
          { upsert: true }
        );
      },
    },
  };
}
