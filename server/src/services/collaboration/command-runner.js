import { sql } from "kysely";

import {
  CollaborationCommandError,
  assertReusableCommandReceipt,
  collaborationRequestFingerprint,
  sanitizeCommandReceiptPayload,
} from "./idempotency.js";
import {
  assertSortedRecipientUserIds,
  lockAndAllocateConversationSequence,
  writeCollaborationEvent,
  writeRealtimeOutboxRows,
  writeUserSyncEvents,
} from "./event-writer.js";

const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 8_000;
const DEFAULT_TRANSACTION_RETRIES = 1;

function requiredText(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new TypeError(`${label} is required.`);
  return text;
}

function normalizeAccount(account) {
  return {
    userId: requiredText(account?.userId ?? account?.user_id ?? account?.id, "Account user id"),
    deviceId: requiredText(account?.deviceId ?? account?.device_id, "Account device id"),
  };
}

function receiptIdentity(account, commandType, clientCommandId) {
  return {
    actorDeviceId: account.deviceId,
    commandType,
    clientCommandId,
  };
}

function receiptResponse(receipt) {
  return {
    ...sanitizeCommandReceiptPayload(receipt?.responsePayload ?? receipt?.response_payload ?? {}),
    responseCode: String(receipt?.responseCode ?? receipt?.response_code ?? "OK"),
  };
}

function receiptState(receipt) {
  return receipt?.state || "";
}

function commandErrorFromAuthorization(decision) {
  return new CollaborationCommandError(
    decision?.code || "COLLAB_AUTHORIZATION_DENIED",
    decision?.auditReason || "Collaboration authorization was denied.",
    { retryable: false },
  );
}

async function configureTransactionTimeouts(trx, { lockTimeoutMs, statementTimeoutMs }) {
  // Test transactions and non-Kysely adapters need no SQL configuration.
  if (!trx || typeof trx.executeQuery !== "function") return;
  const lockMs = Math.max(1, Math.min(Number(lockTimeoutMs) || DEFAULT_LOCK_TIMEOUT_MS, 30_000));
  const statementMs = Math.max(lockMs, Math.min(Number(statementTimeoutMs) || DEFAULT_STATEMENT_TIMEOUT_MS, 60_000));
  await sql.raw(`SET LOCAL lock_timeout = '${lockMs}ms'`).execute(trx);
  await sql.raw(`SET LOCAL statement_timeout = '${statementMs}ms'`).execute(trx);
}

async function defaultFindReceipt(trx, identity) {
  return trx.selectFrom("command_receipts").selectAll()
    .where("actor_device_id", "=", identity.actorDeviceId)
    .where("command_type", "=", identity.commandType)
    .where("client_command_id", "=", identity.clientCommandId)
    .forUpdate().executeTakeFirst();
}

async function defaultClaimReceipt(trx, identity, requestFingerprint) {
  const inserted = await trx.insertInto("command_receipts").values({
    actor_device_id: identity.actorDeviceId,
    command_type: identity.commandType,
    client_command_id: identity.clientCommandId,
    request_fingerprint: requestFingerprint,
    state: "running",
  }).onConflict((conflict) => conflict.columns([
    "actor_device_id", "command_type", "client_command_id",
  ]).doNothing()).returningAll().executeTakeFirst();
  if (inserted) return { inserted: true, receipt: inserted };
  const receipt = await defaultFindReceipt(trx, identity);
  if (!receipt) throw new Error("Command receipt conflict could not be recovered.");
  return { inserted: false, receipt };
}

async function defaultCompleteReceipt(trx, identity, completed) {
  await trx.updateTable("command_receipts").set({
    state: "completed",
    result_event_id: completed.resultEventId,
    response_code: completed.responseCode,
    response_payload: JSON.stringify(completed.responsePayload),
    completed_at: sql`now()`,
  }).where("actor_device_id", "=", identity.actorDeviceId)
    .where("command_type", "=", identity.commandType)
    .where("client_command_id", "=", identity.clientCommandId)
    .executeTakeFirst();
}

