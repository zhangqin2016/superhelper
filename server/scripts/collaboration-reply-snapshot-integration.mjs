import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import pg from "pg";
import Fastify from "fastify";

if (!process.env.DATABASE_URL) {
  console.log("collaboration reply snapshot integration: skipped (DATABASE_URL is not configured)");
  process.exit(0);
}
const schema = `collab_quote_${crypto.randomUUID().replaceAll("-", "")}`;
const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const scoped = new URL(process.env.DATABASE_URL);
scoped.searchParams.set("options", `-c search_path=${schema}`);
scoped.searchParams.set("application_name", schema);
const kek = crypto.randomBytes(32);
Object.assign(process.env, {
  DATABASE_URL: scoped.href, SESSION_SECRET: crypto.randomBytes(32).toString("hex"),
  COLLABORATION_ENABLED: "true", COLLABORATION_KILL_SWITCH: "false", COLLABORATION_ROLLOUT_ORGANIZATIONS: "",
  COLLAB_MESSAGE_KEK: kek.toString("hex"), COLLAB_MESSAGE_KEK_VERSION: "v1",
});
const [{ db, pool, closeDb }, { registerCollaborationRoutes }, { createAccessToken }, { stableStringify, sha256 }, { installDocOnlyCompilers }] = await Promise.all([
  import("../src/db.js"), import("../src/routes/public/collaboration.js"), import("../src/services/account-auth.js"),
  import("../src/services/security.js"), import("../src/openapi.js"),
]);
const app = Fastify({ logger: false });
installDocOnlyCompilers(app);
const identities = new Map();
const require = createRequire(import.meta.url);
const { CollaborationStore } = require("../../src/main/collaboration/collaboration-store.js");
const { LocalCollaborationKeyring } = require("../../src/main/collaboration/local-keyring.js");
const { createCollaborationSyncEngine } = require("../../src/main/collaboration/sync-engine.js");
const localDir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-quote-membership-pg-"));
let lateStore;
async function request(userId, input, pathname = "/api/collaboration/v1/messages") {
  const deviceId = `device-${userId}`, key = identities.get(userId);
  const body = { deviceId, conversationId: "group", ...input };
  const timestamp = new Date().toISOString(), nonce = crypto.randomUUID(), bodyHash = sha256(stableStringify(body));
  const signature = crypto.sign(null, Buffer.from(stableStringify({ method: "POST", pathname, timestamp, nonce, bodyHash })), key.privateKey).toString("base64url");
  const response = await app.inject({ method: "POST", url: pathname, payload: body, headers: {
    authorization: `Bearer ${createAccessToken({ userId, deviceId, sessionId: `session-${userId}` })}`,
    "x-lily-device-id": deviceId, "x-lily-timestamp": timestamp, "x-lily-nonce": nonce,
    "x-lily-body-sha256": bodyHash, "x-lily-signature": signature,
  } });
  return { status: response.statusCode, body: response.json() };
}
async function command(userId, input, pathname) {
  const response = await request(userId, input, pathname);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.result;
}
async function history(userId, messageId) {
  return (await command(userId, { action: "history", clientCommandId: crypto.randomUUID(), messageIds: [messageId] })).messages[0];
}

