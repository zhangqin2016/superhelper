"use strict";

const fail = (code) => Object.assign(new Error(`COLLAB_TASK_RECOVERY_${code}`), {code:`COLLAB_TASK_RECOVERY_${code}`});
const fields = ["id","conversationId","taskId","deliveryId","input","planHash","journal","state","kind","createdAt"];
const inputFields = ["applicationId","rootPath","deliveryRoot","baseManifest","deliveryManifest","editablePaths"];
const journalFields = ["binding","plan","planHash","state","rootIdentity","backupDirectory","operations","result"];
const entryFields = ["path","operation","status","expectedLocalHash","resultHash","mode","backupName","stagedName","temporaryName","state"];
function identifier(value) {
  if (typeof value !== "string" || !value || value.length > 200 || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value)) throw fail("INVALID");
  return value;
}
function closed(value, allowed) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(key=>!allowed.includes(key))) throw fail("INVALID");
}
function validateInput(value) {
  closed(value,inputFields);
  for (const list of [value.baseManifest,value.deliveryManifest]) {
    if (!Array.isArray(list)) throw fail("INVALID");
    for (const file of list) closed(file,["path","sha256","sizeBytes"]);
  }
  if (!Array.isArray(value.editablePaths) || value.editablePaths.some(item=>typeof item!=="string")) throw fail("INVALID");
}
function validatePlan(value) {
  closed(value,["entries","canApply"]);
  if (!Array.isArray(value.entries)) throw fail("INVALID");
  for (const entry of value.entries) closed(entry,entryFields);
}
function project(id,value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.id !== id) throw fail("INVALID");
  const result = Object.fromEntries(fields.filter(key=>value[key]!==undefined).map(key=>[key,value[key]]));
  for (const key of ["id","conversationId","taskId","deliveryId"]) identifier(result[key]);
  if (result.kind !== undefined && result.kind !== "application") throw fail("INVALID");
  if (result.createdAt !== undefined && (!Number.isSafeInteger(result.createdAt) || result.createdAt < 0)) throw fail("INVALID");
  if (typeof result.state !== "string" || !/^[a-z_]{1,40}$/.test(result.state)
    || typeof result.planHash !== "string" || !/^[a-f0-9]{64}$/.test(result.planHash)) throw fail("INVALID");
  validateInput(result.input);
  if (result.input.applicationId !== id) throw fail("BINDING_CONFLICT");
  if (result.journal != null) {
    closed(result.journal,journalFields);
    if (result.journal.binding) validateInput(result.journal.binding);
    if (result.journal.plan) validatePlan(result.journal.plan);
    if (!Array.isArray(result.journal.operations)) throw fail("INVALID");
    for (const operation of result.journal.operations) closed(operation,entryFields);
    if (result.journal.result) {
      closed(result.journal.result,["ok","state","applicationId","planHash","entries"]);
      if (!Array.isArray(result.journal.result.entries)) throw fail("INVALID");
      for (const entry of result.journal.result.entries) closed(entry,entryFields);
    }
  }
  return result;
}
const stable = value => JSON.stringify(value, (_key,item)=>item && !Array.isArray(item) && typeof item === "object"
  ? Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])) : item);

/** Local original-file recovery is account-owned, not remote collaboration
 * content. Its personal key and rows intentionally outlive team/conversation
 * retirement. This capability must stay main-only and cannot authorize remote
 * reads, new delivery application, engine execution, or task mutations. */
function createTaskRecovery({store,assertActive} = {}) {
  if (!store?.db || typeof assertActive !== "function") throw new TypeError("Task recovery requires an active account store");
  const accountId = identifier(store.accountId);
  function active() {
    assertActive();
    if (store.accountId !== accountId) throw Object.assign(new Error("Account changed"),{code:"COLLAB_ACCOUNT_CHANGED"});
  }
  function decode(row) {
    if (!row) return null;
    active();
    const value=store._decrypt({scopeId:"personal",recordId:`task-recovery:${row.id}`,value:row.payload_envelope_json});
    const projected=project(row.id,value);
    active();
    return projected;
  }
  return {
    get(id) {
      active();identifier(id);
      return decode(store.db.get("SELECT * FROM task_local_recovery WHERE account_id = ? AND id = ?",accountId,id));
    },
    put(id,value) {
      active();identifier(id);
      const record=project(id,value);
      return store.db.transaction(()=>{
        const existing=decode(store.db.get("SELECT * FROM task_local_recovery WHERE account_id = ? AND id = ?",accountId,id));
        if (existing && ["conversationId","taskId","deliveryId","input","planHash"].some(key=>stable(existing[key])!==stable(record[key]))) throw fail("BINDING_CONFLICT");
        const envelope=store._encrypt({scopeId:"personal",recordId:`task-recovery:${id}`,value:record});
        active();
        store.db.run(`INSERT INTO task_local_recovery(account_id,id,payload_envelope_json,updated_at) VALUES (?,?,?,?)
          ON CONFLICT(account_id,id) DO UPDATE SET payload_envelope_json = excluded.payload_envelope_json, updated_at = excluded.updated_at`,accountId,id,envelope,store.now());
        return record;
      })();
    },
    list() {
      active();
      return store.db.all("SELECT * FROM task_local_recovery WHERE account_id = ? ORDER BY updated_at,id",accountId).map(decode);
    },
  };
}
module.exports={createTaskRecovery};