const DEFAULT_OPERATIONS = Object.freeze({
  findReceipt: defaultFindReceipt,
  claimReceipt: defaultClaimReceipt,
  allocateSequence: (_trx, conversationId) => lockAndAllocateConversationSequence(_trx, conversationId),
  async allocateRelationshipSequence(trx) {
    const row = await sql`select nextval('collaboration_relationship_event_seq') as seq`.execute(trx);
    const seq = Number(row.rows?.[0]?.seq);
    if (!Number.isSafeInteger(seq) || seq < 1) throw new Error("Collaboration relationship event sequence is invalid.");
    return { conversation: null, seq };
  },
  writeEvent: (trx, event) => writeCollaborationEvent(trx, event),
  fanout: (trx, payload) => writeUserSyncEvents(trx, payload),
  completeReceipt: defaultCompleteReceipt,
  writeRealtimeOutbox: (trx, syncRows) => writeRealtimeOutboxRows(trx, syncRows),
});

function isRetryableTransactionError(error) {
  return error?.code === "40P01" || error?.code === "40001";
}

function requireProjectPlan(plan) {
  if (!plan || typeof plan !== "object" || !plan.event || typeof plan.event !== "object") {
    throw new TypeError("Collaboration command project() must return an event plan.");
  }
  if (typeof plan.project !== "function") {
    throw new TypeError("Collaboration command event plan must provide project().");
  }
  return plan;
}

/**
 * The only commit point for collaboration writes. `authorize` must derive its
 * facts from rows it locks; `project` is a two-phase plan so this kernel can
 * guarantee event-before-projection, cursor fanout, receipt completion and
 * realtime outbox creation all share one database transaction.
 */
