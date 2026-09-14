"use strict";
const {createHash}=require("node:crypto");
const {createTaskRecords}=require("./task-records");
const fail=code=>Object.assign(new Error(`COLLAB_INTEGRATION_${code}`),{code:`COLLAB_INTEGRATION_${code}`});
const fields=["conversationId","workspaceId","taskId","deliveryId","targetId","chain","sessionId","projectId","baselineCommit","deliveryCommit"];
const hash=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
function identifier(value){if(typeof value!=="string" || !value || value.length>200 || value.trim()!==value || /[\x00-\x1f\x7f]/.test(value))throw fail("INVALID");return value;}
function input(value){
  if(!value || Object.getPrototypeOf(value)!==Object.prototype || Object.keys(value).some(key=>!fields.includes(key)))throw fail("INVALID");
  for(const field of fields)identifier(value[field]);
  if(!["shared","local"].includes(value.chain) || !/^[a-f0-9]{40}$/.test(value.baselineCommit) || !/^[a-f0-9]{40}$/.test(value.deliveryCommit))throw fail("INVALID");
  return Object.fromEntries(fields.map(field=>[field,value[field]]));
}

/** Main-only durable work identity. Scope-encrypted records retire with access;
 * opaque target generations survive retirement to prevent stale token reuse.
 * The caller supplies a canonical target identity and rechecks remote access.
 * A lease fences journal transitions; filesystem/Git writes still need their
 * own immediate checks/CAS and recovery evidence at each boundary. */
function createIntegrationIntents({store,assertActive,now=Date.now}){
  const records=createTaskRecords({store,assertActive}),accountId=store.accountId;
  const transaction=fn=>store.db.transaction(fn)();
  const time=()=>{const value=now();if(!Number.isSafeInteger(value)||value<0)throw fail("INVALID");return value;};
  function expiry(duration){if(!Number.isSafeInteger(duration)||duration<1||duration>300000)throw fail("INVALID");const value=time()+duration;if(!Number.isSafeInteger(value))throw fail("INVALID");return value;}
  function get(id){
    const record=records.get(identifier(id));if(!record)return null;
    if(record.kind!=="integration-intent" || !["pending","running","completed","cancelled"].includes(record.state))throw fail("INVALID");
    const binding=input(record.input);
    if(record.conversationId!==binding.conversationId || record.id!==intentId(binding))throw fail("CONFLICT");
    return record;
  }
  const read=id=>{const record=get(id);if(!record)throw fail("MISSING");return record;};
  const intentId=binding=>`integration:${hash([binding.workspaceId,binding.deliveryId,binding.targetId,binding.chain])}`;
  const targetKey=record=>hash(record.input.targetId);
  const lock=key=>store.db.get("SELECT * FROM task_integration_leases WHERE account_id=? AND target_key=?",accountId,key);
  function checked(token){
    if(!token || !Number.isSafeInteger(token.generation) || token.generation<1)throw fail("FENCED");
    const record=read(token.intentId),key=targetKey(record),lease=lock(key);
    if(record.state!=="running" || !lease || lease.intent_id!==record.id || lease.worker_id!==token.workerId
      || lease.generation!==token.generation || lease.expires_at<=time())throw fail("FENCED");
    return {record,key,lease};
  }
  const tokenFor=lease=>({intentId:lease.intent_id,workerId:lease.worker_id,generation:lease.generation,expiresAt:lease.expires_at});
  function finish(token,state){return transaction(()=>{
    const {record,key}=checked(token);
    store.db.run("UPDATE task_integration_leases SET intent_id=NULL,worker_id=NULL,expires_at=0 WHERE account_id=? AND target_key=?",accountId,key);
    if(state==="completed")store.db.run("UPDATE task_integration_work SET state='done',code=NULL,attempts=0,next_attempt_at=0 WHERE account_id=? AND intent_id=?",accountId,record.id);
    return records.put(record.id,{...record,state,updatedAt:time()});
  });}
  return Object.freeze({
    get,
    enqueue(value){const binding=input(value),id=intentId(binding);return transaction(()=>{
      const prior=get(id);
      if(prior){if(fields.some(field=>prior.input[field]!==binding[field]))throw fail("CONFLICT");return prior;}
      const record=records.put(id,{id,kind:"integration-intent",conversationId:binding.conversationId,input:binding,state:"pending",createdAt:time(),updatedAt:time()});
      store.db.run("INSERT INTO task_integration_work(account_id,intent_id,conversation_id,scope_id) VALUES(?,?,?,?)",accountId,id,binding.conversationId,store.getConversation({conversationId:binding.conversationId}).scopeId);
      return record;
    });},
    list(conversationId){return records.list(conversationId).filter(record=>record.kind==="integration-intent").map(record=>read(record.id));},
    claim(id,{workerId,leaseMs=30000}={}){identifier(workerId);const expiresAt=expiry(leaseMs);return transaction(()=>{
      const record=read(id);if(["completed","cancelled"].includes(record.state))return null;
      const key=targetKey(record),previous=lock(key);if(previous && previous.expires_at>time())return null;
      const generation=(previous?.generation||0)+1;if(!Number.isSafeInteger(generation))throw fail("EXHAUSTED");
      store.db.run(`INSERT INTO task_integration_leases(account_id,target_key,generation,intent_id,worker_id,expires_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,target_key) DO UPDATE SET generation=excluded.generation,intent_id=excluded.intent_id,worker_id=excluded.worker_id,expires_at=excluded.expires_at`,accountId,key,generation,id,workerId,expiresAt);
      records.put(id,{...record,state:"running",updatedAt:time()});return {intentId:id,workerId,generation,expiresAt};
    });},
    assertLease(token){return transaction(()=>{const {lease}=checked(token);return tokenFor(lease);});},
    renew(token,leaseMs=30000){const expiresAt=expiry(leaseMs);return transaction(()=>{
      const {key,lease}=checked(token);store.db.run("UPDATE task_integration_leases SET expires_at=? WHERE account_id=? AND target_key=?",Math.max(expiresAt,lease.expires_at),accountId,key);
      return tokenFor(lock(key));
    });},
    release:token=>finish(token,"pending"),
    complete:token=>finish(token,"completed"),
    cancel(id){return transaction(()=>{
      const record=read(id);if(record.state==="completed" || record.state==="cancelled")return record;
      const key=targetKey(record),lease=lock(key);
      if(lease?.intent_id===id)store.db.run("UPDATE task_integration_leases SET intent_id=NULL,worker_id=NULL,expires_at=0 WHERE account_id=? AND target_key=?",accountId,key);
      store.db.run("UPDATE task_integration_work SET state='done' WHERE account_id=? AND intent_id=?",accountId,id);
      return records.put(id,{...record,state:"cancelled",updatedAt:time()});
    });},
  });
}
module.exports={createIntegrationIntents};
