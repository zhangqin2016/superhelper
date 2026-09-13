"use strict";
const {randomUUID}=require("node:crypto");
const {createTaskCards}=require("./task-cards");
const {createTaskRecords}=require("./task-records");
const {taskView}=require("./task-view");
const {queueTaskHydration}=require("./task-hydration");
const {assertScopeWritable,isConversationRevoked}=require("./access-revocation");
const fail=code=>{throw Object.assign(new Error(code),{code});};
const id=value=>typeof value==="string"&&/^[A-Za-z0-9_-]{1,200}$/.test(value);
const position=value=>value&&id(value.id)&&Number.isSafeInteger(value.createdAt)&&value.createdAt>=0&&value.createdAt<=8640000000000000;
const compare=(a,b)=>a.createdAt-b.createdAt||(a.id===b.id?0:a.id<b.id?-1:1);

function seedTaskHistory(store,{reset=false}={}) {
  if(!store.db)return;
  store.db.transaction(()=>{
    store.db.run(`DELETE FROM task_history_scans WHERE account_id=? AND conversation_id NOT IN
      (SELECT id FROM conversations WHERE account_id=?)`,store.accountId,store.accountId);
    store.db.run(`INSERT INTO task_history_scans(account_id,conversation_id,scope_id,generation,updated_at)
      SELECT account_id,id,scope_id,lower(hex(randomblob(16))),? FROM conversations c WHERE account_id=?
      AND NOT EXISTS(SELECT 1 FROM revoked_conversations r WHERE r.account_id=c.account_id AND r.conversation_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM revoked_scopes r WHERE r.account_id=c.account_id AND r.scope_id=c.scope_id)
      ON CONFLICT(account_id,conversation_id) DO UPDATE SET scope_id=excluded.scope_id,generation=excluded.generation,
        state='pending',cursor_created_at=NULL,cursor_task_id=NULL,attempts=0,next_attempt_at=0,code=NULL,updated_at=excluded.updated_at
      WHERE ? OR task_history_scans.scope_id<>excluded.scope_id`,store.now(),store.accountId,Number(reset));
    store.db.run(`DELETE FROM task_history_seen WHERE account_id=? AND NOT EXISTS
      (SELECT 1 FROM task_history_scans s WHERE s.account_id=task_history_seen.account_id
      AND s.conversation_id=task_history_seen.conversation_id AND s.generation=task_history_seen.generation)`,store.accountId);
  })();
}

