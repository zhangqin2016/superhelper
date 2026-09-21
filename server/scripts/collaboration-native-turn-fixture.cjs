"use strict";
const fs=require("node:fs"),path=require("node:path");
/** Real SessionManager/MessageStore/TaskCore/TurnOrchestrator; native project
 * discovery and window/runner availability are test adapters. No model runs. */
module.exports=function nativeTurnFixture({root,source,accountId,execute}){
  const previous=process.env.LILY_USER_DATA_DIR;process.env.LILY_USER_DATA_DIR=path.join(root,"native-profile");fs.mkdirSync(process.env.LILY_USER_DATA_DIR,{recursive:true});
  const SessionManager=require("../../src/main/session-manager");
  const {TurnOrchestrator}=require("../../src/main/turn-orchestrator");
  const {RuntimeEventBus}=require("../../src/main/runtime-event-bus");
  const {TranscriptStore}=require("../../src/main/transcript-store");
  const {TurnArchive}=require("../../src/main/turn-archive");
  const {enqueueIntegrationTurn}=require("../../src/main/collaboration/integration-turn");
  const project={id:"source-project",path:source,name:"Source"};
  const projectManager={projects:[project],find:id=>id===project.id?project:null,getActive:()=>project};
  const manager=new SessionManager(projectManager,{resolveCharacterOwnerScope:()=>accountId});
  manager.sessions={[project.id]:[{id:"source-session",projectId:project.id,title:"Original source",status:"idle",messages:[],createdAt:Date.now()}]};manager.activeSessionId="source-session";
  const events=[],window={isDestroyed:()=>false,webContents:{send:(_channel,event)=>events.push(event)}};
  const eventBus=new RuntimeEventBus(()=>window);
  const orchestrator=new TurnOrchestrator({mainWindow:window,sessionManager:manager,projectManager,eventBus,
    transcriptStore:new TranscriptStore(manager),turnArchive:new TurnArchive(manager,{eventBus}),
    runnerPool:{get:()=>null,terminateSession(){throw Error("Unexpected runner mutation");}},executeCollaborationIntegration:execute});
  return {manager,orchestrator,events,enqueue:request=>enqueueIntegrationTurn(orchestrator,request),close(){
    clearInterval(orchestrator.stuckPhaseGuard);
    orchestrator.turnRecoveryRuntime.disposeParentClosureRecovery?.();
    for(const timer of orchestrator.dispatchRetryTimers.values())clearTimeout(timer);
    manager.close();if(previous===undefined)delete process.env.LILY_USER_DATA_DIR;else process.env.LILY_USER_DATA_DIR=previous;
  }};
};
