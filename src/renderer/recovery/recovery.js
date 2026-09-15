"use strict";
const $ = id => document.getElementById(id);
let state = { busy:true,phase:"checking",locale:"en",candidates:[],allowRestore:true };
let requested = false;
function render(next) {
  state = next;
  const t = state.strings || {};
  document.documentElement.lang=state.locale;
  document.documentElement.dir=state.locale==="ar"?"rtl":"ltr";
  document.body.dataset.phase=state.phase;
  $("version").textContent=state.version || "—";
  $("eyebrow").textContent=t.eyebrow;
  $("title").textContent=t[state.phase]||t.blocked;
  const reasons={missing_with_evidence:"missing",recovery_interrupted:"missing",startup_failed:"startup",disk_full:"space",no_space:"space",busy:"busy"};
  $("detail").textContent=t[`${state.phase}Detail`]||t[reasons[state.reason]||state.reason]||t.unknown;
  $("safety").textContent=t.safety;
  $("retry").textContent=!state.allowRestore?t.restart:state.phase==="restored"?t.continue:t.retry;
  for(const id of ["prepare","restore","export","exit"])$(id).textContent=t[id];
  $("candidate-label").textContent=t.choose;
  const selection=$("candidates").value;
  $("candidates").replaceChildren(...state.candidates.map(candidate=>{
    const option=document.createElement("option");option.value=candidate.id;
    option.textContent=`${t['source_'+candidate.sourceKind]||t.source_unknown} · ${candidate.createdAt?new Date(candidate.createdAt).toLocaleString(state.locale):t.source_unknown} · ${candidate.messageCount} ${t.messages} · ${candidate.sessionCount} ${t.sessions}`;
    return option;
  }));
  if(state.candidates.some(item=>item.id===selection))$("candidates").value=selection;
  $("candidate-area").hidden=!state.candidates.length;
  $("restore").hidden=!state.candidates.length||!state.allowRestore||!["corrupt","missing_with_evidence"].includes(state.reason);
  $("prepare").hidden=!state.allowRestore||state.phase==="restored";
  for(const element of document.querySelectorAll("button,select")) element.disabled=state.busy||requested;
}
async function act(action,id) {
  if(requested||state.busy)return;
  requested=true;$("notice").textContent="";render(state);
  try {
    const result=await window.databaseRecovery.act(action,id);
    if(result?.phase)state=result;
    else if(action==="export"&&!result?.cancelled)$("notice").textContent=state.strings?.[result?.ok?"exported":"exportFailed"]||"";
    if(action==="prepare"&&!state.candidates.length)$("notice").textContent=state.strings?.empty||"";
  } catch { $("notice").textContent=state.strings?.unknown||""; }
  finally {requested=false;render(state);}
}
$("retry").onclick=()=>act(state.allowRestore?"inspect":"restart");
$("prepare").onclick=()=>act("prepare");
$("restore").onclick=()=>act("restore",$("candidates").value);
$("export").onclick=()=>act("export");
$("exit").onclick=()=>act("exit");
window.databaseRecovery.onChange(render);
window.databaseRecovery.act("state").then(render).catch(()=>{state.busy=false;render(state);});
