import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { assessPendingDocumentResponse } = require("../src/main/document-delivery-response");
const { evaluateAnswerEvidenceWithJudge } = require("../src/main/answer-evidence-finalizer");
const params = { userText: "Summarize the attached table", assistant: "Please upload the table first." };
const adapters = { resolveConnection: () => ({ connection: {} }), post: async () => JSON.stringify({ status: "awaiting_input", requestQuote: "attached table", answerQuote: "upload the table" }) };
assert.equal((await assessPendingDocumentResponse(params, adapters)).status, "awaiting_input");
assert.equal((await assessPendingDocumentResponse(params, { ...adapters, post: async () => "bad JSON" })).status, "unknown");
assert.equal((await assessPendingDocumentResponse(params, { ...adapters, post: async () => { throw Error("offline"); } })).status, "unknown");
assert.equal((await assessPendingDocumentResponse(params, { ...adapters, post: async () => JSON.stringify({ status: "awaiting_input", requestQuote: "invented request", answerQuote: "upload the table" }) })).status, "unknown");
const taskContract = { taskType: "document_work", semanticIntent: { operation: "create", outputMode: "artifact" }, evidencePolicy: { required: true, requiredEvidenceKinds: ["document_output"] } };
const options = { pendingDocumentJudge: p => assessPendingDocumentResponse(p, adapters), judge: async () => null };
const pending = await evaluateAnswerEvidenceWithJudge({ ...params, taskContract }, options);
assert.equal(pending.assistant, params.assistant);
assert.equal(pending.assessment.ok, false, "waiting is not verified delivery");
assert.equal(pending.assessment.reason, "awaiting_user_input");
assert.equal(pending.triggerDocumentVerifyRetry, false);
const failed = await evaluateAnswerEvidenceWithJudge({ ...params, assistant: "The report is delivered.", taskContract }, options);
assert.notEqual(failed.assistant, "The report is delivered.", "a delivery claim cannot bypass missing-file validation");
assert.equal(failed.assessment.ok, false);
for (const reason of ["timeout", "no_connection", "invalid_request_quote", "invalid_status"]) {
  const offline = await evaluateAnswerEvidenceWithJudge({ ...params, taskContract }, {
    ...options, pendingDocumentJudge: async () => ({ status: "unknown", reason }),
  });
  assert.ok(offline.assistant.startsWith(params.assistant), "auxiliary failure must not erase the model's request for input");
  assert.equal(offline.assessment.ok, false);
  assert.equal(offline.assessment.judgeUnavailable, reason);
  assert.equal(offline.triggerDocumentVerifyRetry, false, "uncertain applicability must not cause unwanted file creation");
}
const actualDelivery = await evaluateAnswerEvidenceWithJudge({ ...params, assistant: "The report is delivered.", taskContract }, {
  ...options, pendingDocumentJudge: async () => ({ status: "other" }),
});
assert.ok(!actualDelivery.assistant.includes("The report is delivered."));
const answerParams = { userText: "Read the table and answer in chat, do not generate files", assistant: "The table contains store sales.", taskContract,
  evidenceSummary: { hasFileReadEvidence: true, counts: { filesRead: 1 } },
  tools: [{ name: "read", status: "done", result: "The table contains store sales." }] };
const answerAdapters = { ...adapters, post: async () => JSON.stringify({ status: "answer_only", requestQuote: "answer in chat, do not generate files", answerQuote: "table contains store sales" }) };
const answerResult = await evaluateAnswerEvidenceWithJudge(answerParams, { ...options, pendingDocumentJudge: p => assessPendingDocumentResponse(p, answerAdapters) });
assert.equal(answerResult.assistant, answerParams.assistant);
assert.equal(answerResult.assessment.documentResponse.status, "answer_only");
const { answerOnlyContract } = require("../src/main/document-delivery-response");
assert.deepEqual(answerOnlyContract(taskContract).evidencePolicy.requiredEvidenceKinds, ["file_read"], "chat answers still require source evidence");
assert.deepEqual(answerOnlyContract({ ...taskContract, evidencePolicy: { requiredEvidenceKinds: ["external", "document_output"] } }).evidencePolicy.requiredEvidenceKinds, ["external", "file_read"], "other evidence obligations survive");
const unsupported = await evaluateAnswerEvidenceWithJudge({ ...answerParams, evidenceSummary: { counts: {} }, tools: [] }, { ...options, pendingDocumentJudge: p => assessPendingDocumentResponse(p, answerAdapters) });
assert.equal(unsupported.assessment.ok, false, "answer-only classification must not fabricate source evidence");
console.log("document response: waiting preserved; literal validation and unavailable-judge fallback retained");

const catalog = require("../src/main/model-selection-catalog");
const saved = catalog.resolveTurnModel;
try {
  const route = { selectionId: "selected", modelId: "model-a", providerId: "provider-a" };
  catalog.resolveTurnModel = () => ({ ok: true, model: { modelID: "model-a", providerID: "provider-a" }, execution: { env: { LILY_API_BASE_URL: "https://example.invalid/v1", LILY_API_KEY: "test-only", LILY_MODEL: "model-a" } } });
  const { resolveJudgeConnectionDetailed } = require("../src/main/evidence-entailment-judge");
  assert.equal(resolveJudgeConnectionDetailed(route).connection.model, "model-a");
  assert.equal(resolveJudgeConnectionDetailed({ ...route, providerId: "different" }).reason, "turn_model_unavailable");
  catalog.resolveTurnModel = () => ({ ok: false });
  assert.equal(resolveJudgeConnectionDetailed(route).connection, null, "never fall back to another active model");
} finally { catalog.resolveTurnModel = saved; }

const savedFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: {
    content: JSON.stringify({ status: "awaiting_input", requestQuote: "attached table", answerQuote: "upload the table" }),
    reasoning_content: "Consider the request before producing the JSON verdict.",
  } }] }), { status: 200, headers: { "content-type": "application/json" } });
  const actualTransport = await assessPendingDocumentResponse(params, { resolveConnection: () => ({ connection: { baseUrl: "https://example.invalid/v1", apiKey: "test-only", model: "test", protocol: "openai" } }) });
  assert.equal(actualTransport.status, "awaiting_input", "reasoning_content must not corrupt the structured final verdict");
} finally { globalThis.fetch = savedFetch; }
