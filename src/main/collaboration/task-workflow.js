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
            if(["COLLAB_TASK_APPLICATION_BUSY","COLLAB_LOCAL_APPLICATION_STALE_WORKSPACE","COLLAB_TASK_APPLICATION_PREVIEW_CHANGED"].includes(error.code))return {state:"waiting",validationState:validation.state};
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
