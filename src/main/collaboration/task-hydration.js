"use strict";
const {randomUUID}=require("node:crypto");
const {taskView}=require("./task-view");
const {createTaskCards}=require("./task-cards");
const fail=code=>{throw Object.assign(new Error(code),{code});};

function queueTaskHydration(store,event) {
  if(event.type!=="task.updated")return;
  const {taskId,revision}=event.payload || {};
  if(typeof taskId!=="string" || !/^[A-Za-z0-9_-]{1,200}$/.test(taskId) || !Number.isSafeInteger(revision) || revision<1)
    return fail("COLLAB_TASK_EVENT_INVALID");
  store.db.run(`INSERT INTO task_hydration(account_id,task_id,revision,generation,updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(account_id,task_id) DO UPDATE SET revision=excluded.revision,generation=excluded.generation,
      state='pending',attempts=0,next_attempt_at=0,code=NULL,updated_at=excluded.updated_at
    WHERE excluded.revision>=task_hydration.revision`,store.accountId,taskId,revision,randomUUID(),store.now());
}

/** Read-only network work. Queue mutation and encrypted publication are atomic;
 * a newer generation or stopped account invalidates every awaited response. */
function createTaskHydration({store,client,deviceId,assertActive,ensureConversation,onChange=()=>{}}) {
  const accountId=store.accountId;
  let running=null,cards=null;
  const active=()=>{assertActive();if(store.accountId!==accountId)fail("COLLAB_ACCOUNT_CHANGED");};
  const current=row=>store.db.get("SELECT generation FROM task_hydration WHERE account_id=? AND task_id=?",accountId,row.task_id)?.generation===row.generation;
  async function drain() {
    active();if(!store.db||!deviceId||!client?.getTask)return;
    cards ||= createTaskCards({store,assertActive});
    const rows=store.db.all("SELECT * FROM task_hydration WHERE account_id=? AND state='pending' AND next_attempt_at<=? ORDER BY next_attempt_at,updated_at,task_id LIMIT 16",accountId,store.now());
    for(const row of rows) {
      try {
        active();
        const task=taskView(await client.getTask({deviceId,taskId:row.task_id}));
        active();if(!current(row))continue;
        if(!task||task.id!==row.task_id)fail("COLLAB_TASK_INVALID");
        if(![task.requesterUserId,task.assigneeUserId].includes(accountId))fail("COLLAB_TASK_ACCESS_DENIED");
        if(task.revision<row.revision)fail("COLLAB_TASK_REVISION_STALE");
        if(!store.getConversation({conversationId:task.conversationId})) {
          if(!ensureConversation)fail("COLLAB_TASK_CONVERSATION_PENDING");
          await ensureConversation(task.conversationId);
          active();if(!current(row))continue;
        }
        store.db.transaction(()=>{
          active();if(!current(row))return;
          cards.remember(task);
          store.db.run("DELETE FROM task_hydration WHERE account_id=? AND task_id=? AND generation=?",accountId,row.task_id,row.generation);
        })();
        onChange();
      } catch(error) {
        active();if(!current(row))continue;
        const denied=["COLLAB_TASK_ACCESS_DENIED","COLLAB_ACCESS_REVOKED"].includes(error.code);
        const code=/^[A-Z_]{1,80}$/.test(error.code || "")?error.code:"COLLAB_TASK_UNAVAILABLE";
        const next=store.now()+Math.min(30000,1000*2**Math.min(row.attempts,5));
        store.db.run("UPDATE task_hydration SET state=?,access_denied=MAX(access_denied,?),attempts=attempts+1,next_attempt_at=?,code=?,updated_at=? WHERE account_id=? AND task_id=? AND generation=?",
          denied?"denied":"pending",Number(denied),next,code,store.now(),accountId,row.task_id,row.generation);
        if(denied)onChange();
      }
    }
  }
  return {recover(){if(!running)running=drain().finally(()=>{running=null;});return running;}};
}
module.exports={queueTaskHydration,createTaskHydration};
