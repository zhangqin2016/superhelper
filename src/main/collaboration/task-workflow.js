"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { createTaskRecords } = require("./task-records");
const { freezeTaskBundle, unpackTaskBundle } = require("./task-bundle");
const { createTaskApplication } = require("./task-application");
const {taskWorkflowCommand} = require("./task-workflow-view");
const {createTaskRecovery} = require("./task-recovery");
const fail = (code = "COLLAB_TASK_UNAVAILABLE") => Object.assign(new Error(code), { code });
const requireOk = value => { if (!value?.ok) throw fail(value?.code); return value; };

/** Main-only orchestration. Renderer supplies identities and consent, never paths.
 * Upload identity, frozen bytes and original device survive ambiguous responses.
 * Imported workspaces are data: no dependency, hook or engine is auto-started. */
function createTaskWorkflow({ store, client, tasks, transfers, deviceId, assertActive, rootPath, chooseDirectory, resolveProjectDirectory, resolveSourceSession,
  openWorkspace, resolveWorkspaceBinding, resolveCardSession, listWorkspaceBindings, sharedWorkspaceProtocol, taskGitProtocol, sharedPublicationProtocol, integrationValidationAvailable=false, chooseValidationChecks, writerLockPath, localApplicationWriter, onChange = () => {}, bundle = { freezeTaskBundle, unpackTaskBundle },
  repairCompletion = () => { try { return require("../model-direct-completion").createDirectCompletion(); } catch { return null; } } }) {
  const records = createTaskRecords({ store, assertActive });
  const checkPolicies=require("./integration-check-policy").createIntegrationCheckPolicy({store,assertActive});
  const checkSelection=require("./integration-check-selection");
  const cards = require("./task-cards").createTaskCards({store,assertActive});
  const recoveries = createTaskRecovery({store,assertActive});
  const running = new Map();
  const preparing = new Set();
  let taskGit;
  const git = () => taskGit || (taskGit = new (require("./task-git").TaskGit)({rootPath:path.join(root(),"git")}));
  const workspaceBindingId = task => `workspace-binding:${createHash("sha256").update(JSON.stringify([store.accountId,deviceId,task.sharedWorkspaceId])).digest("hex")}`;
  function root() {
    assertActive();
    if (!rootPath) throw fail();
    const account = createHash("sha256").update(store.accountId).digest("hex");
    const target = path.join(rootPath, account);
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    return fs.realpathSync(target);
  }
  const allocate = () => path.join(root(), randomUUID());
  function notify() { try { onChange(); } catch { /* persisted state remains authoritative */ } }
  function save(value) { const saved = records.put(value.id, value); notify(); return saved; }
  function read(id, conversationId) {
    const value = records.get(id);
    if (!value || value.conversationId !== conversationId) throw fail("COLLAB_TASK_LOCAL_MISSING");
    return value;
  }
  const gitObjectKey = (taskId,objectId) => `git-object:${createHash("sha256").update(JSON.stringify([taskId,objectId])).digest("hex")}`;
  const sameGitDescriptor = (a,b) => a && b && ["version","format","ref","commit","sha256","sizeBytes"].every(key=>a[key]===b[key])
    && JSON.stringify(a.prerequisites)===JSON.stringify(b.prerequisites);
  function rememberGitObject(command,objectId,descriptor) {
    const id=gitObjectKey(command.taskId,objectId),previous=records.get(id);
    if (previous && (previous.conversationId!==command.conversationId || !sameGitDescriptor(previous.descriptor,descriptor))) throw fail("COLLAB_TASK_INVALID");
    save({id,kind:"git-object",conversationId:command.conversationId,taskId:command.taskId,objectId,descriptor});
  }
  async function taskFor(command) {
    const { task } = requireOk(await tasks.get(command));
    if (["cancelled", "declined"].includes(task.state)) throw fail("COLLAB_TASK_ACCESS_DENIED");
    return task;
  }
  // Unresolved conflicts are repaired by the requester's configured model with
  // the task goal and the requester's own answers as evidence. No model means
  // the conflict stays visible; nothing is ever approved by a model alone.
  const answersId=intentId=>`integration-answers:${createHash("sha256").update(JSON.stringify(intentId)).digest("hex")}`;
  async function repairContextFor(input){
    await authorizeIntegration(input);
    const intentId=require("./integration-intents").integrationIntentId(input);
    const card=records.get(`task-card:${input.taskId}`)?.task;
    const task=card&&card.conversationId===input.conversationId?card:(await taskFor({conversationId:input.conversationId,taskId:input.taskId}));
    const goal={title:task?.title||"",objective:task?.objective||"",acceptanceCriteria:task?.acceptanceCriteria||""};
    const stored=records.get(answersId(intentId));
    const answers=stored?.kind==="integration-answers"&&stored.intentId===intentId?stored.answers:[];
    let completion=null;try{completion=repairCompletion?.()||null;}catch{completion=null;}
    return {goal,answers,answersHash:answers.length?createHash("sha256").update(JSON.stringify(answers.map(a=>[a.path,a.answer]))).digest("hex"):null,
      complete:completion?.available?completion.complete:null};
  }
  // The project's own installed dependencies, exposed read-only to pinned
  // checks. Absent or aliased directories mean checks needing packages wait.
  function dependencyRoot(sourceRoot){
    try{
      const target=path.join(sourceRoot,"node_modules"),stat=fs.lstatSync(target);
      return stat.isDirectory()&&!stat.isSymbolicLink()&&fs.realpathSync(target)===target?target:null;
    }catch{return null;}
  }
  async function authorizeIntegration(input) {
    if(taskGitProtocol!==1)throw fail("COLLAB_TASK_PROTOCOL_UNAVAILABLE");
    const task=await taskFor({conversationId:input.conversationId,taskId:input.taskId});
    const delivery=task.deliveries.find(item=>item.id===input.deliveryId);
    if(input.chain!=="shared" || task.requesterUserId!==store.accountId || task.sharedWorkspaceId!==input.workspaceId
      || !["review","accepted"].includes(task.state) || task.currentDeliveryId!==input.deliveryId
      || task.inputGit?.commit!==input.baselineCommit || delivery?.git?.commit!==input.deliveryCommit)throw fail("COLLAB_TASK_ACCESS_DENIED");
    const source=read(`task:${task.id}`,task.conversationId);
    if(source.sourceProjectId!==input.projectId || source.sourceSessionId!==input.sessionId
      || source.sharedWorkspaceId!==input.workspaceId || source.gitBaseline?.commit!==input.baselineCommit)throw fail("COLLAB_TASK_BINDING_CONFLICT");
    const session=resolveSourceSession?.({projectId:input.projectId,sessionId:input.sessionId});
    assertActive();
    if(!session || session.projectId!==input.projectId || session.sessionId!==input.sessionId || session.rootPath!==source.sourceRoot
      || fs.realpathSync(source.sourceRoot)!==source.sourceRoot || !fs.statSync(source.sourceRoot).isDirectory()
      || createHash("sha256").update(source.sourceRoot).digest("hex")!==input.targetId)throw fail("COLLAB_TASK_BINDING_CONFLICT");
    return task;
  }
  async function acquireIntegrationInput(input) {
    await ready;await authorizeIntegration(input);
    await download({conversationId:input.conversationId,taskId:input.taskId},input.deliveryId,true);
    const task=await authorizeIntegration(input),{repository}=await git().ensure();
    assertActive();
    return {taskGit:git(),baseline:{...task.inputGit,repository},delivery:{...task.deliveries.find(item=>item.id===input.deliveryId).git,repository}};
  }
  function draftView(value) {
    return { id:value.id, name:value.name, files:value.files, warnings:value.warnings, omitted:value.omitted,
      state:value.state, ...(value.input ? { input:value.input } : {}), ...(value.taskId ? {taskId:value.taskId} : {}) };
  }
  async function freeze(sourceRoot, conversationId, extras = {}, assertAuthorized = assertActive, previous = null) {
    const id = previous?.id || randomUUID();
    if (preparing.has(id)) throw fail("COLLAB_TASK_BUSY");
    preparing.add(id);
    try {
      const pending = save({ ...previous, ...extras, id, conversationId, sourceRoot, name:path.basename(sourceRoot),
        transport:extras.transport || (previous ? previous.transport || "zip" : !extras.taskId && taskGitProtocol===1 ? "git" : "zip"),
        kind:"draft", state:"preparing", createdAt:previous?.createdAt || Date.now(), deviceId,
        clientCommandId:previous?.clientCommandId || randomUUID() });
      try {
        const result = await bundle.freezeTaskBundle({ sourceRoot, destinationRoot:allocate(), name:path.basename(sourceRoot),allowEmpty:Boolean(extras.taskId) });
        assertAuthorized();
        const packageBytes = fs.readFileSync(result.packagePath);
        return save({ ...pending, ...result,
          packageHash:createHash("sha256").update(packageBytes).digest("hex"),packageSize:packageBytes.length,
          state:"prepared" });
      } catch (error) {
        // Revoked/account-switched records cannot be republished by a late callback.
        assertAuthorized();
        save({ ...pending, state:"preparation_failed" });
        throw error;
      }
    } finally { preparing.delete(id); }
  }
  async function upload(draft) {
    if (!transfers?.taskFiles) throw fail();
    if (!draft.transferId) {
      const stat = fs.lstatSync(draft.packagePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== draft.packageSize
        || createHash("sha256").update(fs.readFileSync(draft.packagePath)).digest("hex") !== draft.packageHash) throw fail("COLLAB_TASK_BUNDLE_CHANGED");
      const wire = draft.wireBundle;
      const transfer = requireOk(await transfers.taskFiles.prepareUpload({ conversationId:draft.conversationId,
        inputPath:wire?.packagePath || draft.packagePath, originalName:wire ? `${draft.name}.bundle` : `${draft.name}.lilyspace.zip`,
        expectedPlaintextSha256:wire?.descriptor.sha256 || draft.packageHash }));
      draft = save({ ...draft, transferId:transfer.id });
    }
    const uploaded = requireOk(await transfers.taskFiles.upload(draft.transferId));
    if (!["verified", "bound"].includes(uploaded.state) || !uploaded.objectId) throw fail("COLLAB_TRANSFER_NOT_READY");
    return save({ ...draft, objectId:uploaded.objectId });
  }
  async function download(command, objectId, allowEmpty = false) {
    const task = await taskFor(command);
    if (task.inputGit) {
      if (taskGitProtocol!==1 || !client.missingTaskGitObjects) throw fail("COLLAB_TASK_PROTOCOL_UNAVAILABLE");
      const required=[{objectId:task.inputSnapshotId,descriptor:task.inputGit}];
      if (objectId!==task.inputSnapshotId) {
        const selected=task.deliveries.find(item=>item.id===objectId);
        if (!selected?.git) throw fail("COLLAB_TASK_DELIVERY_CONFLICT");
        required.push({objectId,descriptor:selected.git});
      }
      const haveCommits=[];
      for (const item of required) {
        const proof=records.get(gitObjectKey(task.id,item.objectId));
        if (proof?.conversationId===command.conversationId && proof.taskId===task.id && proof.objectId===item.objectId
          && sameGitDescriptor(proof.descriptor,item.descriptor) && await git().hasRevision(item.descriptor)) haveCommits.push(item.descriptor.commit);
      }
      const missing=await client.missingTaskGitObjects({deviceId,taskId:task.id,...(objectId!==task.inputSnapshotId?{deliveryId:objectId}:{}),haveCommits});
      await taskFor(command);
      const expected=required.filter(item=>!haveCommits.includes(item.descriptor.commit));
      if (!Array.isArray(missing?.objects) || missing.objects.length!==expected.length
        || new Set(missing.objects.map(item=>item.objectId)).size!==expected.length) throw fail("COLLAB_TASK_INVALID");
      for (const item of expected) {
        const returned=missing.objects.find(value=>value.objectId===item.objectId);
        if (!returned || !sameGitDescriptor(returned.descriptor,item.descriptor)) throw fail("COLLAB_TASK_INVALID");
        const file=requireOk(await transfers.taskFiles.download({...command,objectId:item.objectId}));
        await taskFor(command);
        await require("./task-git-transport").createTaskGitTransport(git()).importBundle({packagePath:file.packagePath,descriptor:item.descriptor});
        await taskFor(command);
        rememberGitObject(command,item.objectId,item.descriptor);
      }
      await taskFor(command);
      const snapshot=await git().materializeSnapshot({revision:required.at(-1).descriptor,destinationRoot:allocate(),
        ...(objectId!==task.inputSnapshotId?{parentCommit:task.inputGit.commit}:{})});
      if (!allowEmpty && !snapshot.manifest.length) throw fail("COLLAB_TASK_BUNDLE_EMPTY");
      await taskFor(command);
      return {...snapshot,...(objectId===task.inputSnapshotId?{gitBaseline:snapshot.gitRevision}:{})};
    }
    const file = requireOk(await transfers.taskFiles.download({ ...command, objectId }));
    assertActive();
    const value = await bundle.unpackTaskBundle({ packagePath:file.packagePath, destinationRoot:allocate(),allowEmpty });
    await taskFor(command);
    return value;
  }
  async function binding(command) {
    let value = records.get(`task:${command.taskId}`);
    if (value && value.conversationId !== command.conversationId) throw fail("COLLAB_TASK_ACCESS_DENIED");
    if (!value) value = save({id:`task:${command.taskId}`,kind:"task",conversationId:command.conversationId,taskId:command.taskId});
    return value;
  }
  async function receive(command) {
    const task = await taskFor(command);
    if (task.assigneeUserId !== store.accountId || !["active","changes_requested"].includes(task.state)) throw fail("COLLAB_TASK_STATE_CONFLICT");
    await transfers?.taskFiles?.markOwned?.(task);
    let local = await binding(command);
    if (task.sharedWorkspaceId && !local.workspaceBindingId) {
      const workspace = records.get(workspaceBindingId(task));
      if (!workspace || workspace.conversationId !== command.conversationId) throw fail("COLLAB_TASK_BINDING_REQUIRED");
      local = save({...local,sharedWorkspaceId:task.sharedWorkspaceId,workspaceBindingId:workspace.id});
    }
    if (!local.workRoot) {
      if (!local.snapshotRoot) {
        const input = await download(command, task.inputSnapshotId);
        local = save({...local,baseManifest:input.manifest,snapshotRoot:input.snapshotRoot,...(input.gitBaseline?{gitBaseline:input.gitBaseline}:{})});
      }
      if (!local.gitBaseline) {
        const gitBaseline = await git().captureBaseline({taskId:task.id,snapshotRoot:local.snapshotRoot,manifest:local.baseManifest});
        await taskFor(command);
        local = save({...local,gitBaseline,executionRoot:allocate()});
      }
      if (!local.executionRoot) local=save({...local,executionRoot:allocate()});
      // Inventory first, content by policy: large trees bring only files under
      // the lazy threshold to disk; the rest stay online-only entries that the
      // requester or an agent materializes on demand. Absence is never a deletion.
      const lazy=lazyMaterialization(local.baseManifest);
      const worktree = await git().ensureWorktree({baseline:local.gitBaseline,workRoot:local.executionRoot,manifest:local.baseManifest,materializePaths:lazy});
      await taskFor(command);
      local = save({...local,workRoot:local.executionRoot,materializedPaths:worktree.materializedPaths,baseFileIdentities:worktree.fileIdentities});
    } else if (local.gitBaseline) {
      await git().ensureWorktree({baseline:local.gitBaseline,workRoot:local.workRoot,manifest:local.baseManifest});
      await taskFor(command);
    }
    return local;
  }
  // Lazy materialization thresholds are operator policy read per receive.
  function lazyMaterialization(manifest){
    const setting=(name,fallback)=>{const value=Number(process.env[name]);return Number.isSafeInteger(value)&&value>0?value:fallback;};
    const total=manifest.reduce((sum,file)=>sum+file.sizeBytes,0);
    if(total<=setting("LILY_COLLAB_LAZY_BYTES",64*1024*1024)&&manifest.length<=setting("LILY_COLLAB_LAZY_FILES",5000))return null;
    const perFile=setting("LILY_COLLAB_LAZY_FILE_BYTES",8*1024*1024);
    return manifest.filter(file=>file.sizeBytes<=perFile).map(file=>file.path);
  }
  function inventoryView(local){
    const present=new Set(local.materializedPaths||local.baseManifest.map(file=>file.path));
    const files=local.baseManifest.map(file=>({path:file.path,sizeBytes:file.sizeBytes,state:present.has(file.path)?"local":"remote"}));
    const remote=files.filter(file=>file.state==="remote");
    return {files:[...remote,...files.filter(file=>file.state==="local")].slice(0,2000),truncated:files.length>2000,
      counts:{total:files.length,local:files.length-remote.length,remote:remote.length,remoteBytes:remote.reduce((sum,file)=>sum+file.sizeBytes,0)}};
  }
  async function contribution(draft) {
    if (draft.gitContribution) return draft;
    if (draft.deliveryValidated !== true) throw fail("COLLAB_TASK_DELIVERY_NOT_VALIDATED");
    let local = read(`task:${draft.taskId}`,draft.conversationId);
    if (!local.gitBaseline?.manifestHash) {
      const gitBaseline = await git().captureBaseline({taskId:draft.taskId,snapshotRoot:local.snapshotRoot,manifest:local.baseManifest});
      read(local.id,draft.conversationId);
      local = save({...local,gitBaseline});
    }
    // Existing ZIP task copies were completely materialized at receive time;
    // Git-protocol copies carry their exact inventory, which may be sparse.
    // A legacy full-ZIP delivery cannot represent sparse input.
    const materializedPaths = local.materializedPaths || local.baseManifest.map(file=>file.path);
    if (draft.transport !== "git" && materializedPaths.length !== local.baseManifest.length) throw fail("COLLAB_TASK_PROTOCOL_UNAVAILABLE");
    const gitContribution = await git().captureContribution({baseline:local.gitBaseline,baseManifest:local.baseManifest,
      materializedPaths,deliveryId:draft.id,snapshotRoot:draft.snapshotRoot,manifest:draft.manifest,
      baseFileIdentities:local.baseFileIdentities,fileIdentities:draft.fileIdentities});
    await taskFor({conversationId:draft.conversationId,taskId:draft.taskId});
    read(draft.id,draft.conversationId);
    return save({...draft,gitContribution});
  }
  async function wireBundle(draft,revision,parentCommit) {
    if (draft.transport!=="git") return draft;
    if (taskGitProtocol!==1) throw fail("COLLAB_TASK_PROTOCOL_UNAVAILABLE");
    if (draft.wireBundle) return draft;
    const wireBundle=await require("./task-git-transport").createTaskGitTransport(git()).exportBundle({revision,
      prerequisites:parentCommit?[parentCommit]:[],destination:`${allocate()}.bundle`});
    read(draft.id,draft.conversationId);
    return save({...draft,wireBundle});
  }
  async function delivery(command) {
    const task = await taskFor(command);
    if (!task.deliveries.some(item => item.id === command.deliveryId)) throw fail("COLLAB_TASK_DELIVERY_CONFLICT");
    let local = await binding(command);
    const cached = local.deliveries?.[command.deliveryId];
    if (cached) {
      for (const file of cached.manifest) {
        const target = path.join(cached.snapshotRoot,file.path), stat = fs.lstatSync(target);
        if (!stat.isFile() || stat.nlink !== 1 || fs.realpathSync(target) !== target || stat.size !== file.sizeBytes
          || createHash("sha256").update(fs.readFileSync(target)).digest("hex") !== file.sha256) throw fail("COLLAB_TASK_BUNDLE_CHANGED");
      }
      return cached;
    }
    const result = await download(command, command.deliveryId, true);
    save({...local,deliveries:{...local.deliveries,[command.deliveryId]:result}});
    return result;
  }
  // Successful materializations are undone through their contribution inverse,
  // never by whole-file rollback that would erase later edits.
  const localWriter=()=>localApplicationWriter||require("./local-writer").createLocalWriter({filePath:writerLockPath});
  const undo=()=>require("./local-contribution-undo").createLocalContributionUndo({store,writer:localWriter(),assertActive,
    journalRoot:path.join(root(),"recovery"),destinationRoot:path.join(root(),"local-undo")});
  function application(record, localRecovery = false) {
    if(record.kind==="materialization"&&["applied","undone"].includes(record.state))throw fail("COLLAB_LOCAL_APPLICATION_INVERSE_REQUIRED");
    if(record.kind==="inverse")throw fail("COLLAB_TASK_INVALID");
    const journalRoot = path.join(root(), "recovery");
    fs.mkdirSync(journalRoot,{recursive:true,mode:0o700});
    return createTaskApplication({ journalRoot:fs.realpathSync(journalRoot),
      writer:localWriter(),
      journal:{ get:() => recoveries.get(record.id)?.journal || null, put:(_id,journal) => {
        const live = recoveries.get(record.id) || record;
        const next = {...live,journal,state:journal.state};
        recoveries.put(record.id,next);
        // Remote access may disappear; it must not erase recovery of OWN files.
        try { if (records.get(record.id)) save(next); } catch (error) {
          if (!localRecovery) throw error;
        }
      } },
      assertAuthorized:async () => {
        assertActive();
        if (localRecovery) { if (!recoveries.get(record.id)) throw fail("COLLAB_TASK_LOCAL_MISSING"); return; }
        const task = await taskFor(record);
        if (task.requesterUserId !== store.accountId || task.state !== "accepted" || task.acceptedDeliveryId !== record.deliveryId) throw fail("COLLAB_TASK_ACCESS_DENIED");
        read(record.id,record.conversationId);
      },
    });
  }
  const execute = require("./task-workflow-operations").createTaskOperations({
    answersId, application, authorizeIntegration, binding, cards, checkPolicies, checkSelection, contribution, delivery, download, draftView, freeze, git, inventoryView, notify, read, records, recoveries, rememberGitObject, save, taskFor, undo, upload, wireBundle, workspaceBindingId, receive, fail, requireOk, assertActive, chooseDirectory, chooseValidationChecks, client, deviceId, integrationValidationAvailable, listWorkspaceBindings, openWorkspace, resolveCardSession, resolveProjectDirectory, resolveSourceSession, resolveWorkspaceBinding, rootPath, sharedWorkspaceProtocol, store, tasks, transfers,
  });
  // Incomplete local writes recover without a network or Team membership grant.
  // Matching hashes are still mandatory; later user edits become conflicts.
  async function recoverLocalWrites(){
    for (const record of recoveries.list()) {
      if (!record.journal || ["applied","rolled_back","undone"].includes(record.state)) continue;
      try {
        if (record.kind === "inverse") await undo().recover(record.id);
        else await application(record,true).recover({applicationId:record.id,mode:"rollback"});
      }
      catch { /* durable record remains available; never report it as applied */ }
    }
  }
  const ready=Promise.resolve().then(recoverLocalWrites);
  return {recoverPending:()=>ready,acquireIntegrationInput,
    localApplicationStatus(intentId){
      if(sharedPublicationProtocol!==1||!localApplicationWriter)return {state:"disabled"};
      const job=records.get(require("./local-materialization").localMaterializationJobId(intentId));
      if(job?.state==="applied")return {state:"applied"};
      if(job?.state==="undone")return {state:"undone"};
      if(["conflicts","failed","baseline_required"].includes(job?.state)||["failed","required"].includes(job?.validation?.state)
        ||(job?.applicationId&&recoveries.get(job.applicationId)?.state==="recovery_conflict"))return {state:"required"};
      try{return {state:"pending",ready:localApplicationWriter.run(()=>true)};}
      catch(error){if(error.code==="COLLAB_TASK_APPLICATION_BUSY")return {state:"pending",ready:false};throw error;}
    },
    async prepareIntegrationLocal({intentId,assertCurrent}){
      if(sharedPublicationProtocol!==1)return null;
      const guard=()=>{assertActive();assertCurrent();};guard();
      await ready;await recoverLocalWrites();guard();
      const intent=require("./integration-intents").createIntegrationIntents({store,assertActive:guard}).get(intentId);
      if(intent?.state!=="completed")throw fail("COLLAB_LOCAL_MATERIALIZATION_PUBLICATION_REQUIRED");
      const input=intent.input,source=read(`task:${input.taskId}`,input.conversationId);
      const published=records.get(`shared-publication:${createHash("sha256").update(JSON.stringify(intentId)).digest("hex")}`);
      const repairContext=await repairContextFor(input);guard();
      const repairer=repairContext.complete?require("./conflict-repair").createConflictRepair({complete:repairContext.complete}):null;
      const repair=repairer?{answersHash:repairContext.answersHash,resolve:async({files})=>{guard();const outcome=await repairer.repair({kind:"merge",goal:repairContext.goal,answers:repairContext.answers,files});guard();return outcome;}}:null;
      const local=require("./local-materialization").createLocalMaterialization({store,taskGit:git(),rootPath:path.join(root(),"local-materialization"),
        deviceId,assertActive:guard,authorize:async value=>{await authorizeIntegration(value);guard();return true;},repair});
      const result=await local.prepare({intentId,input,localRoot:source.sourceRoot,baseline:source.gitBaseline,published});guard();notify();
      if(result.state==="ready"){
        const validator=require("./local-candidate-validation").createLocalCandidateValidation({store,rootPath:path.join(root(),"local-validation-git"),assertActive:guard,dependencyRoot:dependencyRoot(source.sourceRoot),
          getPolicy:value=>checkPolicies.current(value,checkSelection.sourceIdentity(source.sourceRoot))});
        const validation=await validator.validate({job:result,input});guard();notify();
        // Main-owned admission must fence foreground writers across profiles.
        // The existing broker-only lock is deliberately not a default here.
        if(validation.state==="passed"&&localApplicationWriter){
          const application=require("./local-materialization-application").createLocalMaterializationApplication({store,writer:localApplicationWriter,
            journalRoot:path.join(root(),"recovery"),assertActive:guard,authorize:async value=>{await authorizeIntegration(value);guard();return true;},
            getPolicy:value=>checkPolicies.current(value,checkSelection.sourceIdentity(source.sourceRoot))});
          try{
            const applied=await application.apply({job:local.get(intentId),input});guard();notify();
            return {...applied,validationState:validation.state};
          }catch(error){
            guard();
            if(["COLLAB_TASK_APPLICATION_BUSY","COLLAB_LOCAL_APPLICATION_STALE_WORKSPACE","COLLAB_TASK_APPLICATION_PREVIEW_CHANGED","COLLAB_TASK_APPLICATION_LOCKED"].includes(error.code))return {state:"waiting",validationState:validation.state};
            throw error;
          }
        }
        return {state:result.state,validationState:validation.state};
      }
      return {state:result.state};
    },
    createIntegrationRemote({input,intentId,taskGit,assertCurrent,authorize}){
      if(sharedPublicationProtocol!==1)return null;
      return require('./remote-publication').createRemotePublication({store,taskGit,client,transfers,deviceId,input,intentId,
        assertActive:assertCurrent,assertAccountActive:assertActive,authorize});
    },
    async acquireIntegrationHead(input,{assertCurrent=assertActive}={}){
      assertCurrent();const context=await acquireIntegrationInput(input);assertCurrent();
      const sync=require('./shared-head-sync').createSharedHeadSync({taskGit:context.taskGit,client,sharedFiles:transfers.sharedFiles,
        accountId:store.accountId,deviceId,assertActive:assertCurrent,authorize:async()=>{await authorizeIntegration(input);assertCurrent();return true;}});
      return {...context,head:await sync.acquire({input,baseline:context.baseline})};
    },assertIntegrationCheckPolicy:(input,expectedId)=>{
    assertActive();const source=read(`task:${input.taskId}`,input.conversationId);
    const current=checkPolicies.current(input,checkSelection.sourceIdentity(source.sourceRoot));
    if((current?.id||null)!==expectedId)throw fail("COLLAB_CHECK_POLICY_CHANGED");
  },integrationRepair:async input=>repairContextFor(input),integrationDependencyRoot:async input=>{
    await authorizeIntegration(input);return dependencyRoot(read(`task:${input.taskId}`,input.conversationId).sourceRoot);
  },getIntegrationCheckPolicy:async input=>{
    await authorizeIntegration(input);const source=read(`task:${input.taskId}`,input.conversationId);
    return checkPolicies.current(input,checkSelection.sourceIdentity(source.sourceRoot));
  },authorizeIntegration:async input=>{await authorizeIntegration(input);return true;},run(command) {
    command = taskWorkflowCommand(command);
    if (!command) return Promise.resolve({ok:false,code:"COLLAB_TASK_INVALID"});
    if (["drafts","recoveries","bindingOptions","cards","sessionCards","integrationStatus"].includes(command.operation)) return ready.then(()=>execute(command)).catch(error=>({ok:false,code:/^COLLAB_/.test(error.code || "")?error.code:"COLLAB_TASK_UNAVAILABLE"}));
    const key = `${command.conversationId}:${command.taskId || command.draftId || "new"}`;
    if (running.has(key)) return Promise.resolve({ok:false,code:"COLLAB_TASK_BUSY"});
    const promise = ready.then(()=>execute(command)).catch(error=>({ok:false,code:/^COLLAB_|^IDEMPOTENCY_/.test(error.code || "")?error.code:"COLLAB_TASK_UNAVAILABLE"}));
    running.set(key,promise);
    promise.finally(()=>{running.delete(key);if (command.operation !== "open") notify();}).catch(()=>{});
    return promise;
  }};
}
module.exports = {createTaskWorkflow};
