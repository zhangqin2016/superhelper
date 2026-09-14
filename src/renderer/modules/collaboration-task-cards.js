import {t} from "../i18n/index.js";
import {readCardWindow,compareCardPosition} from "./task-card-pages.js";

export function createTaskCardController({api,getContext,onChange=()=>{}}) {
  let rows=[],nextCursor=null,busy=false,error=false,refreshPending=false,generation=0,key="",service=null,disposed=false;
  const contextKey=()=>{const c=getContext() || {};return c.enabled&&c.userId&&c.conversationId?JSON.stringify([c.userId,c.conversationId]):"";};
  function publish(value) {if(JSON.stringify(rows)!==JSON.stringify(value)){rows=value;onChange();}}
  function clear(){generation++;nextCursor=null;busy=false;error=false;refreshPending=false;rows=[];onChange();}
  async function update(force=false) {
    const next=contextKey(),client=api();
    if(disposed || (!force && next===key && client===service))return;
    const changed=next!==key || client!==service;
    if(busy&&!changed){refreshPending=true;return;}
    key=next;service=client;if(changed)clear();const ticket=++generation;
    if(!key){clear();return;}
    const conversationId=getContext().conversationId;
    const current=()=>!disposed&&ticket===generation&&client===api()&&key===contextKey();
    const read=async(cached=true)=>{
      const result=await readCardWindow(before=>client?.taskWorkflow?.({operation:"cards",conversationId,...(before?{before}:{})}),{through:rows[0],current});
      if(!current()||!result)return;
      nextCursor=result.nextCursor;error=false;
      publish(result.ok?result.cards.map(card=>({...card,cached})):[]);onChange();
    };
    try {
      await read();if(!current())return;
      const fresh=await client?.listTasks?.(conversationId);
      if(current()&&fresh?.ok)await read(false);
    } catch { /* cached local state remains; no invented remote success */ }
  }
  async function loadMore() {
    if(disposed||busy||!nextCursor||!key)return;
    const ticket=++generation,client=api(),conversationId=getContext().conversationId;
    const current=()=>!disposed&&ticket===generation&&client===api()&&key===contextKey();
    busy=true;error=false;onChange();
    try {
      const page=await readCardWindow(before=>client.taskWorkflow({operation:"cards",conversationId,before}),{before:nextCursor,current});
      if(!current()||!page)return;
      if(!page.ok){if(/REVOKED|ACCOUNT_CHANGED|STOPPED/.test(page.code||"")){clear();return;}throw Error("Task page unavailable");}
      nextCursor=page.nextCursor;
      const merged=new Map(rows.map(card=>[card.id,card]));for(const card of page.cards)merged.set(card.id,{...card,cached:true});
      publish([...merged.values()].sort(compareCardPosition));
    } catch {if(current())error=true;}
    finally {if(current()){busy=false;onChange();if(refreshPending){refreshPending=false;void update(true);}}}
  }
  return {cards:()=>rows,pagination:()=>({nextCursor,busy,error,loadMore}),update:()=>void update(),refresh:()=>void update(true),
    invalidate(){key="";clear();},destroy(){disposed=true;clear();}};
}

const states=new Set(["offered","active","review","changes_requested","accepted","declined","cancelled"]);
const localStates=new Set(["preparing","preparation_failed","prepared","uploading","confirming","failed","completed"]);
const integrationStates=new Set(["queued","preparing","validation_required","conflict","failed","publication_pending","published","cancelled","binding_required"]);
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
    const integration=integrationStates.has(card.integration?.stage)?card.integration.stage:"";
    row.querySelector("p").textContent=t(`collaboration.task.${label}`)+(integration?` · ${t(`collaboration.task.integration.${integration}`)}`:"")+(card.cached&&card.taskId?` · ${t("collaboration.task.cachedState")}`:"");
    row.dataset.integration=integration;
    const button=row.querySelector("button");button.textContent=t(`collaboration.task.${card.taskId?"view":"resume"}`);button.onclick=()=>onOpen?.(card);
    row.dataset.revision=String(card.revision);row.dataset.taskId=card.taskId || "";
    const after=[...root.querySelectorAll(":scope > .collaboration-message")].find(message=>Number(message.dataset.createdAt)>card.createdAt);
    root.insertBefore(row,after || null);
  }
  for(const row of previous.values())row.remove();
}
