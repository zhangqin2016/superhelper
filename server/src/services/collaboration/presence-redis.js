import { createHash } from "node:crypto";
import { ONLINE_TTL_MS } from "./online-presence.js";

const TIME = "local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000); ";
const LEASE = TIME + "redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now); redis.call('ZADD',KEYS[1],now+tonumber(ARGV[2]),ARGV[1]); redis.call('PEXPIRE',KEYS[1],ARGV[2]); return now+tonumber(ARGV[2])";
const READ = TIME + `redis.call('SET',KEYS[1],now,'NX'); local warming=now-tonumber(redis.call('GET',KEYS[1]))<75000;
local out={}; for i=2,#KEYS do local key=KEYS[i];
  redis.call('ZREMRANGEBYSCORE',key,'-inf',now)
  if redis.call('ZCARD',key)>512 then out[i-1]=-1 else
    local allowed=cjson.decode(ARGV[i-1]); local rows=redis.call('ZRANGE',key,0,-1,'WITHSCORES'); local expiry=0
    for j=1,#rows,2 do local identity=cjson.decode(rows[j]); if identity[3] and allowed[identity[3]]==identity[1] then expiry=math.max(expiry,tonumber(rows[j+1])) end end
    if expiry==0 and warming then out[i-1]=-1 else out[i-1]=expiry end
  end
end; return out`;
const LIMIT = "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],10000) end; return n";
const digest = value => createHash("sha256").update(String(value)).digest("hex");
const unknown = userId => ({ userId, presence: "unknown", onlineUntil: null });

/** A burst always emits its final invalidation; continuous traffic emits at most once per interval. */
export function createPresenceHintCoalescer({ emit, intervalMs = 1000, schedule = setTimeout, cancel = clearTimeout }) {
  let timer = null;
  let stopped = false;
  return {
    notify() {
      if (stopped || timer !== null) return;
      timer = schedule(() => {
        timer = null;
        if (stopped) return;
        try { Promise.resolve(emit()).catch(() => {}); } catch { /* advisory only */ }
      }, intervalMs);
      timer?.unref?.();
    },
    stop() { stopped = true; if (timer !== null) cancel(timer); timer = null; },
  };
}

async function bounded(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("PRESENCE_TIMEOUT")), ms); })]); }
  finally { clearTimeout(timer); }
}

