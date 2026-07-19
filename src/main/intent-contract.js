"use strict";

const crypto = require("node:crypto");

const INTENT_CONTRACT_SCHEMA_VERSION = 1;
const MAX_LIST_ITEMS = 20;
const MAX_ITEM_CHARS = 500;

const RELATIONS = new Set(["new", "continue", "refine", "correct", "cancel"]);
const CONTINUATION_RE = /^(?:继续(?:$|[，,。.!！?？\s]|刚才|之前|上面|按|把|做|完成|推进|优化|实现|修复)|接着(?:$|[，,。.!！?？\s]|做|刚才)|往下(?:$|[，,。.!！?？\s]|做)|按刚才|按照刚才|基于刚才|沿着刚才|continue(?:\s|$)|go on(?:\s|$)|keep going(?:\s|$)|proceed(?:\s|$))/i;
const CORRECTION_RE = /(?:不是这个意思|理解错了|搞错了|答错了|方向错了|纠正一下|我的意思是|不是.+而是|not what i mean|you misunderstood|correction\s*:)/i;
const REFINEMENT_RE = /^(?:改成|换成|调整为|调整成|再加|再详细|更详细|详细一点|再具体|具体一点|深入一点|加上|补上|补充|去掉|删掉|不要|必须|重点|只要|改为|按(?:照)?|现在(?:可以|允许)|make it|change it|also add|remove|instead)/i;
const CANCELLATION_RE = /^(?:算了|不用了|先停|停止|取消|别做了|不要继续|cancel|stop|never mind)(?:\s|$|[，,。.!！?？])/i;
const NEW_TASK_RE = /^(?:(?:新任务|另一个任务|另外一个任务|换个任务|接下来新做)(?:\s|$|[:：,，。.!！?？])|(?:new task|another task)\b)/i;

const DEFAULT_DELIVERABLES = Object.freeze({
  architecture_audit: ["evidence_backed_analysis_or_implementation"],
  agent_quality: ["agent_quality_improvement"],
  bug_investigation: ["root_cause_and_verified_fix"],
  code_change: ["requested_workspace_change"],
  configuration_change: ["requested_configuration_change"],
  content_extraction: ["extracted_or_explained_source_content"],
  document_work: ["requested_document_result"],
  external_fact: ["source_backed_answer"],
  media_generation: ["requested_media_artifact"],
  release_deploy: ["verified_release_or_deployment"],
  runtime_protocol: ["verified_runtime_behavior"],
  server_change: ["requested_server_change"],
  ui_change: ["requested_visible_ui_change"],
});

function safeText(value, limit = MAX_ITEM_CHARS) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function stringList(values, limit = MAX_LIST_ITEMS) {
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = safeText(value);
    if (!text || result.includes(text)) continue;
    result.push(text);
    if (result.length >= limit) break;
  }
  return result;
}

function relationForText(text, hasPrevious = false) {
  const source = safeText(text, 2_000);
  if (!source || !hasPrevious || NEW_TASK_RE.test(source)) return "new";
  if (CANCELLATION_RE.test(source)) return "cancel";
  if (CORRECTION_RE.test(source)) return "correct";
  if (CONTINUATION_RE.test(source)) return "continue";
  if (REFINEMENT_RE.test(source)) return "refine";
  return "new";
}

function isInheritedRelation(relation) {
  return relation === "continue" || relation === "refine" || relation === "correct";
}

function contractIdFor(objective) {
  const digest = crypto.createHash("sha256").update(safeText(objective, 2_000)).digest("hex").slice(0, 16);
  return `intent_${digest}`;
}

function normalizeIntentContract(value) {
  if (!value || typeof value !== "object") return null;
  const objective = safeText(value.objective, 1_000);
  const taskType = safeText(value.taskType, 80) || "general";
  if (!objective && taskType === "general") return null;
  const relation = RELATIONS.has(value.relation) ? value.relation : "new";
  const contractId = safeText(value.contractId, 120) || contractIdFor(objective || taskType);
  const revision = Number.isInteger(value.revision) && value.revision > 0 ? value.revision : 1;
  const criticalUnknowns = stringList(value.criticalUnknowns, 10);
  return {
    schemaVersion: INTENT_CONTRACT_SCHEMA_VERSION,
    contractId,
    revision,
    relation,
    taskType,
    categories: stringList(value.categories, 12),
    objective,
    currentInstruction: safeText(value.currentInstruction || objective, 1_000),
    deliverables: stringList(value.deliverables, 12),
    successCriteria: stringList(value.successCriteria, 20),
    constraints: stringList(value.constraints, 20),
    assumptions: stringList(value.assumptions, 12),
    criticalUnknowns,
    neededCapabilities: stringList(value.neededCapabilities, 16),
    amendments: stringList(value.amendments, 12),
    riskLevel: ["low", "medium", "high"].includes(value.riskLevel) ? value.riskLevel : "low",
    clarificationPolicy: {
      mode: "critical_only",
      required: criticalUnknowns.length > 0,
    },
    provenance: {
      mode: safeText(value.provenance?.mode, 80) || "local_fallback",
      inherited: Boolean(value.provenance?.inherited),
      previousContractId: safeText(value.provenance?.previousContractId, 120),
    },
  };
}

