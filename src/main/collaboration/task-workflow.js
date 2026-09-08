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
function createTaskWorkflow({ store, client, tasks, transfers, deviceId, assertActive, rootPath, chooseDirectory, resolveProjectDirectory,
  openWorkspace, onChange = () => {}, bundle = { freezeTaskBundle, unpackTaskBundle } }) {
  const records = createTaskRecords({ store, assertActive });
  const recoveries = createTaskRecovery({store,assertActive});
  const running = new Map();
  function root() {
    assertActive();
    if (!rootPath) throw fail();
    const account = createHash("sha256").update(store.accountId).digest("hex");
    const target = path.join(rootPath, account);
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    return fs.realpathSync(target);
  }
  const allocate = () => path.join(root(), randomUUID());
  function save(value) { return records.put(value.id, value); }
  function read(id, conversationId) {
    const value = records.get(id);
    if (!value || value.conversationId !== conversationId) throw fail("COLLAB_TASK_LOCAL_MISSING");
    return value;
  }
  async function taskFor(command) {
    const { task } = requireOk(await tasks.get(command));
    if (["cancelled", "declined"].includes(task.state)) throw fail("COLLAB_TASK_ACCESS_DENIED");
    return task;
  }
  function draftView(value) {
    return { id:value.id, name:value.name, files:value.files, warnings:value.warnings, omitted:value.omitted,
      state:value.state, ...(value.input ? { input:value.input } : {}), ...(value.taskId ? {taskId:value.taskId} : {}) };
  }
  async function freeze(sourceRoot, conversationId, extras = {}, assertAuthorized = assertActive) {
    const id = randomUUID();
    const result = await bundle.freezeTaskBundle({ sourceRoot, destinationRoot:allocate(), name:path.basename(sourceRoot) });
    assertAuthorized();
    const packageBytes = fs.readFileSync(result.packagePath);
    return save({ ...result, ...extras, id, conversationId, sourceRoot, name:path.basename(sourceRoot),
      packageHash:createHash("sha256").update(packageBytes).digest("hex"),packageSize:packageBytes.length,
      kind:"draft", state:"prepared", deviceId, clientCommandId:randomUUID() });
  }
  async function upload(draft) {
    if (!transfers?.taskFiles) throw fail();
    if (!draft.transferId) {
      const stat = fs.lstatSync(draft.packagePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== draft.packageSize
        || createHash("sha256").update(fs.readFileSync(draft.packagePath)).digest("hex") !== draft.packageHash) throw fail("COLLAB_TASK_BUNDLE_CHANGED");
      const transfer = requireOk(await transfers.taskFiles.prepareUpload({ conversationId:draft.conversationId,
        inputPath:draft.packagePath, originalName:`${draft.name}.lilyspace.zip`,expectedPlaintextSha256:draft.packageHash }));
      draft = save({ ...draft, transferId:transfer.id });
    }
    const uploaded = requireOk(await transfers.taskFiles.upload(draft.transferId));
    if (!["verified", "bound"].includes(uploaded.state) || !uploaded.objectId) throw fail("COLLAB_TRANSFER_NOT_READY");
    return save({ ...draft, objectId:uploaded.objectId });
  }
  async function download(command, objectId) {
    const file = requireOk(await transfers.taskFiles.download({ ...command, objectId }));
    assertActive();
    const value = await bundle.unpackTaskBundle({ packagePath:file.packagePath, destinationRoot:allocate() });
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
    if (!local.workRoot) {
      const input = await download(command, task.inputSnapshotId);
      // Extract a second, independent copy. Never edit the baseline snapshot.
      const work = await download(command, task.inputSnapshotId);
      for (const file of work.manifest) fs.chmodSync(path.join(work.snapshotRoot,file.path),0o600);
      local = save({...local,baseManifest:input.manifest,snapshotRoot:input.snapshotRoot,workRoot:work.snapshotRoot});
    }
    return local;
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
    const result = await download(command, command.deliveryId);
    save({...local,deliveries:{...local.deliveries,[command.deliveryId]:result}});
    return result;
  }
  function application(record, localRecovery = false) {
    const journalRoot = path.join(root(), "recovery");
    fs.mkdirSync(journalRoot,{recursive:true,mode:0o700});
    return createTaskApplication({ journalRoot:fs.realpathSync(journalRoot),
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
    if (operation === "recoveries") return {ok:true,applications:recoveries.list().filter(v=>v.journal && v.state !== "rolled_back").map(v=>({
      conversationId:v.conversationId,taskId:v.taskId,applicationId:v.id,state:v.state,deliveryId:v.deliveryId,planHash:v.planHash,
      label:path.basename(v.input.rootPath),
    }))};
    if (operation === "drafts") {
      const all = records.list(conversationId);
      const localApplications = new Map(all.filter(v=>v.kind === "application").map(v=>[v.id,v]));
      for (const value of recoveries.list()) if (value.conversationId === conversationId) localApplications.set(value.id,value);
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
      if (command.projectId) {
        sourceRoot = await resolveProjectDirectory?.(command.projectId);
        assertAuthorized();
        if (typeof sourceRoot !== "string" || !path.isAbsolute(sourceRoot)
          || !fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) throw fail("COLLAB_TASK_LOCAL_MISSING");
      } else {
        const selected = await chooseDirectory?.();
        assertAuthorized();
        if (selected?.canceled) return {ok:true,cancelled:true};
        if (selected?.filePaths?.length !== 1) throw fail();
        sourceRoot = selected.filePaths[0];
      }
      const draft = await freeze(fs.realpathSync(sourceRoot),conversationId,{},assertAuthorized);
      return {ok:true,draft:draftView(draft)};
    }
    if (operation === "send") {
      let draft = read(command.draftId,conversationId);
      if (draft.kind !== "draft" || draft.taskId && draft.state !== "completed") throw fail("COLLAB_TASK_INVALID");
      const input = Object.fromEntries(["assigneeUserId","title","objective","acceptanceCriteria"].map(key=>[key,command[key]]));
      if (draft.state === "failed") draft = save({...draft,input:null,clientCommandId:randomUUID(),uncertain:false,
        ...(draft.code === "COLLAB_TASK_PACKAGE_UNAVAILABLE" ? {transferId:null,objectId:null} : {})});
      if (draft.input && JSON.stringify(draft.input) !== JSON.stringify(input)) throw fail("IDEMPOTENCY_KEY_REUSED");
      if (draft.deviceId !== deviceId) throw fail("COLLAB_DEVICE_CHANGED");
      if (draft.state === "completed") return {ok:true,state:"completed",taskId:draft.taskId,draftId:draft.id};
      draft = save({...draft,input,state:"uploading"});
      draft = await upload(draft);
      const priorUncertain = draft.uncertain === true;
      draft = save({...draft,state:"confirming",uncertain:true});
      let result;
      try {
        result = requireOk(await client.submitTask({...input,conversationId,action:"create",inputSnapshotId:draft.objectId,deviceId,clientCommandId:draft.clientCommandId})).result;
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
      save({id:`task:${result.taskId}`,kind:"task",conversationId,taskId:result.taskId,sourceRoot:draft.sourceRoot,
        snapshotRoot:draft.snapshotRoot,baseManifest:draft.manifest});
      save({...draft,taskId:result.taskId,state:"completed"});
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
      return {ok:true,...await openWorkspace({rootPath:target,title:task.title,bindingId:`${task.id}:${command.deliveryId || store.accountId}`})};
    }
    if (operation === "prepareDelivery") {
      const task = await taskFor(command), local = await receive(command);
      const draft = await freeze(local.workRoot,conversationId,{taskId:task.id,expectedRevision:task.revision,inputSnapshotId:task.inputSnapshotId});
      // Omission by a secret/size filter is not a collaborator's deletion.
      const delivered = new Set(draft.manifest.map(file=>file.path));
      const exists = file => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };
      if (local.baseManifest.some(file=>!delivered.has(file.path) && exists(path.join(local.workRoot,file.path)))) {
        save({...draft,state:"blocked"});
        throw fail("COLLAB_TASK_DELIVERY_OMITTED");
      }
      return {ok:true,draft:draftView(draft)};
    }
    if (operation === "submitDelivery") {
      let draft = read(command.draftId,conversationId);
      if (draft.taskId !== command.taskId || draft.kind !== "draft") throw fail("COLLAB_TASK_INVALID");
      if (draft.state === "blocked") throw fail("COLLAB_TASK_DELIVERY_OMITTED");
      if (draft.deviceId !== deviceId) throw fail("COLLAB_DEVICE_CHANGED");
      if (draft.state === "completed") return {ok:true,state:"completed",clientCommandId:draft.clientCommandId};
      draft = await upload(draft);
      const result = await tasks.submit({conversationId,taskId:command.taskId,action:"submit",expectedRevision:draft.expectedRevision,
        deliveryId:draft.objectId,clientCommandId:draft.clientCommandId});
      read(draft.id,conversationId);
      if (result.ok) save({...draft,state:result.state});
      return result;
    }
    if (operation === "preview") {
      const task = await taskFor(command);
      if (task.requesterUserId !== store.accountId || task.state !== "accepted" || task.acceptedDeliveryId !== command.deliveryId) throw fail("COLLAB_TASK_STATE_CONFLICT");
      const previous = recoveries.list().filter(v=>v.conversationId === conversationId && v.taskId === task.id && v.journal && v.state !== "rolled_back").sort((a,b)=>(b.createdAt||0)-(a.createdAt||0))[0];
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
      if (record.kind !== "application" || record.taskId !== command.taskId || (operation === "apply" && record.deliveryId !== command.deliveryId)) throw fail("COLLAB_TASK_INVALID");
      if (operation === "rollback") return application(record,true).recover({applicationId:record.id,mode:"rollback"});
      return application(record).apply({...record.input,expectedPlanHash:command.expectedPlanHash,confirmDeletions:command.confirmDeletions});
    }
    throw fail("COLLAB_TASK_INVALID");
  }
  // Incomplete local writes recover without a network or Team membership grant.
  // Matching hashes are still mandatory; later user edits become conflicts.
  const ready = Promise.resolve().then(async () => {
    for (const record of recoveries.list()) {
      if (!record.journal || ["applied","rolled_back"].includes(record.state)) continue;
      try { await application(record,true).recover({applicationId:record.id,mode:"rollback"}); }
      catch { /* durable record remains available; never report it as applied */ }
    }
  });
  return {recoverPending:()=>ready,run(command) {
    command = taskWorkflowCommand(command);
    if (!command) return Promise.resolve({ok:false,code:"COLLAB_TASK_INVALID"});
    const key = `${command.conversationId}:${command.taskId || command.draftId || "new"}`;
    if (running.has(key)) return Promise.resolve({ok:false,code:"COLLAB_TASK_BUSY"});
    const promise = ready.then(()=>execute(command)).catch(error=>({ok:false,code:/^COLLAB_|^IDEMPOTENCY_/.test(error.code || "")?error.code:"COLLAB_TASK_UNAVAILABLE"}));
    running.set(key,promise);
    promise.finally(()=>{running.delete(key);if (!["drafts","open","recoveries"].includes(command.operation)) onChange();}).catch(()=>{});
    return promise;
  }};
}
module.exports = {createTaskWorkflow};
