import {onLocaleChange,t} from "../i18n/index.js";
import {renderTaskCards} from "./collaboration-task-cards.js";
import {openWorkspaceTaskCard} from "./workspace-collaboration-entry.js";

/** Collaboration projection only: never add task data to engine messages. */
export function initSessionTaskCards({root,sessionId,client=()=>window.assistantClient,onOpen=openWorkspaceTaskCard}) {
  let active=false,disposed=false,generation=0,rows=[],accountId="",error=false;
  const cardsRoot=document.createElement("div"),status=document.createElement("p");
  status.className="remote-task-meta";status.setAttribute("role","status");root.append(cardsRoot,status);
  const draw=()=>{
    renderTaskCards(cardsRoot,rows,async card=>{
      const ticket=generation;
      try {const result=await onOpen(card);if(!disposed&&ticket===generation&&!result?.ok){error=true;draw();}}
      catch {if(!disposed&&ticket===generation){error=true;draw();}}
    });
    status.textContent=error?t("collaboration.task.loadFailed"):"";
    status.hidden=!error;root.hidden=!rows.length&&!error;
  };
  const clear=()=>{generation++;rows=[];accountId="";error=false;draw();};
  async function refresh() {
    if(!active||disposed)return;
    const ticket=++generation,api=client(),current=()=>!disposed&&active&&generation===ticket&&client()===api;
    try {
      const account=await api?.getAccountStatus?.();
      if(!current())return;
      if(!account?.loggedIn||!account.user?.id){clear();return;}
      if(accountId!==account.user.id){rows=[];accountId=account.user.id;draw();}
      const read=async(cached=true)=>{
        const result=await api.collaboration?.taskWorkflow?.({operation:"sessionCards",sessionId});
        if(current()){rows=result?.ok?(result.cards||[]).map(card=>({...card,cached})):[];error=false;draw();}
        return result;
      };
      const local=await read();if(!current()||!local?.ok)return;
      // Binding conversations are included even before their first cached task.
      let fresh=true;
      for(const conversationId of local.conversationIds||[]) {
        const result=await api.collaboration?.listTasks?.(conversationId);fresh=fresh&&result?.ok===true;if(!current())return;
      }
      if(local.conversationIds?.length)await read(!fresh);
    } catch { /* cached cards remain; remote success is never fabricated */ }
  }
  const changed=event=>{
    if(["typing","online-presence"].includes(event?.type))return;
    if(["availability","initial","access-revoked","relationship"].includes(event?.type))clear();
    void refresh();
  };
  const unsubscribe=client()?.collaboration?.onStateChange?.(changed);
  const accountChanged=()=>{clear();void refresh();};
  window.addEventListener("lily:account-status-changed",accountChanged);
  const locale=onLocaleChange(draw);draw();
  return {setActive(value){if(active===value)return;active=value;generation++;if(active)void refresh();},
    refresh:()=>void refresh(),destroy(){disposed=true;clear();unsubscribe?.();locale();window.removeEventListener("lily:account-status-changed",accountChanged);}};
}
