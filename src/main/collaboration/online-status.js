"use strict";

const CACHE_MS = 15_000, MAX_LEASE_MS = 75_000, HINT_MS = 5_000;
function presenceRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "userIds")
    || !Array.isArray(value.userIds) || value.userIds.length > 200 || new Set(value.userIds).size !== value.userIds.length
    || value.userIds.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(id))) return null;
  return { userIds: [...value.userIds] };
}
/** Advisory account-local state; no store, durable queue, or server clock comparisons. */
function createOnlineStatus({ query, getAccountId, onChange = () => {}, now = Date.now,
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  let account = getAccountId(), epoch = 0, stopped = false, pending = null;
  let targets = [], timer = null, hintTimer = null;
  const entries = new Map();
  const sources = new Map();
  const cancel = () => { if (timer != null) clearTimeoutFn(timer); timer = null; if (hintTimer != null) clearTimeoutFn(hintTimer); hintTimer = null; };
  const changed = () => { try { onChange(); } catch { /* observers cannot break reads */ } };
  const clear = () => { const hadEntries = entries.size > 0; epoch++; entries.clear(); cancel(); if (hadEntries && !stopped) changed(); schedule(); };
  const ensure = () => { if (account !== getAccountId()) { account = getAccountId(); targets = []; sources.clear(); clear(); } };
  const snapshot = (ids = targets) => {
    ensure(); const at = now();
    return { ok: true, observedAt: new Date(at).toISOString(), states: ids.map(userId => {
      const entry = entries.get(userId);
      const fresh = entry && entry.expiresAt > at;
      return { userId, presence: fresh ? entry.presence : "unknown", onlineUntil: fresh && entry.presence === "online" ? new Date(entry.expiresAt).toISOString() : null };
    }) };
  };
  const schedule = () => {
    if (timer != null) clearTimeoutFn(timer); timer = null;
    if (stopped || !targets.length) return;
    const at = now(); let delay = CACHE_MS;
    for (const id of targets) { const entry = entries.get(id); if (entry?.expiresAt > at) delay = Math.min(delay, entry.expiresAt - at); }
    timer = setTimeoutFn(() => { timer = null; changed(); void refresh(); schedule(); }, Math.max(1, delay)); timer?.unref?.();
  };
  const refresh = () => {
    ensure();
    if (stopped || !targets.length || typeof query !== "function") return Promise.resolve(snapshot());
    if (pending) return pending;
    const generation = epoch, owner = account, ids = [...targets];
    const current = () => !stopped && generation === epoch && owner === getAccountId();
    const task = Promise.resolve().then(async () => {
      const updated = new Map();
      for (let offset = 0; offset < ids.length; offset += 200) {
        if (!current()) return;
        const batch = ids.slice(offset, offset + 200), requestedAt = now();
        const value = await query(batch);
        if (!current()) return;
        if (value?.ok !== true || !Array.isArray(value.states) || value.states.length !== batch.length || !Number.isFinite(Date.parse(value.observedAt))) throw new Error("Invalid presence response");
        const rows = new Map(value.states.map(row => [row?.userId, row]));
        if (rows.size !== batch.length || batch.some(id => !rows.has(id))) throw new Error("Invalid presence targets");
        const observed = Date.parse(value.observedAt);
        for (const id of batch) {
          const row = rows.get(id);
          if (!["online", "offline", "unknown"].includes(row.presence)) throw new Error("Invalid presence state");
          const lease = row.presence === "online" ? Math.min(MAX_LEASE_MS, Math.max(0, Date.parse(row.onlineUntil) - observed)) : CACHE_MS;
          updated.set(id, { presence: row.presence, expiresAt: requestedAt + (Number.isFinite(lease) ? lease : 0), fetchedAt: now() });
        }
      }
      if (current()) for (const [id, row] of updated) entries.set(id,row);
    }).catch(() => { if (current()) entries.clear(); }).finally(() => {
      if (pending === task) pending = null;
      if (current()) { changed(); schedule(); }
    }).then(() => current() ? snapshot(ids) : { ok: true, observedAt: new Date(now()).toISOString(), states: ids.map(userId => ({userId, presence:"unknown", onlineUntil:null})) });
    pending = task;
    return task;
  };
  return {
    async get(value, source = 'default') {
      const input = presenceRequest(value); if (!input) throw Object.assign(new Error("Invalid presence targets"), {code:"COLLABORATION_INVALID_INPUT"});
      ensure(); if (stopped) return {ok:false,code:"COLLABORATION_STOPPED"};
      if (input.userIds.length) {
        if (!sources.has(source) && sources.size >= 8) return {ok:false,code:"COLLABORATION_UNAVAILABLE"};
        sources.set(source,input.userIds);
      } else sources.delete(source);
      const nextTargets = [...new Set([...sources.values()].flat())];
      if (JSON.stringify(targets) !== JSON.stringify(nextTargets)) {
        epoch++; targets = nextTargets; cancel();
        for (const id of entries.keys()) if (!targets.includes(id)) entries.delete(id);
      }
      if (!targets.length) return snapshot(input.userIds);
      if (targets.every(id => { const row = entries.get(id); return row && now() - row.fetchedAt < CACHE_MS && row.expiresAt > now(); })) { schedule(); return snapshot(input.userIds); }
      const generation = epoch;
      if (pending) { schedule(); await pending; }
      if (generation !== epoch || stopped) return {ok:true,observedAt:new Date(now()).toISOString(),states:input.userIds.map(userId=>({userId,presence:"unknown",onlineUntil:null}))};
      if (targets.every(id => { const row=entries.get(id);return row && now()-row.fetchedAt<CACHE_MS && row.expiresAt>now(); })) {schedule();return snapshot(input.userIds);}
      await refresh();
      return generation === epoch ? snapshot(input.userIds) : {ok:true,observedAt:new Date(now()).toISOString(),states:input.userIds.map(userId=>({userId,presence:"unknown",onlineUntil:null}))};
    },
    snapshot, clear,
    sourceSnapshot(source = 'default') { ensure(); return snapshot(sources.get(source) || []); },
    hint() { if (stopped || hintTimer != null || !targets.length) return; hintTimer = setTimeoutFn(() => { hintTimer = null; void refresh(); }, HINT_MS); hintTimer?.unref?.(); },
    disconnected() { clear(); schedule(); },
    foreground() { void refresh(); },
    stop() { stopped = true; targets = []; sources.clear(); clear(); },
  };
}
module.exports = { createOnlineStatus, presenceRequest, CACHE_MS, MAX_LEASE_MS, HINT_MS };
