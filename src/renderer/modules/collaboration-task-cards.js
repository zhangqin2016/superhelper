import {t} from "../i18n/index.js";

export function createTaskCardController({api,getContext,onChange=()=>{}}) {
  let rows=[],generation=0,key="",service=null,disposed=false;
  const contextKey=()=>{const c=getContext() || {};return c.enabled&&c.userId&&c.conversationId?JSON.stringify([c.userId,c.conversationId]):"";};
  function publish(value) {if(JSON.stringify(rows)!==JSON.stringify(value)){rows=value;onChange();}}
  async function update(force=false) {
    const next=contextKey(),client=api();
    if(disposed || (!force && next===key && client===service)) return;
    const changed=next!==key || client!==service;
    key=next;service=client;const ticket=++generation;
    if(changed)publish([]);
    if(!key){publish([]);return;}
    const conversationId=getContext().conversationId;
    const current=()=>!disposed&&ticket===generation&&client===api()&&key===contextKey();
    const read=async()=>{
      const result=await client?.taskWorkflow?.({operation:"cards",conversationId});
      if(current())publish(result?.ok?result.cards || []:[]);
    };
    try {
      await read();if(!current())return;
      // Main caches only participant-authorized, monotonic task snapshots.
      const fresh=await client?.listTasks?.(conversationId);
      if(current()&&fresh?.ok)await read();
    } catch { /* cached local state remains; no invented remote success */ }
  }
  return {cards:()=>rows,update:()=>void update(),refresh:()=>void update(true),
    invalidate(){generation++;key="";publish([]);},destroy(){disposed=true;generation++;publish([]);}};
}

const states=new Set(["offered","active","review","changes_requested","accepted","declined","cancelled"]);
const localStates=new Set(["preparing","preparation_failed","prepared","uploading","confirming","failed","completed"]);
export function renderTaskCards(root,cards=[],onOpen) {
  const previous=new Map([...root.querySelectorAll(":scope > .collaboration-task-card")].map(row=>[row.dataset.cardId,row]));
  for(const card of cards) {
    let row=previous.get(card.id);previous.delete(card.id);
    if(!row){
      row=document.createElement("article");row.className="collaboration-task-card remote-task-card";row.dataset.cardId=card.id;
      const heading=document.createElement("strong"),status=document.createElement("p"),button=document.createElement("button");
      heading.className="task-card-title";status.className="remote-task-meta";status.setAttribute("role","status");
      button.type="button";button.className="remote-task-button";row.append(heading,status,button);
    }
    row.querySelector("strong").textContent=card.title;
    const label=states.has(card.state)?`state.${card.state}`:`cardState.${localStates.has(card.state)?card.state:"preparing"}`;
    row.querySelector("p").textContent=t(`collaboration.task.${label}`);
    const button=row.querySelector("button");button.textContent=t(`collaboration.task.${card.taskId?"view":"resume"}`);button.onclick=()=>onOpen?.(card);
    row.dataset.revision=String(card.revision);row.dataset.taskId=card.taskId || "";
    const after=[...root.querySelectorAll(":scope > .collaboration-message")].find(message=>Number(message.dataset.createdAt)>card.createdAt);
    root.insertBefore(row,after || null);
  }
  for(const row of previous.values())row.remove();
}
