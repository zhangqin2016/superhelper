"use strict";
const { randomUUID, createHash } = require("node:crypto");
const { normalizeSocialCommand, socialIdentifier } = require("./social-command-contract");
const { assertScopeWritable, isConversationRevoked } = require("./access-revocation");
const invalid = (code = "COLLABORATION_INVALID_INPUT") => ({ ok: false, code, retryable: false });
const permanent = (code) => /^(COLLAB_(?:FRIEND_TARGET_UNAVAILABLE|TARGET_UNAVAILABLE|TARGET_MEMBERSHIP_INACTIVE|INVITE_FORBIDDEN|ACTION_NOT_AVAILABLE|OWNER_IMMUTABLE|MEMBER_LIMIT|CONVERSATION_INVALID|CONVERSATION_UNAVAILABLE|MEMBERSHIP_INACTIVE|ORGANIZATION_ACCESS_REVOKED|DEVICE_REVOKED)|IDEMPOTENCY_KEY_REUSED)$/.test(code);

function completeReceipt(row, result) {
  if (!result || result.ok === false || result.responseCode != null && result.responseCode !== "OK") return false;
  if (row.kind === "conversation") return socialIdentifier(result.conversationId) && (row.input.action === "create"
    || row.input.action === "dissolve" && result.conversationId === row.input.conversationId && result.status === "dissolved"
    || row.input.action === "member" && result.conversationId === row.input.conversationId && result.userId === row.input.targetUserId && ["active", "removed", "left"].includes(result.status));
  const statuses = { request: ["pending", "active"], respond: ["active", "declined"], remove: ["removed"], block: ["blocked"], unblock: ["unblocked"] };
  return statuses[row.input.action]?.includes(result.status)
    && (result.status !== "active" || socialIdentifier(result.conversationId))
    && (result.status !== "pending" || socialIdentifier(result.requestId));
}