try {
  await admin.query(`create schema ${schema}`);
  await pool.query(`
    create table users(id text primary key); create table devices(id text primary key);
    create table user_devices(user_id text,device_id text,status text,primary key(user_id,device_id));
    create table user_profiles(user_id text primary key,lily_id text,display_name text,avatar_object_id text,discoverability text);
    create table organizations(id text primary key,name text,status text);
    create table organization_members(organization_id text,user_id text,role text,status text,joined_at timestamptz default now(),primary key(organization_id,user_id));
    create table device_public_keys(device_id text primary key,public_key text);
    create table request_nonces(device_id text,nonce text,created_at timestamptz default now(),primary key(device_id,nonce));
    create table user_sessions(id text primary key,user_id text,device_id text,revoked_at timestamptz,expires_at timestamptz);
  `);
  for (const migration of ["033_collaboration_core.sql", "035_collaboration_bootstrap_completion.sql", "037_collaboration_relationship_events.sql", "038_collaboration_conversations.sql", "040_collaboration_trusted_actors.sql", "041_collaboration_reply_snapshots.sql"]) {
    await pool.query(fs.readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  }
  for (const userId of ["alice", "bob", "late"]) {
    const key = crypto.generateKeyPairSync("ed25519"); identities.set(userId, key);
    await pool.query("insert into users values($1)", [userId]);
    await pool.query("insert into devices values($1)", [`device-${userId}`]);
    await pool.query("insert into user_devices values($1,$2,'active')", [userId, `device-${userId}`]);
    await pool.query("insert into user_profiles values($1,$1,$1,null,'contacts')", [userId]);
    await pool.query("insert into user_sessions values($1,$2,$3,null,now()+interval '1 hour')", [`session-${userId}`, userId, `device-${userId}`]);
    await pool.query("insert into device_public_keys values($1,$2)", [`device-${userId}`, key.publicKey.export({ type: "spki", format: "pem" })]);
  }
  await pool.query(`insert into conversations(id,scope_type,kind,created_by) values('group','personal','group','bob');
    insert into conversation_members(conversation_id,user_id,role) values('group','alice','member'),('group','bob','owner');`);
  registerCollaborationRoutes(app, { database: db });
  const source = (await command("bob", { action: "send", clientCommandId: "source", bodyText: "original quote body" })).message;
  const replyInput = { action: "send", clientCommandId: "reply", bodyText: "reply body", replyToMessageId: source.id };
  const sent = await command("alice", replyInput);
  const originalSnapshot = (await history("bob", sent.message.id)).replySnapshot;
  assert.deepEqual(originalSnapshot, { status: "available", messageId: source.id, revision: 1, senderUserId: "bob", createSeq: source.seq,
    kind: "text", bodyText: "original quote body", truncated: false }, "signed history returns the actual send-time quote, not only its target ID");
  const snapshotRow = async (messageId) => (await pool.query("select reply_snapshot_ciphertext,reply_snapshot_key_version from messages where id=$1", [messageId])).rows[0];
  const originalCipher = await snapshotRow(sent.message.id);
  assert.equal(Buffer.from(originalCipher.reply_snapshot_ciphertext).includes(Buffer.from("original quote body")), false);
  assert.equal(originalCipher.reply_snapshot_key_version, 1);
  const storedMetadata = await pool.query("select payload::text as value from collaboration_events union all select response_payload::text from command_receipts");
  assert.equal(storedMetadata.rows.some((row) => row.value.includes("original quote body")), false, "events and receipts never duplicate quote plaintext");
  const { createCollaborationMessageCrypto } = await import("../src/services/collaboration/message-crypto.js");
  const messageCrypto = createCollaborationMessageCrypto({ currentKekVersion: 1, kekByVersion: { 1: kek } });
  const encryptedQuote = { ciphertext: originalCipher.reply_snapshot_ciphertext, keyVersion: originalCipher.reply_snapshot_key_version, messageId: sent.message.id, conversationId: "group" };
  assert.throws(() => messageCrypto.decrypt({ ...encryptedQuote, revision: 1 }), (error) => error.code === "COLLAB_MESSAGE_CIPHERTEXT_INVALID", "quote ciphertext cannot be used as an ordinary message body");
  assert.throws(() => messageCrypto.decryptReplySnapshot({ ...encryptedQuote, conversationId: "other" }), (error) => error.code === "COLLAB_MESSAGE_CIPHERTEXT_INVALID");
  await command("bob", { action: "edit", clientCommandId: "edit-source", messageId: source.id, expectedRevision: 1, bodyText: "changed original body" });
  assert.deepEqual((await history("bob", sent.message.id)).replySnapshot, originalSnapshot, "editing the source cannot rewrite a sent quote");
  assert.deepEqual(await command("alice", replyInput), sent, "same-key replay returns the original receipt");
  assert.deepEqual(await snapshotRow(sent.message.id), originalCipher, "receipt replay must not rotate or regenerate the quote envelope");
  await command("alice", { action: "edit", clientCommandId: "edit-reply", messageId: sent.message.id, expectedRevision: 1, bodyText: "changed reply body" });
  assert.deepEqual((await history("bob", sent.message.id)).replySnapshot, originalSnapshot, "editing the reply body cannot change the quote's encryption revision");
  await command("bob", { action: "member", clientCommandId: "join-late", targetUserId: "late", operation: "add" }, "/api/collaboration/v1/conversations");
  const newReply = (await command("alice", { ...replyInput, clientCommandId: "reply-after-join" })).message;
  assert.deepEqual((await history("late", newReply.id)).replySnapshot, { status: "unavailable" }, "a new reply cannot reveal a pre-join source to a new member");
  lateStore = new CollaborationStore({ dbPath: path.join(localDir, "cache.db"), accountId: "late",
    keyring: new LocalCollaborationKeyring({ filePath: path.join(localDir, "keys"), safeStorage: {
      isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString(),
    } }),
  });
  const lateBootstrap = await request("late", {}, "/api/collaboration/v1/bootstrap");
  assert.equal(lateBootstrap.status, 200);
  lateStore.replaceProjectionFromBootstrap({ ...lateBootstrap.body, history: [], requireHistoryHydration: true });
  lateStore.hydrateAuthorizedHistory({ conversationId: "group", messages: [await history("late", newReply.id)] });
  assert.deepEqual(lateStore.getMessage({ conversationId: "group", messageId: newReply.id }).replySnapshot, { status: "unavailable" });
  assert.equal((await request("late", { clientCommandId: "late-bootstrap-ack", cursor: lateBootstrap.body.watermark,
    bootstrapCompletionToken: lateBootstrap.body.bootstrapCompletionToken }, "/api/collaboration/v1/ack")).status, 200);
  assert.equal((await history("bob", newReply.id)).replySnapshot.bodyText, "changed original body", "authorized recipients receive the later send's own snapshot");
  const laterCipher = await snapshotRow(newReply.id);
  await pool.query("update messages set reply_snapshot_ciphertext=$1 where id=$2", [originalCipher.reply_snapshot_ciphertext, newReply.id]);
  try {
    const transplanted = await request("bob", { action: "history", clientCommandId: "transplanted", messageIds: [newReply.id] });
    assert.equal(transplanted.body.code, "COLLAB_MESSAGE_CIPHERTEXT_INVALID", "the signed route rejects an envelope copied from another reply");
    assert.equal(transplanted.body.result, undefined);
  } finally {
    await pool.query("update messages set reply_snapshot_ciphertext=$1 where id=$2", [laterCipher.reply_snapshot_ciphertext, newReply.id]);
  }
  const legacyReply = (await command("alice", { ...replyInput, clientCommandId: "legacy-reply" })).message;
  await pool.query("update messages set reply_snapshot_ciphertext=null,reply_snapshot_key_version=null where id=$1", [legacyReply.id]);
  assert.deepEqual((await history("bob", legacyReply.id)).replySnapshot, { status: "unavailable", reason: "legacy" }, "upgraded replies without a snapshot cannot invent a send-time quote");
  const longSource = (await command("bob", { action: "send", clientCommandId: "long-source", bodyText: "🙂".repeat(513) })).message;
  const longReply = (await command("alice", { ...replyInput, clientCommandId: "long-reply", replyToMessageId: longSource.id })).message;
  const bounded = (await history("bob", longReply.id)).replySnapshot;
  assert.equal(bounded.bodyText, "🙂".repeat(512)); assert.equal(Buffer.byteLength(bounded.bodyText), 2048); assert.equal(bounded.truncated, true);
  const forged = await request("alice", { ...replyInput, clientCommandId: "forged-reply", replySnapshot: { bodyText: "forged source" } });
  assert.notEqual(forged.status, 200, "a client-supplied snapshot is not an admitted source of quote authority");
  const counts = async () => (await pool.query(`select (select count(*) from messages) as messages,
    (select count(*) from collaboration_events) as events,(select count(*) from command_receipts) as receipts,
    (select next_seq from conversations where id='group') as next_seq`)).rows[0];
  const beforeRollback = await counts();
  await pool.query(`create function reject_quote_fixture() returns trigger language plpgsql as $$
    begin if NEW.reply_to_message_id is not null then raise exception 'fixture insert rollback'; end if; return NEW; end $$;
    create trigger reject_quote_fixture before insert on messages for each row execute function reject_quote_fixture();`);
  try {
    assert.notEqual((await request("alice", { ...replyInput, clientCommandId: "rollback-reply" })).status, 200);
    assert.deepEqual(await counts(), beforeRollback, "failed reply insertion rolls back its event, receipt, sequence and encrypted projection");
  } finally { await pool.query("drop trigger reject_quote_fixture on messages; drop function reject_quote_fixture()"); }
  await command("bob", { action: "revoke", clientCommandId: "revoke-source", messageId: source.id, expectedRevision: 2 });
  assert.deepEqual((await history("alice", sent.message.id)).replySnapshot, { status: "revoked" }, "source revocation masks earlier encrypted quotes");
  assert.deepEqual((await history("late", newReply.id)).replySnapshot, { status: "unavailable" }, "invisible source metadata is not disclosed after revocation either");
  const latePage = await request("late", { afterCursor: lateStore.getSyncState().cursor }, "/api/collaboration/v1/sync");
  assert.equal(latePage.status, 200);
  assert.equal(latePage.body.status, "OK");
  assert.equal(latePage.body.events.some((event) => event.type === "message.revoked" && event.payload.messageId === source.id), true);
  createCollaborationSyncEngine({ store: lateStore }).applyPage(latePage.body);
  assert.deepEqual(lateStore.getMessage({ conversationId: "group", messageId: newReply.id }).replySnapshot, { status: "unavailable" },
    "a real revoke sync event cannot upgrade a pre-join unavailable quote to a more revealing revoked status");
  await command("alice", { action: "revoke", clientCommandId: "revoke-reply", messageId: sent.message.id, expectedRevision: 2 });
  assert.deepEqual(await snapshotRow(sent.message.id), { reply_snapshot_ciphertext: null, reply_snapshot_key_version: null }, "revoking the reply clears its quote envelope as well as its body");
  assert.deepEqual((await history("bob", sent.message.id)).replySnapshot, { status: "unavailable" });
  const deletedSource = (await command("bob", { action: "send", clientCommandId: "deleted-source", bodyText: "delete fixture source" })).message;
  const orphanReply = (await command("alice", { ...replyInput, clientCommandId: "orphan-reply", replyToMessageId: deletedSource.id })).message;
  await pool.query("delete from messages where id=$1", [deletedSource.id]);
  assert.equal((await pool.query("select reply_to_message_id from messages where id=$1", [orphanReply.id])).rows[0].reply_to_message_id, null);
  assert.deepEqual((await history("bob", orphanReply.id)).replySnapshot, { status: "unavailable" }, "source deletion preserves the existing FK and never decrypts an orphaned quote");
  await command("alice", { action: "revoke", clientCommandId: "revoke-orphan-reply", messageId: orphanReply.id, expectedRevision: 1 });
  const revokedOrphan = await history("bob", orphanReply.id);
  assert.equal(revokedOrphan.replySnapshot, null, "after source deletion and reply revocation, no quote identity or ciphertext remains");
  assert.equal(revokedOrphan.bodyText, null);
  assert.deepEqual(await snapshotRow(orphanReply.id), { reply_snapshot_ciphertext: null, reply_snapshot_key_version: null });

  // Hold real SQL writes after source capture (INSERT) or inside a source
  // mutation (UPDATE). No repository mocks or sleeps establish the ordering:
  // pg_blocking_pids must prove both links in the wait chain before release.
  await pool.query(`create table quote_race_barriers(source_id text primary key,edge text,lock_id bigint);
    create function quote_race_barrier() returns trigger language plpgsql as $$
    declare barrier bigint;
    begin
      select lock_id into barrier from quote_race_barriers where
        (edge='reply' and TG_OP='INSERT' and source_id=NEW.reply_to_message_id) or
        (edge='mutation' and TG_OP='UPDATE' and source_id=NEW.id);
      if barrier is not null then perform pg_advisory_xact_lock(barrier); end if;
      return NEW;
    end $$;
    create trigger quote_race_barrier before insert or update on messages for each row execute function quote_race_barrier();`);
  async function blockedBy(pid, queryFragment) {
    const deadline = Date.now() + 1200;
    while (Date.now() < deadline) {
      const result = await admin.query(`select pid,query from pg_stat_activity where application_name=$1
        and wait_event_type='Lock' and $2::int=any(pg_blocking_pids(pid)) and query like $3`, [schema, pid, `%${queryFragment}%`]);
      if (result.rows.length) return result.rows[0].pid;
    }
    assert.fail(`Expected a real ${queryFragment} lock waiter behind pid ${pid}`);
  }
  for (const action of ["edit", "revoke"]) for (const first of ["reply", "mutation"]) {
    const prefix = `race-${action}-${first}`;
    const raceSource = (await command("bob", { action: "send", clientCommandId: `${prefix}-source`, bodyText: "before race" })).message;
    const reply = { action: "send", clientCommandId: `${prefix}-reply`, replyToMessageId: raceSource.id, bodyText: "race answer" };
    const mutation = { action, clientCommandId: `${prefix}-mutation`, messageId: raceSource.id, expectedRevision: 1,
      ...(action === "edit" ? { bodyText: "after race" } : {}) };
    const lockId = crypto.randomInt(1, 2 ** 30), gate = await pool.connect();
    let replyPending, mutationPending;
    try {
      const { rows: [{ pid }] } = await gate.query("select pg_backend_pid() as pid");
      await gate.query("select pg_advisory_lock($1::bigint)", [lockId]);
      await pool.query("insert into quote_race_barriers values($1,$2,$3)", [raceSource.id, first, lockId]);
      if (first === "reply") replyPending = request("alice", reply); else mutationPending = request("bob", mutation);
      const firstPid = await blockedBy(pid, first === "reply" ? 'insert into "messages"' : 'update "messages"');
      if (first === "reply") mutationPending = request("bob", mutation); else replyPending = request("alice", reply);
      await blockedBy(firstPid, 'from "conversations"');
    } finally {
      await gate.query("select pg_advisory_unlock($1::bigint)", [lockId]); gate.release();
      await Promise.allSettled([replyPending, mutationPending]);
      await pool.query("delete from quote_race_barriers where source_id=$1", [raceSource.id]);
    }
    const [replyResult, mutationResult] = await Promise.all([replyPending, mutationPending]);
    assert.equal(mutationResult.status, 200, JSON.stringify(mutationResult.body));
    assert.equal((await pool.query("select count(*)::int as n from collaboration_events where client_command_id=$1", [mutation.clientCommandId])).rows[0].n, 1, "waiting mutation commits exactly once");
    if (action === "revoke" && first === "mutation") {
      assert.equal(replyResult.body.code, "COLLAB_REPLY_TARGET_INVALID", "a quote cannot capture a source after its revocation commits");
      assert.equal(replyResult.body.result, undefined);
      assert.equal((await pool.query("select count(*)::int as n from command_receipts where client_command_id=$1", [reply.clientCommandId])).rows[0].n, 0, "rejected quote leaves no committed receipt");
    } else {
      assert.equal(replyResult.status, 200, JSON.stringify(replyResult.body));
      assert.equal(replyResult.body.result.message.seq < mutationResult.body.result.message.seq, first === "reply", "server event order follows the observed SQL lock order");
      const messageId = replyResult.body.result.message.id, cipher = await snapshotRow(messageId);
      const captured = JSON.parse(messageCrypto.decryptReplySnapshot({ ciphertext: cipher.reply_snapshot_ciphertext,
        keyVersion: cipher.reply_snapshot_key_version, messageId, conversationId: "group" }).toString("utf8"));
      assert.equal(captured.bodyText, first === "reply" ? "before race" : "after race");
      assert.equal(captured.revision, first === "reply" ? 1 : 2, "snapshot revision matches the serialized source body");
      const visible = (await history("alice", messageId)).replySnapshot;
      if (action === "revoke") assert.deepEqual(visible, { status: "revoked" }, "committed source revoke masks the already-captured quote");
      else assert.equal(visible.bodyText, captured.bodyText);
      assert.equal((await pool.query("select count(*)::int as n from collaboration_events where client_command_id=$1", [reply.clientCommandId])).rows[0].n, 1);
    }
  }
  console.log("collaboration reply snapshot integration: signed immutable quotes, receipt replay, body edits and per-recipient visibility passed");
  console.log("collaboration reply snapshot concurrency: four real PostgreSQL lock-chain orders passed");
} finally {
  lateStore?.close();
  await app.close(); await closeDb(); await admin.query(`drop schema if exists ${schema} cascade`); await admin.end();
  fs.rmSync(localDir, { recursive: true, force: true });
}