function compactIntentContract(value) {
  return normalizeIntentContract(value);
}

function taskContractFromMessage(message) {
  return message?.record?.meta?.taskContract || message?.meta?.taskContract || null;
}

function legacyIntentContract(taskContract, message) {
  if (!taskContract || typeof taskContract !== "object") return null;
  const objective = safeText(message?.record?.user?.text || message?.meta?.userText || "", 1_000);
  const taskType = safeText(taskContract.taskType, 80) || "general";
  if (!objective && taskType === "general") return null;
  return normalizeIntentContract({
    taskType,
    categories: taskContract.categories || [],
    objective,
    currentInstruction: objective,
    deliverables: DEFAULT_DELIVERABLES[taskType] || [],
    successCriteria: taskContract.verificationStrategy || [],
    neededCapabilities: taskContract.categories || [],
    provenance: { mode: "legacy_archive", inherited: false },
  });
}

function findLatestTaskContractSnapshot(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (message?.role !== "assistant") continue;
    const archived = taskContractFromMessage(message);
    if (!archived) return null;
    const intentContract = normalizeIntentContract(archived.intentContract) || legacyIntentContract(archived, message);
    if (!intentContract) return null;
    return {
      active: archived.active !== false && intentContract.taskType !== "general",
      kind: safeText(archived.kind, 80) || "operational",
      taskType: safeText(archived.taskType, 80) || intentContract.taskType,
      categories: stringList(archived.categories?.length ? archived.categories : intentContract.categories, 12),
      verificationStrategy: stringList(
        archived.verificationStrategy?.length ? archived.verificationStrategy : intentContract.successCriteria,
        20,
      ),
      contentIntent: archived.contentIntent && typeof archived.contentIntent === "object"
        ? archived.contentIntent
        : null,
      programIntent: archived.programIntent && typeof archived.programIntent === "object"
        ? archived.programIntent
        : null,
      semanticIntent: archived.semanticIntent && typeof archived.semanticIntent === "object"
        ? archived.semanticIntent
        : null,
      sourceContentEvidence: message?.record?.meta?.evidenceSummary?.hasSourceContentEvidence
        ? message.record.meta.evidenceSummary.sourceContentCoverage || null
        : null,
      externalFact: archived.externalFact && typeof archived.externalFact === "object"
        ? {
            reasonCodes: stringList(archived.externalFact.reasonCodes, 12),
            researchProhibited: Boolean(archived.externalFact.researchProhibited),
            scopeClarificationRecommended: Boolean(archived.externalFact.scopeClarificationRecommended),
          }
        : null,
      intentContract,
    };
  }
  return null;
}

function snapshotFromSummary(intentContract) {
  const normalized = normalizeIntentContract(intentContract);
  if (!normalized) return null;
  return {
    active: normalized.taskType !== "general",
    kind: "operational",
    taskType: normalized.taskType,
    categories: normalized.categories,
    verificationStrategy: normalized.successCriteria,
    intentContract: normalized,
  };
}

function riskLevelFor(taskType) {
  if (taskType === "release_deploy") return "high";
  if (["code_change", "configuration_change", "runtime_protocol", "server_change", "ui_change"].includes(taskType)) {
    return "medium";
  }
  return "low";
}

function negativeConstraintRules(negativeConstraints = []) {
  return stringList(
    negativeConstraints.map((item) => item?.rule || item?.text || ""),
    20,
  );
}

