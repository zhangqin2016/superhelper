"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { freezeTaskBundle, unpackTaskBundle } = require("./task-bundle");
const fail = (code = "COLLAB_TASK_UNAVAILABLE") => Object.assign(new Error(code), { code });
const requireOk = value => { if (!value?.ok) throw fail(value?.code); return value; };

/**
 * Every task-workflow operation the desktop can ask for, in one dispatcher.
 *
 * The workflow itself owns durable state — records, recoveries, Git, transfers —
 * and this is the surface that turns a command into work against it. They were
 * one 767-line file, which put the state machine and twenty request handlers in
 * the same reading frame; the handlers are what changes when a capability is
 * added, and the state machine is what must not.
 *
 * The context is explicit rather than implicit closure: everything a handler may
 * touch is named here, so a new handler cannot quietly reach into workflow
 * internals, and the workflow can be read without reading the handlers.
 */
function createTaskOperations(ctx) {
  const {
    answersId,
    application,
    authorizeIntegration,
    binding,
    cards,
    checkPolicies,
    checkSelection,
    contribution,
    delivery,
    download,
    draftView,
    freeze,
    git,
    inventoryView,
    notify,
    read,
    records,
    recoveries,
    rememberGitObject,
    save,
    taskFor,
    undo,
    upload,
    wireBundle,
    workspaceBindingId,
    receive,
    assertActive,
    chooseDirectory,
    chooseValidationChecks,
    client,
    deviceId,
    integrationValidationAvailable,
    listWorkspaceBindings,
    openWorkspace,
    resolveCardSession,
    resolveProjectDirectory,
    resolveSourceSession,
    resolveWorkspaceBinding,
    rootPath,
    sharedWorkspaceProtocol,
    store,
    tasks,
    transfers,
  } = ctx;

  async function execute(command) {
    assertActive();
    const {operation,conversationId} = command;
    if(operation==="integrationStatus" || operation==="retryIntegration" || operation==="configureIntegrationChecks" || operation==="answerIntegration"){
      const task=await taskFor(command);
      const current=()=>require("./integration-status").taskIntegration(task,records.list(conversationId),new Map(store.db.all("SELECT * FROM task_integration_work WHERE account_id=? AND conversation_id=?",store.accountId,conversationId).map(row=>[row.intent_id,row])),integrationValidationAvailable,
        store.db.get("SELECT code FROM task_hydration WHERE account_id=? AND task_id=?",store.accountId,task.id)?.code==="COLLAB_TASK_BINDING_REQUIRED");
      const found=current();
      if(operation==="integrationStatus"){
        const status=found?.status;
        if(status && found?.intent?.state==="pending" && found.work.state!=="running" && typeof chooseValidationChecks==="function"){
          await authorizeIntegration(found.intent.input);
          const source=read(`task:${task.id}`,conversationId),identity=checkSelection.sourceIdentity(source.sourceRoot);
          status.canConfigureChecks=true;status.checkCount=checkPolicies.current(found.intent.input,identity)?.policy.files.length||0;
        }
        return {ok:true,integration:status || null};
      }
      if(!found?.intent || command.deliveryId!==task.currentDeliveryId)throw fail("COLLAB_TASK_LOCAL_MISSING");
      await authorizeIntegration(found.intent.input);
      if(operation==="configureIntegrationChecks"){
        if(typeof chooseValidationChecks!=="function"||found.intent.state!=="pending"||found.work.state==="running")throw fail("COLLAB_TASK_BUSY");
        const input=found.intent.input,source=read(`task:${task.id}`,conversationId),identity=checkSelection.sourceIdentity(source.sourceRoot);
        const previous=checkPolicies.current(input,identity);
        const choice=await chooseValidationChecks({sourceRoot:source.sourceRoot});assertActive();
        if(choice?.canceled)return {ok:true,cancelled:true,integration:found.status};
        if(checkSelection.sourceIdentity(source.sourceRoot)!==identity)throw fail("COLLAB_CHECK_POLICY_SOURCE_CHANGED");
        const selected=checkSelection.selectedChecks(source.sourceRoot,choice?.filePaths);
        const assertCurrent=()=>{
          if(checkSelection.sourceIdentity(source.sourceRoot)!==identity)throw fail("COLLAB_CHECK_POLICY_SOURCE_CHANGED");
          const fresh=current();if(!fresh?.intent || fresh.intent.id!==found.intent.id || fresh.intent.state!=="pending" || fresh.work.state==="running")throw fail("COLLAB_TASK_BUSY");
        };
        const authorize=async()=>{await authorizeIntegration(input);assertCurrent();return true;};
        const policy=await checkPolicies.install({input,sourceIdentity:identity,taskGit:git(),baseline:source.gitBaseline,
          paths:selected.paths,selectedHashes:selected.hashes,expectedPolicyId:previous?.id||null,authorize,assertCurrent,
          onInstalled:()=>store.db.run("UPDATE task_integration_work SET state='pending',code=NULL,attempts=0,next_attempt_at=0 WHERE account_id=? AND intent_id=? AND state='waiting' AND code IN ('COLLAB_INTEGRATION_VALIDATION_REQUIRED','COLLAB_INTEGRATION_VALIDATION_FAILED')",store.accountId,found.intent.id)});
        notify();return {ok:true,integration:{...current().status,canConfigureChecks:true,checkCount:policy.policy.files.length}};
      }
      if(operation==="answerIntegration"){
        // Requester answers are evidence for the next repair attempt, stored
        // per intent and re-admitting the same durable work item.
        const questions=found.status.questions||[];
        if(!questions.length||command.answers.some(item=>!questions.some(q=>q.path===item.path)))throw fail("COLLAB_TASK_INVALID");
        const id=answersId(found.intent.id),previous=records.get(id);
        if(previous&&(previous.kind!=="integration-answers"||previous.intentId!==found.intent.id))throw fail("COLLAB_TASK_INVALID");
        const now=store.now(),answers=[...(previous?.answers||[]).filter(a=>!command.answers.some(n=>n.path===a.path)),
          ...command.answers.map(item=>({path:item.path,question:questions.find(q=>q.path===item.path).question,answer:item.answer.trim().slice(0,4000),answeredAt:now}))].slice(-32);
        store.db.transaction(()=>{
          if(found.work.state==="running")throw fail("COLLAB_TASK_BUSY");
          records.put(id,{kind:"integration-answers",conversationId,intentId:found.intent.id,answers});
          store.db.run("UPDATE task_integration_work SET state='pending',code=NULL,attempts=0,next_attempt_at=0 WHERE account_id=? AND intent_id=? AND state='waiting' AND code IN ('COLLAB_INTEGRATION_CONFLICT','COLLAB_INTEGRATION_DECISION_REQUIRED')",store.accountId,found.intent.id);
          store.db.run("UPDATE task_integration_work SET code='COLLAB_LOCAL_APPLICATION_PENDING',next_attempt_at=0 WHERE account_id=? AND intent_id=? AND state='done' AND code='COLLAB_LOCAL_APPLICATION_REQUIRED'",store.accountId,found.intent.id);
        })();
        notify();return {ok:true,integration:current().status};
      }
      const result=store.db.transaction(()=>{
        const fresh=current();if(!fresh?.intent || !fresh.work)throw fail("COLLAB_TASK_LOCAL_MISSING");
        if(fresh.status.stage==="queued")return fresh.status;
        if(fresh.work.state==="running")throw fail("COLLAB_TASK_BUSY");
        if(!fresh.status.canRetry)throw fail("COLLAB_TASK_RETRY_UNAVAILABLE");
        const baselineId=`remote-baseline:${createHash('sha256').update(JSON.stringify(fresh.intent.id)).digest('hex')}`,baseline=records.get(baselineId);
        if(baseline?.kind==='remote-baseline-resolution'&&baseline.intentId===fresh.intent.id&&baseline.state==='unavailable')
          records.put(baselineId,{...baseline,state:'pending',request:null,nextCursor:null,updatedAt:store.now()});
        store.db.run("UPDATE task_integration_work SET state='pending',code=NULL,attempts=0,next_attempt_at=0 WHERE account_id=? AND intent_id=?",store.accountId,fresh.intent.id);
        return {...fresh.status,stage:"queued",canRetry:false};
      })();
      notify();return {ok:true,integration:result};
    }
    if (operation === "cards") return {ok:true,...require("./task-cards").pageTaskCards(cards.list(conversationId),command.before)};
    if (operation === "sessionCards") {
      const session=resolveCardSession?.(command.sessionId);
      if (!session || session.sessionId!==command.sessionId) throw fail("COLLAB_TASK_LOCAL_MISSING");
      const projection=cards.sessionProjection({...session,deviceId});
      return {ok:true,...projection,...require("./task-cards").pageTaskCards(projection.cards,command.before)};
    }
    if (operation === "bindingOptions") {
      const task = await taskFor(command);
      if (!task.sharedWorkspaceId || !listWorkspaceBindings) throw fail("COLLAB_TASK_UNAVAILABLE");
      const workspace = records.get(workspaceBindingId(task));
      if (workspace && workspace.conversationId !== conversationId) throw fail("COLLAB_TASK_ACCESS_DENIED");
      return {ok:true,projects:listWorkspaceBindings(),binding:workspace ? {projectId:workspace.projectId,sessionId:workspace.sessionId} : null};
    }
    if (operation === "bind") {
      const task = await taskFor(command);
      if (!task.sharedWorkspaceId || !resolveWorkspaceBinding) throw fail("COLLAB_TASK_UNAVAILABLE");
      const id = workspaceBindingId(task);
      const existing = records.get(id);
      const projectId = command.projectId || existing?.projectId;
      if (existing && (existing.conversationId !== conversationId || existing.projectId !== projectId
        || (command.sessionId && existing.sessionId !== command.sessionId))) throw fail("COLLAB_TASK_BINDING_CONFLICT");
      let selectedRoot;
      if (!projectId) {
        const selected=await chooseDirectory?.();
        const current=await taskFor(command);
        if (current.sharedWorkspaceId!==task.sharedWorkspaceId) throw fail("COLLAB_TASK_BINDING_CONFLICT");
        if (selected?.canceled) return {ok:true,cancelled:true};
        if (selected?.filePaths?.length!==1) throw fail("COLLAB_TASK_LOCAL_MISSING");
        selectedRoot=fs.realpathSync(selected.filePaths[0]);
        if (records.get(id)) throw fail("COLLAB_TASK_BINDING_CONFLICT");
      }
      // Main-process resolver is synchronous: no authorization gap between the
      // current task grant and choosing/creating an idle local session.
      const target = resolveWorkspaceBinding({projectId,rootPath:selectedRoot,sessionId:existing?.sessionId || command.sessionId,
        bindingId:id,title:task.title});
      records.list(conversationId);
      if (!target || (projectId && target.projectId !== projectId) || typeof target.projectId !== "string" || typeof target.sessionId !== "string"
        || !path.isAbsolute(target.rootPath || "")) throw fail("COLLAB_TASK_LOCAL_MISSING");
      if (existing && target.rootPath !== existing.rootPath) throw fail("COLLAB_TASK_BINDING_CONFLICT");
      if (!existing) save({id,kind:"workspace-binding",conversationId,deviceId,sharedWorkspaceId:task.sharedWorkspaceId,...target});
      const local = await binding(command);
      save({...local,sharedWorkspaceId:task.sharedWorkspaceId,workspaceBindingId:id});
      return {ok:true,projectId:target.projectId,sessionId:target.sessionId};
    }
    // Completed materializations/undos are history, not recovery work; interrupted inverse attempts are.
    if (operation === "inventory" || operation === "materialize") {
      const task = await taskFor(command);
      if (task.assigneeUserId !== store.accountId) throw fail("COLLAB_TASK_ACCESS_DENIED");
      const local = read(`task:${task.id}`,conversationId);
      if (!local.workRoot || !local.gitBaseline) throw fail("COLLAB_TASK_LOCAL_MISSING");
      if (operation === "materialize") {
        const present=new Set(local.materializedPaths||[]),known=new Set(local.baseManifest.map(file=>file.path));
        const wanted=(command.paths||local.baseManifest.map(file=>file.path)).filter(name=>known.has(name)&&!present.has(name));
        if (command.paths && command.paths.some(name=>!known.has(name))) throw fail("COLLAB_TASK_INVALID");
        if (wanted.length) {
          const result = await git().materializePaths({baseline:local.gitBaseline,workRoot:local.workRoot,manifest:local.baseManifest,paths:wanted});
          await taskFor(command);read(local.id,conversationId);
          save({...local,materializedPaths:result.materializedPaths,baseFileIdentities:result.fileIdentities});
        }
      }
      return {ok:true,inventory:inventoryView(read(`task:${task.id}`,conversationId))};
    }
    if (operation === "recoveries") return {ok:true,applications:recoveries.list().filter(v=>v.journal && !["rolled_back","undone"].includes(v.state) && !(["materialization","inverse"].includes(v.kind)&&v.state==="applied")).map(v=>({
      conversationId:v.conversationId,taskId:v.taskId,applicationId:v.id,state:v.state,deliveryId:v.deliveryId,planHash:v.planHash,
      label:path.basename(v.input.rootPath),
    }))};
    if (operation === "drafts") {
      const all = records.list(conversationId);
      const localApplications = new Map(all.filter(v=>v.kind === "application").map(v=>[v.id,v]));
      for (const value of recoveries.list()) if (value.conversationId === conversationId && value.kind !== "inverse") localApplications.set(value.id,value);
      return {ok:true,drafts:all.filter(v=>v.kind === "draft" && !["completed","blocked"].includes(v.state) && !(v.taskId && v.state === "failed")).map(draftView),
        applications:[...localApplications.values()].sort((a,b)=>Number(!!a.journal)-Number(!!b.journal)||(a.createdAt||0)-(b.createdAt||0)).map(v=>({taskId:v.taskId,applicationId:v.id,state:v.state,deliveryId:v.deliveryId,planHash:v.planHash}))};
    }
    if (operation === "prepare") {
      records.list(conversationId); // authorization before showing native UI
      const scopeId = store.getConversation({conversationId}).scopeId;
      const assertAuthorized = () => {
        records.list(conversationId); // active account and current conversation authority
        if (store.getConversation({conversationId}).scopeId !== scopeId) throw fail("COLLAB_ACCESS_REVOKED");
      };
      let sourceRoot;
      const previous = command.draftId ? read(command.draftId,conversationId) : null;
      if (previous && (previous.kind !== "draft" || previous.taskId || previous.deviceId !== deviceId
        || !["preparing","preparation_failed"].includes(previous.state))) throw fail("COLLAB_TASK_INVALID");
      const projectId = previous?.sourceProjectId || command.projectId;
      if (projectId) {
        sourceRoot = await resolveProjectDirectory?.(projectId);
        assertAuthorized();
        if (typeof sourceRoot !== "string" || !path.isAbsolute(sourceRoot)
          || !fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) throw fail("COLLAB_TASK_LOCAL_MISSING");
      } else if (previous) {
        sourceRoot = previous.sourceRoot;
      } else {
        const selected = await chooseDirectory?.();
        assertAuthorized();
        if (selected?.canceled) return {ok:true,cancelled:true};
        if (selected?.filePaths?.length !== 1) throw fail();
        sourceRoot = selected.filePaths[0];
      }
      sourceRoot = fs.realpathSync(sourceRoot);
      if (previous && sourceRoot !== previous.sourceRoot) throw fail("COLLAB_TASK_LOCAL_MISSING");
      let sourceSessionId = previous?.sourceSessionId || command.sessionId;
      if (projectId && (resolveSourceSession || sourceSessionId)) {
        const source = await resolveSourceSession?.({projectId,sessionId:sourceSessionId});
        assertAuthorized();
        if (!source || source.projectId!==projectId || !source.sessionId || source.rootPath!==sourceRoot
          || (sourceSessionId && source.sessionId!==sourceSessionId)) throw fail("COLLAB_TASK_LOCAL_MISSING");
        sourceSessionId = source.sessionId;
      }
      let sharedWorkspaceId = previous?.sharedWorkspaceId;
      if (!previous && sharedWorkspaceProtocol === 1) {
        const id = `shared:${createHash("sha256").update(JSON.stringify([deviceId,conversationId,projectId || null,sourceRoot])).digest("hex")}`;
        const workspace = store.db.transaction(() => records.get(id) || records.put(id,{
          id,kind:"shared-workspace",conversationId,deviceId,sharedWorkspaceId:randomUUID(),sourceRoot,
          ...(projectId ? {sourceProjectId:projectId} : {}),
        }))();
        sharedWorkspaceId = workspace.sharedWorkspaceId;
      }
      const draft = await freeze(sourceRoot,conversationId,{...(projectId ? {sourceProjectId:projectId} : {}),
        ...(sourceSessionId ? {sourceSessionId} : {}),
        ...(sharedWorkspaceId ? {sharedWorkspaceId} : {})},assertAuthorized,previous);
      return {ok:true,draft:draftView(draft)};
    }
    if (operation === "send") {
      let draft = read(command.draftId,conversationId);
      if (draft.kind !== "draft" || draft.taskId && draft.state !== "completed") throw fail("COLLAB_TASK_INVALID");
      if (!draft.packageHash || !["prepared","uploading","confirming","completed","failed"].includes(draft.state)) throw fail("COLLAB_TASK_NOT_PREPARED");
      const input = Object.fromEntries(["assigneeUserId","title","objective","acceptanceCriteria"].map(key=>[key,command[key]]));
      if (draft.state === "failed") draft = save({...draft,input:null,clientCommandId:randomUUID(),uncertain:false,
        ...(draft.code === "COLLAB_TASK_PACKAGE_UNAVAILABLE" ? {transferId:null,objectId:null} : {})});
      if (draft.input && JSON.stringify(draft.input) !== JSON.stringify(input)) throw fail("IDEMPOTENCY_KEY_REUSED");
      if (draft.deviceId !== deviceId) throw fail("COLLAB_DEVICE_CHANGED");
      if (draft.state === "completed") return {ok:true,state:"completed",taskId:draft.taskId,draftId:draft.id};
      if (draft.sharedWorkspaceId && sharedWorkspaceProtocol !== 1) throw fail("COLLAB_TASK_PROTOCOL_UNAVAILABLE");
      if (!draft.gitBaseline) {
        const gitBaseline = await git().captureBaseline({taskId:draft.id,snapshotRoot:draft.snapshotRoot,manifest:draft.manifest});
        read(draft.id,conversationId);
        draft = save({...draft,gitBaseline});
      }
      draft = await wireBundle(draft,draft.gitBaseline);
      draft = save({...draft,input,state:"uploading"});
      draft = await upload(draft);
      const priorUncertain = draft.uncertain === true;
      draft = save({...draft,state:"confirming",uncertain:true});
      let result;
      try {
        result = requireOk(await client.submitTask({...input,conversationId,action:"create",inputSnapshotId:draft.objectId,deviceId,clientCommandId:draft.clientCommandId,
          ...(draft.sharedWorkspaceId ? {sharedWorkspaceId:draft.sharedWorkspaceId} : {}),
          ...(draft.wireBundle ? {inputGit:draft.wireBundle.descriptor} : {})})).result;
        if (!result?.taskId || result.state !== "offered" || result.revision !== 1) throw fail("COLLAB_RESPONSE_UNKNOWN");
      } catch (error) {
        read(draft.id,conversationId);
        if (!priorUncertain && /^COLLAB_TASK_(SELF_ASSIGNMENT|ACCESS_DENIED|INVALID|INPUT_UNVERIFIED|PACKAGE_UNAVAILABLE)$|^IDEMPOTENCY_KEY_REUSED$/.test(error.code || "")) {
          save({...draft,state:"failed",code:error.code,uncertain:false});
          return {ok:true,state:"failed",draftId:draft.id,code:error.code};
        }
        return {ok:true,state:"confirming",draftId:draft.id,code:"COLLAB_RESPONSE_UNKNOWN"};
      }
      read(draft.id,conversationId);
      if (draft.wireBundle) rememberGitObject({conversationId,taskId:result.taskId},draft.objectId,draft.wireBundle.descriptor);
      save({id:`task:${result.taskId}`,kind:"task",conversationId,taskId:result.taskId,sourceRoot:draft.sourceRoot,
        ...(draft.sourceProjectId ? {sourceProjectId:draft.sourceProjectId} : {}),
        ...(draft.sourceSessionId ? {sourceSessionId:draft.sourceSessionId} : {}),
        ...(draft.sharedWorkspaceId ? {sharedWorkspaceId:draft.sharedWorkspaceId} : {}),
        snapshotRoot:draft.snapshotRoot,baseManifest:draft.manifest,gitBaseline:draft.gitBaseline});
      save({...draft,taskId:result.taskId,taskState:result.state,taskRevision:result.revision,state:"completed"});
      return {ok:true,state:"completed",taskId:result.taskId,draftId:draft.id};
    }
    if (operation === "receive") { await receive(command); return {ok:true,state:"ready"}; }
    if (operation === "open") {
      const task = await taskFor(command);
      let target;
      if (command.deliveryId) target = (await delivery(command)).snapshotRoot;
      else if (task.assigneeUserId === store.accountId) target = (await receive(command)).workRoot;
      else target = (await binding(command)).sourceRoot;
      if (!target || !openWorkspace) throw fail("COLLAB_TASK_LOCAL_MISSING");
      const current = await taskFor(command);
      await transfers?.taskFiles?.markOwned?.(current);
      records.list(conversationId);
      let local = await binding(command);
      if (!local.workspaceBindingId && current.sharedWorkspaceId) {
        const workspace=records.get(workspaceBindingId(current));
        if (workspace && workspace.conversationId===conversationId) local=save({...local,workspaceBindingId:workspace.id});
      }
      if (local.workspaceBindingId) {
        const workspace = read(local.workspaceBindingId,conversationId);
        const resolved = resolveWorkspaceBinding?.({projectId:workspace.projectId,sessionId:workspace.sessionId,
          bindingId:workspace.id,title:task.title});
        if (!resolved || resolved.rootPath !== workspace.rootPath || resolved.sessionId !== workspace.sessionId)
          throw fail("COLLAB_TASK_BINDING_CONFLICT");
        if (!command.deliveryId && task.requesterUserId === store.accountId)
          return {ok:true,projectId:workspace.projectId,sessionId:workspace.sessionId};
        return {ok:true,...await openWorkspace({rootPath:target,projectId:workspace.projectId,title:task.title,
          bindingId:`${store.accountId}:${task.id}:${command.deliveryId || "execution"}`})};
      }
      return {ok:true,...await openWorkspace({rootPath:target,title:task.title,bindingId:`${task.id}:${command.deliveryId || store.accountId}`})};
    }
    if (operation === "prepareDelivery") {
      const task = await taskFor(command), local = await receive(command);
      let draft = await freeze(local.workRoot,conversationId,{taskId:task.id,expectedRevision:task.revision,inputSnapshotId:task.inputSnapshotId,
        transport:task.inputGit?"git":"zip"});
      // Omission by a secret/size filter is not a collaborator's deletion.
      const delivered = new Set(draft.manifest.map(file=>file.path));
      const omitted = relative => {
        const parts = relative.split("/"); let current = local.workRoot;
        for (let index = 0; index < parts.length; index++) {
          current = path.join(current,parts[index]);
          let stat;
          try { stat = fs.lstatSync(current); }
          catch (error) { if (error.code === "ENOENT") return false; throw error; }
          // Never walk through unsupported links when deciding deletion.
          if (stat.isSymbolicLink()) return true;
          if (index === parts.length - 1) return !stat.isDirectory();
          if (!stat.isDirectory()) {
            // A delivered file replacing an ancestor directory explicitly
            // removes its former children; an omitted ancestor cannot do so.
            return !stat.isFile() || !delivered.has(parts.slice(0,index + 1).join("/"));
          }
        }
        return false;
      };
      if (local.baseManifest.some(file=>!delivered.has(file.path) && omitted(file.path))) {
        save({...draft,state:"blocked"});
        throw fail("COLLAB_TASK_DELIVERY_OMITTED");
      }
      draft = save({...draft,deliveryValidated:true});
      draft = await contribution(draft);
      await wireBundle(draft,draft.gitContribution,draft.gitContribution.baseCommit);
      return {ok:true,draft:draftView(draft)};
    }
    if (operation === "submitDelivery") {
      let draft = read(command.draftId,conversationId);
      if (draft.taskId !== command.taskId || draft.kind !== "draft") throw fail("COLLAB_TASK_INVALID");
      if (draft.state === "blocked") throw fail("COLLAB_TASK_DELIVERY_OMITTED");
      if (draft.deviceId !== deviceId) throw fail("COLLAB_DEVICE_CHANGED");
      if (draft.state === "completed") return {ok:true,state:"completed",clientCommandId:draft.clientCommandId};
      draft = await contribution(draft);
      draft = await wireBundle(draft,draft.gitContribution,draft.gitContribution.baseCommit);
      draft = await upload(draft);
      const result = await tasks.submit({conversationId,taskId:command.taskId,action:"submit",expectedRevision:draft.expectedRevision,
        deliveryId:draft.objectId,clientCommandId:draft.clientCommandId},draft.wireBundle?.descriptor);
      read(draft.id,conversationId);
      if (result.state==="completed" && draft.wireBundle) rememberGitObject(command,draft.objectId,draft.wireBundle.descriptor);
      if (result.ok) save({...draft,state:result.state});
      return result;
    }
    if (operation === "preview") {
      const task = await taskFor(command);
      if (task.requesterUserId !== store.accountId || task.state !== "accepted" || task.acceptedDeliveryId !== command.deliveryId) throw fail("COLLAB_TASK_STATE_CONFLICT");
      const previous = recoveries.list().filter(v=>v.kind!=="materialization"&&v.conversationId === conversationId && v.taskId === task.id && v.journal && v.state !== "rolled_back").sort((a,b)=>(b.createdAt||0)-(a.createdAt||0))[0];
      if (previous) {
        if (previous.state !== "applied") throw fail("COLLAB_TASK_APPLICATION_RECOVERY_REQUIRED");
        return {ok:true,applicationId:previous.id,planHash:previous.planHash,plan:previous.journal.plan};
      }
      let local = await binding(command);
      if (!local.sourceRoot) {
        const selected = await chooseDirectory?.();
        if (selected?.canceled) return {ok:true,cancelled:true};
        if (selected?.filePaths?.length !== 1) throw fail();
        const input = await download(command,task.inputSnapshotId);
        local = save({...local,sourceRoot:fs.realpathSync(selected.filePaths[0]),baseManifest:input.manifest,snapshotRoot:input.snapshotRoot});
      }
      const proposed = await delivery(command), id = randomUUID();
      // Explicit folder grant + the exact preview authorize additions too.
      const editablePaths = [...new Set([...local.baseManifest,...proposed.manifest].map(v=>v.path))];
      let record = save({id,kind:"application",state:"preview",createdAt:Date.now(),conversationId,taskId:task.id,deliveryId:command.deliveryId,
        input:{applicationId:id,rootPath:local.sourceRoot,deliveryRoot:proposed.snapshotRoot,baseManifest:local.baseManifest,deliveryManifest:proposed.manifest,editablePaths}});
      const result = await application(record).preview(record.input);
      record = save({...record,planHash:result.planHash});
      return {...result,applicationId:id};
    }
    if (operation === "apply" || operation === "rollback") {
      const record = operation === "rollback" ? recoveries.get(command.applicationId) : read(command.applicationId,conversationId);
      if (!record || record.conversationId !== conversationId) throw fail("COLLAB_TASK_LOCAL_MISSING");
      if ((record.kind !== "application" && !(operation==="rollback"&&["materialization","inverse"].includes(record.kind))) || record.taskId !== command.taskId || (operation === "apply" && record.deliveryId !== command.deliveryId)) throw fail("COLLAB_TASK_INVALID");
      if (operation === "rollback" && record.kind === "materialization") return undo().undo(record.id);
      if (operation === "rollback" && record.kind === "inverse") return undo().recover(record.id);
      if (operation === "rollback") return application(record,true).recover({applicationId:record.id,mode:"rollback"});
      return application(record).apply({...record.input,expectedPlanHash:command.expectedPlanHash,confirmDeletions:command.confirmDeletions});
    }
    throw fail("COLLAB_TASK_INVALID");
  }

  return execute;
}

module.exports = { createTaskOperations };
