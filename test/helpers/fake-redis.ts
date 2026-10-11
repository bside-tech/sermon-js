/**
 * Minimal in-memory Redis: just the commands the Redis store sends, with real semantics
 * (score ranges with exclusive bounds, NX, millisecond expiry). Lets the store be tested
 * without a server.
 */
export function fakeRedis() {
  const data = new Map<string, unknown>();
  const expiry = new Map<string, number>();

  const alive = (key: string) => {
    const at = expiry.get(key);
    if (at !== undefined && at <= Date.now()) {
      data.delete(key);
      expiry.delete(key);
    }
    return data.has(key);
  };
  const zset = (key: string) => {
    if (!data.has(key)) data.set(key, new Map<string, number>());
    return data.get(key) as Map<string, number>;
  };
  const hash = (key: string) => {
    if (!data.has(key)) data.set(key, new Map<string, string>());
    return data.get(key) as Map<string, string>;
  };
  const bound = (raw: string) => {
    const exclusive = raw.startsWith("(");
    const text = exclusive ? raw.slice(1) : raw;
    const value = text === "-inf" ? -Infinity : text === "+inf" ? Infinity : Number(text);
    return { value, exclusive };
  };
  const inRange = (score: number, min: string, max: string) => {
    const lo = bound(min);
    const hi = bound(max);
    return (lo.exclusive ? score > lo.value : score >= lo.value) && (hi.exclusive ? score < hi.value : score <= hi.value);
  };

  function command(args: string[]): unknown {
    const [name, key = "", ...rest] = args;
    switch (name?.toUpperCase()) {
      case "ZADD":
        zset(key).set(rest[1]!, Number(rest[0]));
        return 1;
      case "ZRANGEBYSCORE":
        if (!data.has(key)) return [];
        return [...zset(key)]
          .filter(([, score]) => inRange(score, rest[0]!, rest[1]!))
          .sort((a, b) => a[1] - b[1])
          .map(([member]) => member);
      case "ZREMRANGEBYSCORE": {
        if (!data.has(key)) return 0;
        const set = zset(key);
        let removed = 0;
        for (const [member, score] of [...set]) {
          if (inRange(score, rest[0]!, rest[1]!)) {
            set.delete(member);
            removed += 1;
          }
        }
        if (set.size === 0) data.delete(key);
        return removed;
      }
      case "HSET":
        for (let i = 0; i + 1 < rest.length; i += 2) hash(key).set(rest[i]!, rest[i + 1]!);
        return rest.length / 2;
      case "HGETALL":
        return data.has(key) ? [...hash(key)].flat() : [];
      case "HKEYS":
        return data.has(key) ? [...hash(key).keys()] : [];
      case "HDEL":
        if (!data.has(key)) return 0;
        return rest.filter((field) => hash(key).delete(field)).length;
      case "DEL":
        return [key, ...rest].filter((k) => {
          expiry.delete(k);
          return data.delete(k);
        }).length;
      case "SET": {
        const flags = rest.slice(1).map((flag) => flag.toUpperCase());
        if (flags.includes("NX") && alive(key)) return null;
        data.set(key, rest[0]!);
        const px = flags.indexOf("PX");
        if (px >= 0) expiry.set(key, Date.now() + Number(rest[px + 2]));
        else expiry.delete(key);
        return "OK";
      }
      case "GET":
        return alive(key) ? data.get(key) : null;
      case "PTTL": {
        if (!alive(key)) return -2;
        const at = expiry.get(key);
        return at === undefined ? -1 : at - Date.now();
      }
      default:
        throw new Error(`fakeRedis: unsupported command ${name}`);
    }
  }

  return {
    command,
    /** Every command received, for assertions */
    keys: () => [...data.keys()].filter(alive),
  };
}