function buildIntentContract({
  text = "",
  taskType = "general",
  categories = [],
  verificationStrategy = [],
  negativeConstraints = [],
  previousSnapshot = null,
} = {}) {
  const previous = normalizeIntentContract(previousSnapshot?.intentContract);
  const relation = relationForText(text, Boolean(previous));
  const inherited = Boolean(previous && isInheritedRelation(relation));
  const currentInstruction = safeText(text, 1_000);
  const resolvedTaskType = safeText(taskType, 80) || (inherited ? previous.taskType : "general");
  const objective = inherited ? previous.objective || currentInstruction : currentInstruction;
  const currentDeliverables = DEFAULT_DELIVERABLES[resolvedTaskType] || [];
  const currentCriteria = stringList(verificationStrategy, 20);
  const currentConstraints = negativeConstraintRules(negativeConstraints);
  const amendments = inherited && relation !== "continue"
    ? stringList([...(previous.amendments || []), currentInstruction], 12)
    : inherited
      ? previous.amendments || []
      : [];
  return normalizeIntentContract({
    contractId: inherited ? previous.contractId : contractIdFor(objective || resolvedTaskType),
    revision: inherited ? previous.revision + 1 : 1,
    relation,
    taskType: resolvedTaskType,
    categories: inherited ? [...categories, ...previous.categories] : categories,
    objective,
    currentInstruction,
    deliverables: inherited ? [...currentDeliverables, ...previous.deliverables] : currentDeliverables,
    successCriteria: inherited ? [...currentCriteria, ...previous.successCriteria] : currentCriteria,
    constraints: inherited ? [...currentConstraints, ...previous.constraints] : currentConstraints,
    assumptions: inherited ? previous.assumptions : [],
    criticalUnknowns: [],
    neededCapabilities: inherited ? [...categories, ...previous.neededCapabilities] : categories,
    amendments,
    riskLevel: riskLevelFor(resolvedTaskType),
    provenance: {
      mode: inherited ? "inherited_local_fallback" : "local_fallback",
      inherited,
      previousContractId: inherited ? previous.contractId : "",
    },
  });
}

function parsedJson(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function modelIntentCandidateFromToolResult(result) {
  const direct = parsedJson(result);
  if (direct?.intentContract && typeof direct.intentContract === "object") return direct.intentContract;
  if (direct?.result?.intentContract && typeof direct.result.intentContract === "object") {
    return direct.result.intentContract;
  }
  for (const item of Array.isArray(direct?.content) ? direct.content : []) {
    const parsed = parsedJson(item?.text);
    if (parsed?.intentContract && typeof parsed.intentContract === "object") return parsed.intentContract;
  }
  return null;
}

function strongerRiskLevel(left, right) {
  const levels = ["low", "medium", "high"];
  return levels[Math.max(levels.indexOf(left), levels.indexOf(right), 0)];
}

function applyModelIntentCandidate(baselineValue, candidateValue) {
  const baseline = normalizeIntentContract(baselineValue);
  const candidate = normalizeIntentContract(candidateValue);
  if (!baseline || !candidate?.objective) return null;
  // The model may make the semantic contract richer, but it cannot weaken the
  // deterministic baseline, remove user constraints, or reroute the task after
  // tools were selected. Identity and relation remain host-owned.
  return normalizeIntentContract({
    ...baseline,
    objective: candidate.objective,
    currentInstruction: baseline.currentInstruction,
    deliverables: [...baseline.deliverables, ...candidate.deliverables],
    successCriteria: [...baseline.successCriteria, ...candidate.successCriteria],
    constraints: [...baseline.constraints, ...candidate.constraints],
    assumptions: candidate.assumptions,
    criticalUnknowns: [...baseline.criticalUnknowns, ...candidate.criticalUnknowns],
    neededCapabilities: [...baseline.neededCapabilities, ...candidate.neededCapabilities],
    amendments: [...baseline.amendments, ...candidate.amendments],
    riskLevel: strongerRiskLevel(baseline.riskLevel, candidate.riskLevel),
    contractId: baseline.contractId,
    revision: baseline.revision,
    relation: baseline.relation,
    taskType: baseline.taskType,
    categories: baseline.categories,
    provenance: {
      mode: "model_refined",
      inherited: baseline.provenance.inherited,
      previousContractId: baseline.provenance.previousContractId,
    },
  });
}

function resolveModelIntentContractUpdate(baseline, toolResult) {
  return applyModelIntentCandidate(baseline, modelIntentCandidateFromToolResult(toolResult));
}

module.exports = {
  INTENT_CONTRACT_SCHEMA_VERSION,
  buildIntentContract,
  applyModelIntentCandidate,
  compactIntentContract,
  findLatestTaskContractSnapshot,
  isInheritedRelation,
  normalizeIntentContract,
  modelIntentCandidateFromToolResult,
  relationForText,
  resolveModelIntentContractUpdate,
  snapshotFromSummary,
};