/** Redis holds disposable leases only. The caller supplies PostgreSQL-authorized devices. */
export function createRedisPresence({ client, namespace = "lily:collaboration", commandTimeoutMs = 1500, onHint = () => {} } = {}) {
  if (!/^[a-zA-Z0-9:_-]{1,100}$/.test(namespace)) throw new Error("COLLAB_PRESENCE_NAMESPACE_INVALID");
  const prefix = namespace;
  const connections = new Map();
  const localLimits = new Map();
  let stopped = false;
  const channel = `${prefix}:presence-changed`;
  const key = userId => `${prefix}:presence:${digest(userId)}`;
  const command = async (script, keys, args) => {
    if (stopped || !client?.isReady) throw new Error("PRESENCE_UNAVAILABLE");
    return bounded(client.eval(script, { keys, arguments: args }), commandTimeoutMs);
  };
  const hints = createPresenceHintCoalescer({ emit: () => {
    try { onHint(); } catch { /* advisory only */ }
    if (client?.isReady && typeof client.publish === "function") bounded(client.publish(channel, "changed"), commandTimeoutMs).catch(() => {});
  } });
  const store = {
    channel,
    async connect(id, identity) { if (stopped) return; connections.set(id, { ...identity, expiresAt: Date.now() + ONLINE_TTL_MS }); await store.touch(id); hints.notify(); },
    async touch(id) {
      const entry = connections.get(id); if (!entry || stopped) return;
      entry.expiresAt = Date.now() + ONLINE_TTL_MS;
      if (!entry.sessionId) return; // Legacy tickets transport normally but cannot prove session-bound online.
      try { await command(LEASE, [key(entry.userId)], [JSON.stringify([entry.deviceId, id, entry.sessionId]), String(ONLINE_TTL_MS)]); } catch { /* reads report unknown */ }
    },
    async disconnect(id) {
      const entry = connections.get(id); connections.delete(id); if (!entry) return;
      try { await command("return redis.call('ZREM',KEYS[1],ARGV[1])", [key(entry.userId)], [JSON.stringify([entry.deviceId, id, entry.sessionId])]); } catch { /* TTL removes a lost disconnect */ }
      hints.notify();
    },
    expiredIds() { return [...connections].filter(([, entry]) => entry.expiresAt <= Date.now()).map(([id]) => id); },
    async readBatch(entries) {
      const result = [];
      for (let offset = 0; offset < entries.length; offset += 200) {
        const batch = entries.slice(offset, offset + 200);
        try {
          const values = await command(READ, [`${prefix}:presence-epoch`, ...batch.map(entry => key(entry.userId))], batch.map(entry => JSON.stringify(Object.fromEntries(entry.activeSessions || []))));
          if (!Array.isArray(values) || values.length !== batch.length) throw new Error("PRESENCE_INVALID");
          result.push(...batch.map((entry, i) => Number(values[i]) < 0 ? unknown(entry.userId) : { userId: entry.userId, presence: Number(values[i]) > 0 ? "online" : "offline", onlineUntil: Number(values[i]) > 0 ? new Date(Number(values[i])).toISOString() : null }));
        } catch { result.push(...entries.slice(offset).map(entry => unknown(entry.userId))); break; }
      }
      return result;
    },
    async allowQuery(userId) {
      try { return Number(await command(LIMIT, [`${prefix}:presence-limit:${digest(userId)}`], [])) <= 30; }
      catch {
        const now = Date.now();
        for (const [id, value] of localLimits) if (value.until <= now) localLimits.delete(id);
        let entry = localLimits.get(userId);
        if (!entry) { if (localLimits.size >= 10000) return false; entry = { until: now + 10000, count: 0 }; localLimits.set(userId, entry); }
        return ++entry.count <= 10;
      }
    },
    async clear() { hints.stop(); const ids = [...connections.keys()]; await Promise.all(ids.map(id => store.disconnect(id))); stopped = true; connections.clear(); localLimits.clear(); },
  };
  return store;
}

export async function createPresenceRedisLifecycle({ url, namespace, onHint = () => {}, log, createClient } = {}) {
  let client;
  let subscriber;
  try {
  const factory = createClient || (await import("redis")).createClient;
  client = factory({ url, disableOfflineQueue: true, commandsQueueMaxLength: 512, socket: { connectTimeout: 1500, reconnectStrategy: retries => Math.min(1000 + retries * 250, 5000) } });
  subscriber = client.duplicate();
  // Never log Redis error objects: they may contain the credential-bearing URL.
  let lastWarning = 0;
  let degraded = false;
  const warning = () => { degraded = true; if (Date.now() - lastWarning > 30000) { lastWarning = Date.now(); log?.warn?.("collaboration presence dependency unavailable; status unknown"); } };
  const recovered = () => { if (degraded && client.isReady && subscriber.isReady) { degraded = false; log?.info?.("collaboration presence dependency recovered; leases renewing"); } };
  client.on("error", warning); subscriber.on("error", warning);
  client.on("ready", recovered); subscriber.on("ready", recovered);
  const store = createRedisPresence({ client, namespace, onHint });
  const connecting = Promise.all([client.connect(), subscriber.connect().then(() => subscriber.subscribe(store.channel, message => { if (message === "changed") { try { onHint(); } catch { /* advisory only */ } } }))]);
  try { await bounded(connecting, 1800); } catch { warning(); }
  return { store, health: () => ({ configured: true, ready: Boolean(client.isReady), subscriberReady: Boolean(subscriber.isReady) }), async stop() { await store.clear(); for (const connection of [subscriber, client]) { try { connection.destroy(); } catch { /* already closed */ } } } };
  } catch {
    for (const connection of [subscriber, client]) { try { connection?.destroy(); } catch { /* initialization incomplete */ } }
    log?.warn?.("collaboration presence configuration unavailable; status unknown");
    // No client means this namespace can never reach Redis or assert local offline.
    const store = createRedisPresence({ client: null, namespace: "unavailable" });
    return { store, health: () => ({ configured: true, ready: false, subscriberReady: false }), stop: () => store.clear() };
  }
}