export async function runCollaborationCommand({
  account,
  commandType: rawCommandType,
  clientCommandId: rawClientCommandId,
  input = {},
  resolveInput,
  prepare,
  prepareProjection,
  authorize,
  project,
  database,
  operations: operationOverrides,
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  statementTimeoutMs = DEFAULT_STATEMENT_TIMEOUT_MS,
  maxTransactionRetries = DEFAULT_TRANSACTION_RETRIES,
  afterCommit,
} = {}) {
  const commandType = requiredText(rawCommandType, "Command type");
  const clientCommandId = requiredText(rawClientCommandId, "Client command id");
  const actor = normalizeAccount(account);
  if (!database || typeof database.transaction !== "function") throw new TypeError("A collaboration database transaction provider is required.");
  if (typeof authorize !== "function" || typeof project !== "function") throw new TypeError("Collaboration commands require authorize() and project() functions.");
  if (prepare != null && typeof prepare !== "function") throw new TypeError("Collaboration command prepare must be a function.");
  if (prepareProjection != null && typeof prepareProjection !== "function") throw new TypeError("Collaboration command prepareProjection must be a function.");
  if (prepare != null && prepareProjection != null) throw new TypeError("Collaboration command may specify only one preparation hook.");
  const identity = receiptIdentity(actor, commandType, clientCommandId);
  if (resolveInput != null && typeof resolveInput !== "function") throw new TypeError("Collaboration command resolveInput must be a function.");
  const operations = { ...DEFAULT_OPERATIONS, ...(operationOverrides || {}) };
  const retryLimit = Math.max(0, Math.min(Number(maxTransactionRetries) || 0, 3));

  for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
    try {
      const response = await database.transaction().execute(async (trx) => {
        await configureTransactionTimeouts(trx, { lockTimeoutMs, statementTimeoutMs });
        // Authorization always precedes a receipt replay. The callback locks
        // the current membership/block/device facts, so a command id cannot
        // become a back door after the actor is revoked.
        let authorization = await authorize({ trx, account: actor, input, commandType, clientCommandId });
        if (!authorization?.ok) throw commandErrorFromAuthorization(authorization);
        const existing = await operations.findReceipt(trx, identity);
        let effectiveInput = input;
        if (typeof resolveInput === "function") {
          effectiveInput = await resolveInput({
            trx, account: actor, commandType, clientCommandId, input, receipt: existing || null,
          });
          // A resolver is allowed to restore safe receipt-bound data (for
          // example an old HMAC key version), never to bypass authorization
          // facts derived from the final command scope.
          authorization = await authorize({ trx, account: actor, input: effectiveInput, commandType, clientCommandId });
          if (!authorization?.ok) throw commandErrorFromAuthorization(authorization);
        }
        let requestFingerprint = collaborationRequestFingerprint(effectiveInput);
        if (existing) {
          assertReusableCommandReceipt(existing, requestFingerprint);
          if (receiptState(existing) === "completed") return receiptResponse(existing);
          throw new CollaborationCommandError("COLLAB_COMMAND_IN_PROGRESS", "This collaboration command is still being finalized.", { retryable: true });
        }

        const claimed = await operations.claimReceipt(trx, identity, requestFingerprint);
        if (!claimed.inserted) {
          if (typeof resolveInput === "function") {
            effectiveInput = await resolveInput({
              trx, account: actor, commandType, clientCommandId, input, receipt: claimed.receipt,
            });
            authorization = await authorize({ trx, account: actor, input: effectiveInput, commandType, clientCommandId });
            if (!authorization?.ok) throw commandErrorFromAuthorization(authorization);
            requestFingerprint = collaborationRequestFingerprint(effectiveInput);
          }
          assertReusableCommandReceipt(claimed.receipt, requestFingerprint);
          if (receiptState(claimed.receipt) === "completed") return receiptResponse(claimed.receipt);
          throw new CollaborationCommandError("COLLAB_COMMAND_IN_PROGRESS", "This collaboration command is still being finalized.", { retryable: true });
        }

        const preparationHook = prepareProjection || prepare;
        const preparation = typeof preparationHook === "function" ? await preparationHook({
          trx, account: actor, input: effectiveInput, authorization, commandType, clientCommandId,
        }) : null;
        const plan = requireProjectPlan(await project({
          trx, account: actor, input: effectiveInput, authorization, commandType, clientCommandId, preparation,
        }));
        if (plan.noEvent === true) {
          const responsePayload = sanitizeCommandReceiptPayload(plan.response || {});
          await operations.completeReceipt(trx, identity, { resultEventId: null, responseCode: plan.responseCode || "OK", responsePayload });
          return { ...responsePayload, responseCode: plan.responseCode || "OK" };
        }
        const rawConversationId = plan.event.conversationId ?? plan.event.conversation_id;
        const conversationId = rawConversationId == null || String(rawConversationId).trim() === ""
          ? null
          : requiredText(rawConversationId, "Event conversation id");
        const allocated = conversationId
          ? await operations.allocateSequence(trx, conversationId)
          : await operations.allocateRelationshipSequence(trx);
        const event = {
          ...plan.event,
          conversationId,
          seq: allocated.seq,
          actorUserId: actor.userId,
          actorDeviceId: actor.deviceId,
          clientCommandId,
        };
        const writtenEvent = await operations.writeEvent(trx, event);
        await plan.project({ trx, event: writtenEvent, conversation: allocated.conversation, authorization, account: actor, input: effectiveInput, preparation });
        const recipientUserIds = assertSortedRecipientUserIds(plan.recipientUserIds);
        const syncRows = await operations.fanout(trx, { event: writtenEvent, recipientUserIds });
        const responsePayload = sanitizeCommandReceiptPayload(plan.response || {
          eventId: writtenEvent.id,
          conversationId: writtenEvent.conversationId,
          seq: writtenEvent.seq,
        });
        await operations.completeReceipt(trx, identity, {
          resultEventId: writtenEvent.id,
          responseCode: plan.responseCode || "OK",
          responsePayload,
        });
        await operations.writeRealtimeOutbox(trx, syncRows);
        return { ...responsePayload, responseCode: plan.responseCode || "OK" };
      });
      // This hook intentionally executes only after the transaction resolved;
      // a dropped HTTP response cannot roll a committed event back.
      if (typeof afterCommit === "function") await afterCommit(response);
      return response;
    } catch (error) {
      if (isRetryableTransactionError(error) && attempt < retryLimit) continue;
      throw error;
    }
  }
  throw new Error("Collaboration transaction retry loop exhausted unexpectedly.");
}
