"use strict";

const crypto = require("node:crypto");

const TASK_CORE_SCHEMA_VERSION = 1;
const MAX_STRING = 240;
const MAX_ID = 160;
const MAX_PATH = 512;
const MAX_ITEMS = 40;
const DELIVERY_TYPES = new Set(["direct", "local", "queue", "scheduled", "external"]);

function text(value, limit = MAX_STRING) {
  const result = String(value ?? "").replace(/\s+/g, " ").trim();
  return result.slice(0, limit);
}

function id(value, limit = MAX_ID) {
  return text(value, limit);
}

function stringList(value, limit = MAX_ITEMS, itemLimit = MAX_STRING) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => text(item, itemLimit)).filter(Boolean))].slice(0, limit);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function boolean(value) {
  return value === true;
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizeAdmissionMetadata(metadata = {}) {
  return {
    fromQueue: boolean(metadata.fromQueue),
    scheduledTaskId: id(metadata.scheduledTaskId),
    scheduledTaskRunId: id(metadata.scheduledTaskRunId),
    queueOrigin: id(metadata.queueOrigin, 80),
  };
}

function createTaskAdmissionSnapshot({ sessionId = "", admitted = null, taskRunId = "" } = {}) {
  const source = admitted && typeof admitted === "object" ? admitted : {};
  if (sessionId && source.sessionId && String(sessionId) !== String(source.sessionId)) {
    throw new Error("TASK_CORE_SESSION_SCOPE_MISMATCH");
  }
  const delivery = DELIVERY_TYPES.has(String(source.delivery)) ? String(source.delivery) : "direct";
  const external = {
    commandId: id(source.externalCommandId || source.metadata?.externalCommandId),
    idempotencyKey: id(source.externalIdempotencyKey || source.metadata?.externalIdempotencyKey),
    present: Boolean(source.externalCommandId || source.externalIdempotencyKey),
  };
  return freeze({
    schemaVersion: TASK_CORE_SCHEMA_VERSION,
    sessionId: id(sessionId || source.sessionId),
    taskRunId: id(taskRunId),
    turnId: id(source.turnId),
    admittedSeq: numberOrNull(source.admittedSeq),
    source: delivery,
    status: id(source.status, 40) || "admitted",
    ownerScope: id(source.ownerScope),
    sourceTurnId: id(source.sourceTurnId),
    metadata: normalizeAdmissionMetadata(source.metadata),
    external,
  });
}

function contractReference(contract = null) {
  if (!contract || typeof contract !== "object") return null;
  const intent = contract.intentContract && typeof contract.intentContract === "object"
    ? contract.intentContract
    : {};
  return {
    active: boolean(contract.active),
    kind: id(contract.kind, 80),
    taskType: id(contract.taskType, 80),
    categories: stringList(contract.categories, 16, 80),
    workspaceProfile: id(contract.workspaceProfile, 100),
    workspaceSignals: stringList(contract.workspaceSignals, 16, 100),
    intentContractId: id(intent.contractId),
    intentRevision: numberOrNull(intent.revision) || 0,
    intentRelation: id(intent.relation, 40) || "new",
  };
}

function memoryItem(item = {}, skipped = false) {
  return {
    id: id(item.id),
    kind: id(item.kind, 100),
    reason: id(item.reason, 120),
    sourceVersion: id(item.sourceVersion, 160),
    sourcePointers: stringList(item.sourcePointers, 5, 180),
    proof: boolean(item.proof),
    relevance: numberOrNull(item.relevance),
    semanticRelevance: numberOrNull(item.semanticRelevance),
    size: numberOrNull(item.size),
    ...(skipped ? { skipReason: id(item.skipReason, 100) } : {}),
  };
}

function contextReference(memory = {}) {
  memory = memory && typeof memory === "object" ? memory : {};
  const items = Array.isArray(memory.items) ? memory.items.slice(0, MAX_ITEMS).map((item) => memoryItem(item)) : [];
  const skipped = Array.isArray(memory.skipped) ? memory.skipped.slice(0, MAX_ITEMS).map((item) => memoryItem(item, true)) : [];
  return {
    memory: {
      injected: boolean(memory.injected) || Boolean(memory.text),
      fingerprint: id(memory.fingerprint, 200),
      contextEpoch: numberOrNull(memory.contextEpoch) || 0,
      totalChars: numberOrNull(memory.totalChars) || 0,
      itemCount: items.length,
      skippedCount: skipped.length,
      items,
      skipped,
      diagnostics: memory.diagnostics && typeof memory.diagnostics === "object"
        ? {
            selectedCount: numberOrNull(memory.diagnostics.selectedCount),
            skippedCount: numberOrNull(memory.diagnostics.skippedCount),
            semanticIndex: id(memory.diagnostics.semanticIndex, 80),
          }
        : null,
    },
  };
}

function characterReference(snapshot = null, compiled = null) {
  const source = snapshot && typeof snapshot === "object" ? snapshot : {};
  const result = compiled && typeof compiled === "object" ? compiled : {};
  const bindings = Array.isArray(source.worldBookBindings) ? source.worldBookBindings : [];
  return {
    status: id(result.status || source.snapshotStatus, 40) || "native",
    fingerprint: id(result.fingerprint, 200),
    revisionId: id(source.characterRevisionId),
    worldBookRevisionIds: stringList(
      bindings.map((binding) => binding?.worldBookRevisionId),
      20,
      MAX_ID,
    ),
    activatedFields: stringList(result.activatedFields, 30, 100),
    activatedEntryCount: Array.isArray(result.activatedWorldEntries) ? result.activatedWorldEntries.length : 0,
    tokenEstimate: numberOrNull(result.tokenEstimate),
  };
}

function capabilityReference(readiness = null) {
  const source = readiness && typeof readiness === "object" ? readiness : {};
  return {
    status: id(source.status, 40) || "unknown",
    unavailablePackIds: stringList(source.unavailablePackIds, 20, 100),
    failedPackIds: stringList(source.failedPackIds, 20, 100),
  };
}

function inputReference(files = []) {
  if (!Array.isArray(files)) return [];
  return files.slice(0, MAX_ITEMS).map((file) => {
    const source = file && typeof file === "object" ? file : {};
    return {
      path: text(source.path || source.filePath || "", MAX_PATH),
      name: text(source.name || source.fileName || "", 180),
      kind: id(source.kind || source.mimeType, 100),
      size: numberOrNull(source.size || source.byteLength),
      modifiedAt: numberOrNull(source.mtimeMs ?? source.modifiedAt),
      contentHash: id(source.contentHash, 200),
      contentRef: id(source.contentRef || source.blobId, 200),
      source: id(source.source, 80),
    };
  }).filter((file) => file.path || file.name || file.contentRef);
}

function documentReference(evidence = null) {
  const source = evidence && typeof evidence === "object" ? evidence : {};
  const documents = Array.isArray(source.documents) ? source.documents.length : Number(source.documentCount || 0);
  const extracted = Array.isArray(source.extractedPaths) ? source.extractedPaths.length : Number(source.extractedCount || 0);
  const chunks = Array.isArray(source.chunks) ? source.chunks.length : Number(source.chunkCount || 0);
  return {
    documentCount: Number.isFinite(documents) ? documents : 0,
    extractedPathCount: Number.isFinite(extracted) ? extracted : 0,
    chunkCount: Number.isFinite(chunks) ? chunks : 0,
    indexAvailable: Boolean(source.index),
  };
}

function taskRunReference(taskRun = null) {
  const source = taskRun && typeof taskRun === "object" ? taskRun : {};
  const progress = source.progress && typeof source.progress === "object" ? source.progress : {};
  const resume = source.resumeState && typeof source.resumeState === "object" ? source.resumeState : {};
  return {
    id: id(source.id),
    agentGraphId: id(source.agentGraphId, 120),
    leadAttemptId: id(resume.leadAttemptId, 160),
    lastToolId: id(resume.lastToolId, 160),
    hasSideEffects: Boolean(resume.hasSideEffects),
    nextAction: text(resume.nextAction, 200),
    processJobId: id(resume.processJobId, 160),
    phase: id(source.phase, 60),
    status: id(source.status, 40),
    completionStatus: id(source.completionStatus, 60),
    activeStep: id(source.activeStep, 100),
    progress: {
      label: text(progress.label, 160),
      value: numberOrNull(progress.value),
    },
  };
}

function createContextSnapshot({
  sessionId = "",
  admission = null,
  taskContract = null,
  taskRun = null,
  contextMemory = null,
  files = [],
  documentEvidence = null,
  projectId = "",
  characterSnapshot = null,
  characterContext = null,
  capabilityReadiness = null,
  capturedAt = Date.now(),
} = {}) {
  const normalizedAdmission = admission == null
    ? null
    : admission.schemaVersion === TASK_CORE_SCHEMA_VERSION
      ? admission
      : createTaskAdmissionSnapshot({ sessionId, admitted: admission, taskRunId: taskRun?.id });
  const snapshot = {
    schemaVersion: TASK_CORE_SCHEMA_VERSION,
    sessionId: id(sessionId || normalizedAdmission?.sessionId),
    taskId: id(taskRun?.id || normalizedAdmission?.taskRunId || normalizedAdmission?.turnId),
    turnId: id(normalizedAdmission?.turnId),
    capturedAt: Number.isFinite(Number(capturedAt)) ? Number(capturedAt) : Date.now(),
    admission: normalizedAdmission,
    contract: contractReference(taskContract),
    taskRun: taskRunReference(taskRun),
    context: contextReference(contextMemory),
    sources: {
      projectId: id(projectId),
      files: inputReference(files),
      documents: documentReference(documentEvidence),
    },
    character: characterReference(characterSnapshot, characterContext),
    capabilities: capabilityReference(capabilityReadiness),
  };
  snapshot.sourceFingerprint = digest({
    projectId: snapshot.sources.projectId,
    files: snapshot.sources.files,
    documents: snapshot.sources.documents,
    memory: snapshot.context.memory,
    character: snapshot.character,
  });
  const fingerprintTaskRun = { ...snapshot.taskRun };
  delete fingerprintTaskRun.agentGraphId;
  delete fingerprintTaskRun.leadAttemptId;
  delete fingerprintTaskRun.lastToolId;
  delete fingerprintTaskRun.hasSideEffects;
  delete fingerprintTaskRun.nextAction;
  delete fingerprintTaskRun.processJobId;
  const fingerprintInput = {
    ...snapshot,
    taskRun: fingerprintTaskRun,
    capturedAt: undefined,
  };
  snapshot.fingerprint = digest(fingerprintInput);
  return freeze(snapshot);
}

function taskContractEnvelope(contract, {
  taskId = "",
  sessionId = "",
  ownerScope = "",
  projectId = "",
  files = [],
} = {}) {
  const source = contract && typeof contract === "object" ? contract : {};
  const intent = source.intentContract && typeof source.intentContract === "object"
    ? source.intentContract
    : {};
  const external = source.externalFactPolicy && typeof source.externalFactPolicy === "object"
    ? source.externalFactPolicy
    : {};
  const evidence = source.evidencePolicy && typeof source.evidencePolicy === "object"
    ? source.evidencePolicy
    : {};
  const objective = text(intent.objective || source.objective, 1_000);
  const intentContract = {
    schemaVersion: numberOrNull(intent.schemaVersion) || 1,
    contractId: id(intent.contractId),
    revision: numberOrNull(intent.revision) || 1,
    relation: id(intent.relation, 40) || "new",
    taskType: id(intent.taskType || source.taskType, 80) || "general",
    categories: stringList(intent.categories || source.categories, 16, 100),
    objective,
    currentInstruction: text(intent.currentInstruction || objective, 1_000),
    deliverables: stringList(intent.deliverables, 12, 240),
    successCriteria: stringList(intent.successCriteria || source.verificationStrategy, 20, 240),
    constraints: stringList(intent.constraints, 20, 240),
    assumptions: stringList(intent.assumptions, 12, 240),
    criticalUnknowns: stringList(intent.criticalUnknowns, 12, 240),
    neededCapabilities: stringList(intent.neededCapabilities || source.categories, 16, 120),
    amendments: stringList(intent.amendments, 12, 240),
    riskLevel: id(intent.riskLevel, 20) || "low",
  };
  return {
    schemaVersion: TASK_CORE_SCHEMA_VERSION,
    taskId: id(taskId),
    sessionId: id(sessionId),
    ownerScope: id(ownerScope),
    projectId: id(projectId),
    objective,
    currentInstruction: text(intent.currentInstruction || objective, 1_000),
    inputs: inputReference(files),
    constraints: stringList(
      intent.constraints || (source.negativeConstraints || []).map((item) => item?.rule || item?.text || item),
      20,
      240,
    ),
    requestedDeliverables: stringList(intent.deliverables || [], 12, 240),
    acceptanceCriteria: stringList(intent.successCriteria || source.verificationStrategy || [], 20, 240),
    requiredCapabilities: stringList(
      intent.neededCapabilities || source.categories || [],
      16,
      120,
    ),
    permissionBoundary: {
      nonInteractive: Boolean(source.nonInteractive),
      workspaceProfile: id(source.workspaceProfile, 100),
      platformRules: stringList(source.platformRules || [], 20, 240),
    },
    externalFactRequirement: external.required === true
      ? {
          required: true,
          reasonCodes: stringList(external.reasonCodes, 12, 100),
          requiresFreshness: Boolean(external.requiresFreshness),
          requiresSourceLinks: Boolean(external.requiresSourceLinks),
          verificationPlan: external.verificationPlan && typeof external.verificationPlan === "object"
            ? {
                profileIds: stringList(external.verificationPlan.profileIds, 12, 100),
                claimKinds: stringList(external.verificationPlan.claimKinds, 12, 100),
                authorityUrlPolicy: id(external.verificationPlan.authorityUrlPolicy, 80),
              }
            : null,
        }
      : { required: false },
    verificationPolicy: {
      required: Boolean(evidence.required),
      allowedSources: stringList(evidence.allowedSources, 16, 100),
      requiredEvidenceKinds: stringList(evidence.requiredEvidenceKinds, 16, 100),
      strategy: stringList(source.verificationStrategy, 20, 240),
    },
    status: source.active === false ? "inactive" : "active",
    assumptions: stringList(intent.assumptions, 12, 240),
    criticalUnknowns: stringList(intent.criticalUnknowns, 12, 240),
    amendments: stringList(intent.amendments, 12, 240),
    intentContract,
  };
}

function createTaskCoreEnvelope({
  sessionId = "",
  projectId = "",
  admission = null,
  contextSnapshot = null,
  taskContract = null,
  files = [],
  sourceTaskCore = null,
  recoveryContext = null,
  contextRegistryId = "",
} = {}) {
  if (!admission || !contextSnapshot) return null;
  if (String(sessionId || "") !== String(admission.sessionId || "")
      || String(sessionId || "") !== String(contextSnapshot.sessionId || "")) {
    throw new Error("TASK_CORE_SESSION_SCOPE_MISMATCH");
  }
  if (admission.ownerScope && contextSnapshot.admission?.ownerScope
      && admission.ownerScope !== contextSnapshot.admission.ownerScope) {
    throw new Error("TASK_CORE_OWNER_SCOPE_MISMATCH");
  }
  const taskId = id(contextSnapshot.taskId || admission.taskRunId || admission.turnId);
  const envelope = {
    schemaVersion: TASK_CORE_SCHEMA_VERSION,
    taskId,
    sessionId: id(sessionId),
    turnId: id(admission.turnId || contextSnapshot.turnId),
    ownerScope: id(admission.ownerScope || contextSnapshot.admission?.ownerScope),
    projectId: id(projectId || contextSnapshot.sources?.projectId),
    ...(contextRegistryId ? { contextRegistryId: id(contextRegistryId, 120) } : {}),
    admission,
    contract: taskContractEnvelope(taskContract, {
      taskId,
      sessionId,
      ownerScope: admission.ownerScope,
      projectId,
      files,
    }),
    contextSnapshot,
    ...(sourceTaskCore?.fingerprint ? { sourceTaskCoreFingerprint: id(sourceTaskCore.fingerprint, 200) } : {}),
    ...(sourceTaskCore ? {
      recovery: {
        sourceContextFingerprint: id(sourceTaskCore.contextSnapshot?.sourceFingerprint, 200),
        currentContextFingerprint: id(contextSnapshot.sourceFingerprint, 200),
        contextDrifted: recoveryContext?.drifted === true,
        contextDriftReasons: stringList(recoveryContext?.reasons, 8, 100),
      },
    } : {}),
    capturedAt: contextSnapshot.capturedAt,
  };
  const fingerprintInput = {
    ...envelope,
    capturedAt: undefined,
    contextSnapshot: { ...contextSnapshot, capturedAt: undefined },
  };
  envelope.fingerprint = digest(fingerprintInput);
  return freeze(envelope);
}

function compareContextSources(sourceTaskCore, contextSnapshot) {
  const expected = id(sourceTaskCore?.contextSnapshot?.sourceFingerprint, 200);
  const current = id(contextSnapshot?.sourceFingerprint, 200);
  if (!expected || !current) return Object.freeze({ compared: false, drifted: false, reasons: [] });
  return Object.freeze({
    compared: true,
    drifted: expected !== current,
    reasons: expected === current ? [] : ["SOURCE_CONTEXT_CHANGED"],
  });
}

function bindTaskAdmission(state, sessionId, admitted) {
  state.taskAdmission = createTaskAdmissionSnapshot({
    sessionId,
    admitted,
    taskRunId: state.taskRun?.id,
  });
  return state.taskAdmission;
}

function captureContextSnapshot(state, sessionId, options = {}) {
  state.contextSnapshot = createContextSnapshot({
    sessionId,
    admission: state.taskAdmission,
    taskContract: options.taskContract || state.taskContract,
    taskRun: state.taskRun,
    contextMemory: options.contextMemory,
    files: options.files,
    documentEvidence: options.documentEvidence,
    projectId: options.projectId,
    characterSnapshot: options.characterSnapshot || state.characterWorldsSnapshot,
    characterContext: options.characterContext,
    capabilityReadiness: options.capabilityReadiness,
    capturedAt: options.capturedAt || state.startedAt,
  });
  if (state.enginePayload?.trace) state.enginePayload.trace.contextSnapshot = state.contextSnapshot;
  return state.contextSnapshot;
}

function taskContractEventPayload(state) {
  const contract = state?.taskContract;
  return contract
    ? {
        kind: id(contract.kind, 80),
        taskType: id(contract.taskType, 80),
        categories: stringList(contract.categories, 16, 80),
        workspaceProfile: id(contract.workspaceProfile, 100),
        workspaceSignals: stringList(contract.workspaceSignals, 16, 100),
      }
    : null;
}

function emitLocalAssistantStarted({ emit, sessionId, text: userText, queueLength = 0 } = {}) {
  if (typeof emit !== "function") return null;
  return emit(sessionId, "turn.started", {
    text: userText,
    queueLength,
    engine: { localAssistant: true },
    taskContract: null,
    turnPolicy: null,
  });
}

module.exports = { TASK_CORE_SCHEMA_VERSION, bindTaskAdmission, captureContextSnapshot, createContextSnapshot, createTaskCoreEnvelope, createTaskAdmissionSnapshot, compareContextSources, contractReference, digest, emitLocalAssistantStarted, taskContractEventPayload };