/** Explicit social intents only. Separate from the message outbox and never auto-replayed. */
function createSocialCommands({ store, client, deviceId, assertActive, onConfirmed = async () => {}, onChange = () => {} }) {
  const inFlight = new Map();
  const supported = Boolean(store.db && store._encrypt && store._decrypt);
  const read = (row) => row ? { ...row, ...store._decrypt({ scopeId: row.scope_id, recordId: `social:${row.id}`, value: row.payload_envelope_json }) } : null;
  const get = (id) => read(store.db.get("SELECT * FROM social_commands WHERE account_id = ? AND id = ?", store.accountId, id));
  const view = (row) => ({ ok: row.state !== "failed", clientCommandId: row.id, state: row.state === "submitting" ? "confirming" : row.state,
    ...(row.code ? { code: row.code } : {}), ...(row.result?.conversationId ? { conversationId: row.result.conversationId } : {}) });
  const save = (row, state, { code = null, uncertain = row.uncertain, result = row.result } = {}) => {
    const envelope = store._encrypt({ scopeId: row.scope_id, recordId: `social:${row.id}`, value: { input: row.input, result, deviceId: row.deviceId } });
    store.db.run("UPDATE social_commands SET state = ?, code = ?, uncertain = ?, payload_envelope_json = ?, updated_at = ? WHERE account_id = ? AND id = ?", state, code, Number(uncertain), envelope, store.now(), store.accountId, row.id);
    return { ...row, state, code, uncertain, result };
  };
  function assertScope(row) {
    assertActive(); assertScopeWritable(store, row.scope_id);
    if (row.conversation_id && isConversationRevoked(store, row.conversation_id)) throw Object.assign(new Error("Access revoked"), { code: "COLLAB_ACCESS_REVOKED" });
  }
  function authorizedView(row) {
    assertActive();
    if (!row) return invalid("COLLAB_ACCESS_REVOKED");
    try { assertScope(row); } catch (error) {
      if (error.code === "COLLAB_ACCESS_REVOKED") return invalid(error.code);
      throw error;
    }
    if (row.result?.conversationId && isConversationRevoked(store, row.result.conversationId)) return invalid("COLLAB_ACCESS_REVOKED");
    return view(row);
  }
  async function dispatch(id) {
    assertActive();
    let row = get(id);
    if (!row) return invalid("COLLABORATION_NOT_FOUND");
    if (["completed", "failed"].includes(row.state)) return authorizedView(row);
    assertScope(row);
    // Receipts are partitioned by device as well as user and command ID.
    // Never turn a changed device into a second execution of unknown work.
    if (row.deviceId !== deviceId) return { ...view(row), state: "confirming", code: "COLLAB_DEVICE_CHANGED" };
    const transport = row.kind === "friend" ? client?.submitFriend : client?.submitConversation;
    if (!transport || !deviceId) return { ...view(row), code: "COLLABORATION_UNAVAILABLE" };
    const priorUncertain = Boolean(row.uncertain);
    row = save(row, "submitting", { uncertain: true }); // commit before transport
    try {
      const response = await transport.call(client, { ...row.input, clientCommandId: row.id, deviceId });
      assertActive();
      // Revocation can delete the intent during transport. Never recreate it
      // or reissue its destroyed scope key in a late callback.
      if (!get(id)) return invalid("COLLAB_ACCESS_REVOKED");
      assertScope(row);
      const result = response?.result ?? response;
      if (response?.ok === false || !completeReceipt(row, result)) throw Object.assign(new Error("Unknown receipt"), { code: "COLLAB_RESPONSE_UNKNOWN" });
      row = save(row, "completed", { uncertain: false, result: { ...(typeof result.conversationId === "string" ? { conversationId: result.conversationId } : {}), ...(typeof result.status === "string" ? { status: result.status } : {}) } });
    } catch (error) {
      assertActive();
      if (!get(id)) return invalid("COLLAB_ACCESS_REVOKED");
      const code = String(error.code || "COLLAB_RESPONSE_UNKNOWN");
      const rejected = !priorUncertain && permanent(code);
      row = save(row, rejected ? "failed" : "confirming", { code: rejected ? code : "COLLAB_RESPONSE_UNKNOWN", uncertain: !rejected });
      onChange(); return view(row);
    }
    onChange();
    // Projection availability never reverses positive commit evidence.
    try { await onConfirmed(row.result); } catch { /* cached view remains available */ }
    assertActive();
    // Refresh can revoke/delete this command or its resulting conversation.
    // Retain commit evidence, but never return an obsolete navigation target.
    return authorizedView(get(id));
  }
  function retry({ clientCommandId } = {}) {
    assertActive();
    if (!supported) return Promise.resolve(invalid("COLLABORATION_UNAVAILABLE"));
    if (inFlight.has(clientCommandId)) return inFlight.get(clientCommandId);
    const task = Promise.resolve().then(() => dispatch(clientCommandId));
    inFlight.set(clientCommandId, task);
    task.finally(() => { if (inFlight.get(clientCommandId) === task) inFlight.delete(clientCommandId); }).catch(() => {});
    return task;
  }
  return {
    list() {
      assertActive();
      if (!supported) return invalid("COLLABORATION_UNAVAILABLE");
      return { ok: true, commands: store.db.all("SELECT * FROM social_commands WHERE account_id = ? AND state NOT IN ('completed', 'failed') ORDER BY created_at, id", store.accountId)
        .map(read).map((row) => ({ ...view(row), kind: row.kind, scopeId: row.scope_id, input: row.input })) };
    },
    retry,
    submit(kind, command) {
      assertActive();
      if (!supported) return Promise.resolve(invalid("COLLABORATION_UNAVAILABLE"));
      const normalized = normalizeSocialCommand(kind, command);
      if (!normalized) return Promise.resolve(invalid());
      const { clientCommandId, ...input } = normalized;
      const fingerprint = createHash("sha256").update(JSON.stringify({ kind, input })).digest("hex");
      const prepare = store.db.transaction(() => {
        const existing = clientCommandId ? get(clientCommandId) : null;
        if (existing) return existing.fingerprint === fingerprint ? existing.id : null;
        const pending = store.db.get("SELECT id FROM social_commands WHERE account_id = ? AND fingerprint = ? AND state NOT IN ('completed','failed')", store.accountId, fingerprint);
        if (pending) return pending.id;
        const conversation = ["member", "dissolve"].includes(input.action) ? store.getConversation({ conversationId: input.conversationId }) : null;
        if (["member", "dissolve"].includes(input.action) && !conversation) throw Object.assign(new Error("Not found"), { code: "COLLABORATION_NOT_FOUND" });
        const scopeId = conversation?.scopeId || (input.scopeType === "organization" ? `team:${input.organizationId}` : "personal");
        assertScopeWritable(store, scopeId);
        if (scopeId.startsWith("team:") && !store.getDirectory().teams.some((team) => team.scopeId === scopeId)) throw Object.assign(new Error("Access revoked"), { code: "COLLAB_ACCESS_REVOKED" });
        const id = clientCommandId || randomUUID();
        const envelope = store._encrypt({ scopeId, recordId: `social:${id}`, value: { input, result: null, deviceId } });
        store.db.run("INSERT INTO social_commands(account_id,id,kind,fingerprint,scope_id,conversation_id,state,payload_envelope_json,created_at,updated_at) VALUES (?,?,?,?,?,?,'queued',?,?,?)", store.accountId, id, kind, fingerprint, scopeId, input.conversationId || null, envelope, store.now(), store.now());
        return id;
      });
      const id = prepare();
      return id ? retry({ clientCommandId: id }) : Promise.resolve(invalid("IDEMPOTENCY_KEY_REUSED"));
    },
  };
}
module.exports = { createSocialCommands };
