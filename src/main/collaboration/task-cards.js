"use strict";
const {createTaskRecords}=require("./task-records");
const {taskView}=require("./task-view");
const fail=code=>{throw Object.assign(new Error(code),{code});};

/** Authorized snapshots and local intents share a card anchor, not an IM
 * message. No task body or local filesystem path is broadcast in events. */
function createTaskCards({store,assertActive}) {
  const records=createTaskRecords({store,assertActive});
  function remember(input) {
    const task=taskView(input);
    if (!task) return fail("COLLAB_TASK_INVALID");
    if (![task.requesterUserId,task.assigneeUserId].includes(store.accountId)) return fail("COLLAB_TASK_ACCESS_DENIED");
    return store.db.transaction(()=>{
      const id=`task-card:${task.id}`, previous=records.get(id)?.task;
      if (previous) {
        for (const key of ["id","conversationId","requesterUserId","assigneeUserId","inputSnapshotId","sharedWorkspaceId","createdAt"])
          if (previous[key]!==task[key]) return fail("COLLAB_TASK_REVISION_CONFLICT");
        if (previous.revision>task.revision) return previous;
        if (previous.revision===task.revision) {
          if (JSON.stringify(previous)!==JSON.stringify(task)) return fail("COLLAB_TASK_REVISION_CONFLICT");
          return previous;
        }
        if (task.updatedAt<previous.updatedAt) return fail("COLLAB_TASK_REVISION_CONFLICT");
      }
      records.put(id,{id,kind:"task-card",conversationId:task.conversationId,task});
      return task;
    })();
  }
  function list(conversationId) {
    const all=records.list(conversationId);
    const tasks=new Map(all.filter(r=>r.kind==="task-card").map(r=>[r.task.id,r.task]));
    const cards=[];
    const card=(id,createdAt,task,draft)=>({id,taskId:task?.id || draft?.taskId || null,
      createdAt:createdAt || 0,revision:task?.revision || draft?.taskRevision || 0,
      title:task?.title || draft?.input?.title || draft?.name || "",
      state:task?.state || draft?.taskState || draft?.state || "preparing",
      localState:draft?.state || null});
    for (const draft of all.filter(r=>r.kind==="draft" && (!r.taskId || r.input))) {
      // The server may commit before the sender receives its receipt. Only the
      // task-scoped object and exact command content can connect that snapshot
      // to a pending intent; matching titles alone would hide distinct tasks.
      const task=tasks.get(draft.taskId) || (!draft.taskId && draft.objectId && draft.input
        ? [...tasks.values()].find(candidate=>candidate.requesterUserId===store.accountId
          && candidate.inputSnapshotId===draft.objectId
          && (candidate.sharedWorkspaceId || null)===(draft.sharedWorkspaceId || null)
          && candidate.assigneeUserId===draft.input.assigneeUserId
          && ["title","objective","acceptanceCriteria"].every(key=>
            candidate[key]===String(draft.input[key] || "").trim())) : null);
      cards.push(card(draft.id,draft.createdAt,task,draft));
      if (task) tasks.delete(task.id);
    }
    for (const task of tasks.values()) cards.push(card(task.id,task.createdAt,task));
    return cards.sort((a,b)=>a.createdAt-b.createdAt || a.id.localeCompare(b.id));
  }
  return {remember,list};
}
module.exports={createTaskCards};