function createTaskHistory({store,client,deviceId,protocol,assertActive,onChange=()=>{}}) {
  const accountId=store.accountId;let running=null,cards,records;
  const active=()=>{assertActive();if(store.accountId!==accountId)fail("COLLAB_ACCOUNT_CHANGED");};
  const current=row=>store.db.get("SELECT generation FROM task_history_scans WHERE account_id=? AND conversation_id=?",accountId,row.conversation_id)?.generation===row.generation;
  function scope(row) {
    active();const conversation=store.getConversation({conversationId:row.conversation_id});
    if(!conversation||conversation.scopeId!==row.scope_id||isConversationRevoked(store,row.conversation_id))fail("COLLAB_ACCESS_REVOKED");
    assertScopeWritable(store,row.scope_id);
  }
  async function drain() {
    active();if(protocol!==1||!store.db||!deviceId||!client?.listTaskHistory)return;
    cards ||= createTaskCards({store,assertActive});records ||= createTaskRecords({store,assertActive});
    seedTaskHistory(store);
    for(let count=0;count<4;count++) {
      active();let row=store.db.get("SELECT * FROM task_history_scans WHERE account_id=? AND next_attempt_at<=? ORDER BY next_attempt_at,updated_at,conversation_id LIMIT 1",accountId,store.now());
      if(!row)break;
      if(row.state!=="pending") {
        store.db.run("UPDATE task_history_scans SET generation=?,state='pending',cursor_created_at=NULL,cursor_task_id=NULL,attempts=0,code=NULL WHERE account_id=? AND conversation_id=?",randomUUID(),accountId,row.conversation_id);
        store.db.run("DELETE FROM task_history_seen WHERE account_id=? AND conversation_id=?",accountId,row.conversation_id);
        row=store.db.get("SELECT * FROM task_history_scans WHERE account_id=? AND conversation_id=?",accountId,row.conversation_id);
      }
      try {
        scope(row);
        const cursor=row.cursor_task_id?{createdAt:row.cursor_created_at,id:row.cursor_task_id}:undefined;
        const page=await client.listTaskHistory({deviceId,conversationId:row.conversation_id,...(cursor?{cursor}:{})});
        active();if(!current(row))break;scope(row);
        if(!page||!Array.isArray(page.tasks)||page.tasks.length>50||!(page.nextCursor===null||position(page.nextCursor)))fail("COLLAB_TASK_HISTORY_INVALID");
        const next=page.nextCursor,tasks=page.tasks.map(taskView);
        if(next&&cursor&&compare(next,cursor)>=0)fail("COLLAB_TASK_HISTORY_INVALID");
        if(tasks.some(t=>!t||t.conversationId!==row.conversation_id||![t.requesterUserId,t.assigneeUserId].includes(accountId)
          ||(cursor&&compare(t,cursor)>=0)||(next&&compare(t,next)<0))||new Set(tasks.map(t=>t.id)).size!==tasks.length)fail("COLLAB_TASK_HISTORY_INVALID");
        store.db.transaction(()=>{
          scope(row);
          for(const task of tasks) {
            cards.remember(task);
            store.db.run("INSERT OR IGNORE INTO task_history_seen VALUES (?,?,?,?)",accountId,row.conversation_id,row.generation,task.id);
            if(store.db.get("SELECT 1 FROM task_hydration WHERE account_id=? AND task_id=? AND access_denied=1",accountId,task.id))
              queueTaskHydration(store,{type:"task.updated",payload:{taskId:task.id,revision:task.revision}});
          }
          if(!next) {
            const missing=store.db.all(`SELECT id FROM task_workspace_records r WHERE account_id=? AND conversation_id=? AND id LIKE 'task-card:%'
              AND NOT EXISTS(SELECT 1 FROM task_history_seen s WHERE s.account_id=r.account_id AND s.conversation_id=r.conversation_id
              AND s.generation=? AND s.task_id=substr(r.id,11))`,accountId,row.conversation_id,row.generation);
            for(const record of missing) {
              const task=records.get(record.id).task;
              queueTaskHydration(store,{type:"task.updated",payload:{taskId:task.id,revision:task.revision}});
              store.db.run("UPDATE task_hydration SET access_denied=1 WHERE account_id=? AND task_id=?",accountId,task.id);
            }
            store.db.run("DELETE FROM task_history_seen WHERE account_id=? AND conversation_id=?",accountId,row.conversation_id);
          }
          store.db.run("UPDATE task_history_scans SET state=?,access_denied=CASE WHEN ? THEN access_denied ELSE 0 END,cursor_created_at=?,cursor_task_id=?,attempts=0,code=NULL,next_attempt_at=?,updated_at=? WHERE account_id=? AND conversation_id=? AND generation=?",
            next?"pending":"complete",Number(Boolean(next)),next?.createdAt??null,next?.id??null,next?0:store.now()+300000,store.now(),accountId,row.conversation_id,row.generation);
        })();
        onChange();
      } catch(error) {
        active();if(!current(row))break;
        const denied=["COLLAB_TASK_ACCESS_DENIED","COLLAB_ACCESS_REVOKED"].includes(error.code);
        const code=/^[A-Z_]{1,80}$/.test(error.code||"")?error.code:"COLLAB_TASK_UNAVAILABLE";
        store.db.run("UPDATE task_history_scans SET state=?,access_denied=MAX(access_denied,?),attempts=attempts+1,code=?,next_attempt_at=?,updated_at=? WHERE account_id=? AND conversation_id=? AND generation=?",
          denied?"denied":"pending",Number(denied),code,store.now()+(denied?300000:Math.min(30000,1000*2**Math.min(row.attempts,5))),store.now(),accountId,row.conversation_id,row.generation);
        if(denied)onChange();
      }
    }
  }
  return {recover(){if(!running)running=drain().finally(()=>{running=null;});return running;}};
}
module.exports={seedTaskHistory,createTaskHistory};
