#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";

if (!process.env.DATABASE_URL) { console.log("collaboration Team integration: skipped (DATABASE_URL is not configured)"); process.exit(0); }
const [{ default: pg }, { Kysely, PostgresDialect }, { createKyselyConversationRepository }, { createCollaborationConversationService }, { createCollaborationTeamScopeService }, { createCollaborationMessageService, createHmacMessageBodyIntentSigner }, { createKyselyMessageRepository, createLockedMessageAuthorizer }, { createCollaborationMessageCrypto }] = await Promise.all([
  import("pg"), import("kysely"), import("../src/services/collaboration/conversation-repository.js"), import("../src/services/collaboration/conversations.js"), import("../src/services/collaboration/team-scopes.js"), import("../src/services/collaboration/messages.js"), import("../src/services/collaboration/message-repository.js"), import("../src/services/collaboration/message-crypto.js"),
]);
const schema = `collab_team_it_${crypto.randomUUID().replaceAll("-", "")}`;
const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}`, application_name: schema });
const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
const account = (userId) => ({ userId, deviceId: `device-${userId}` });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
try {
  await admin.query(`create schema ${schema}`);
  await pool.query(`
    create table users(id text primary key);
    create table devices(id text primary key);
    create table user_devices(user_id text references users(id), device_id text references devices(id), status text not null default 'active', primary key(user_id,device_id));
    create table organizations(id text primary key,status text not null check(status in ('active','disabled')));
    create table organization_members(organization_id text references organizations(id),user_id text references users(id),role text not null check(role in ('owner','admin','member')),status text not null check(status in ('active','disabled')),primary key(organization_id,user_id));
  `);
  for (const migration of ["033_collaboration_core.sql", "037_collaboration_relationship_events.sql", "038_collaboration_conversations.sql"]) {
    await pool.query(await readFile(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  }
  for (const id of ["a", "b", "c", "d", "outsider"]) {
    await pool.query("insert into users values($1)", [id]);
    await pool.query("insert into devices values($1)", [`device-${id}`]);
    await pool.query("insert into user_devices(user_id,device_id) values($1,$2)", [id, `device-${id}`]);
  }
  await pool.query("insert into organizations values('org','active'); insert into organization_members values('org','a','owner','active'),('org','b','admin','active'),('org','c','member','active'),('org','d','member','active')");
  const repository = createKyselyConversationRepository(db);
  const service = createCollaborationConversationService({ repository });
  const scopes = createCollaborationTeamScopeService({ repository });
  const messages = createCollaborationMessageService({ repository: createKyselyMessageRepository(db), messageCrypto: createCollaborationMessageCrypto({ currentKekVersion: 1, kekByVersion: { 1: Buffer.alloc(32, 7) } }), bodyIntentSigner: createHmacMessageBodyIntentSigner({ key: Buffer.alloc(32, 8) }) });
  const send = (userId, conversationId, clientCommandId) => messages.sendMessage({ account: account(userId), conversationId, clientCommandId, bodyText: "private-body", authorize: createLockedMessageAuthorizer(), database: db });
  const decision = (userId, conversationId, action = "read") => db.transaction().execute((trx) => repository.authorizeAction({ trx, account: account(userId), input: { conversationId }, action }));
  const create = (userId, clientCommandId, fields) => service.createConversation({ account: account(userId), clientCommandId, ...fields });
  const change = (userId, conversationId, clientCommandId, operation, targetUserId, role) => service.mutateMember({ account: account(userId), conversationId, clientCommandId, operation, targetUserId, role });
  const count = async (table) => Number((await pool.query(`select count(*) as n from ${table}`)).rows[0].n);

  const groupInput = { scopeType: "personal", kind: "group", title: "Group", memberUserIds: ["a", "c"] };
  const group = await create("a", "group-create", groupInput);
  assert.deepEqual(await create("a", "group-create", groupInput), group, "same command receipt replays unchanged");
  await assert.rejects(create("a", "group-create", { ...groupInput, title: "Different" }), (e) => e.code === "IDEMPOTENCY_KEY_REUSED");
  await assert.rejects(change("c", group.conversationId, "cannot-invite", "add", "d"));
  await send("a", group.conversationId, "before-join");
  const joined = await change("a", group.conversationId, "join-d", "add", "d");
  const joinedRow = (await pool.query("select joined_seq from conversation_members where conversation_id=$1 and user_id='d'", [group.conversationId])).rows[0];
  assert.ok(Number(joinedRow.joined_seq) > 1);
  assert.equal((await decision("d", group.conversationId)).visibleAfterSeq, Number(joinedRow.joined_seq));
  const afterJoinEvents = await count("collaboration_events");
  await change("a", group.conversationId, "join-d-again", "add", "d");
  assert.equal(await count("collaboration_events"), afterJoinEvents, "active member re-add emits no duplicate event");
  await change("a", group.conversationId, "promote-c", "role", "c", "admin");
  await assert.rejects(change("c", group.conversationId, "remove-owner", "remove", "a"));
  await change("c", group.conversationId, "remove-d", "remove", "d");
  assert.equal((await decision("d", group.conversationId)).ok, false);
  const oldBoundary = Number(joinedRow.joined_seq);
  await change("a", group.conversationId, "rejoin-d", "add", "d");
  assert.ok((await decision("d", group.conversationId)).visibleAfterSeq > oldBoundary, "rejoin never exposes the absence interval");
  await change("a", group.conversationId, "promote-d", "role", "d", "admin");
  await change("a", group.conversationId, "remove-admin-d", "remove", "d");
  const rejoinedAdmin = await change("a", group.conversationId, "rejoin-admin-d", "add", "d");
  assert.equal((await pool.query("select payload from collaboration_events where id=$1", [rejoinedAdmin.eventId])).rows[0].payload.role, "member", "rejoin event agrees with projection's reset role");

  // A projection failure must roll back its earlier event, receipt and cursor.
  const failureService = createCollaborationConversationService({ repository: { ...repository, async addMember() { throw new Error("injected projection failure"); } } });
  const beforeFailure = await Promise.all(["conversations", "collaboration_events", "command_receipts", "user_sync_events", "collaboration_realtime_outbox"].map(count));
  await assert.rejects(failureService.createConversation({ account: account("a"), clientCommandId: "projection-failure", ...groupInput }), /injected projection failure/);
  assert.deepEqual(await Promise.all(["conversations", "collaboration_events", "command_receipts", "user_sync_events", "collaboration_realtime_outbox"].map(count)), beforeFailure);
  await create("a", "projection-failure", groupInput);

  // The conversation lock protects cardinality even for different command ids.
  await pool.query("insert into users(id) select 'capacity-' || n from generate_series(1,200) n");
  const almostFull = await create("a", "capacity-group", { ...groupInput, memberUserIds: Array.from({ length: 198 }, (_, n) => `capacity-${n + 1}`) });
  const capacityResults = await Promise.allSettled([change("a", almostFull.conversationId, "capacity-add-199", "add", "capacity-199"), change("a", almostFull.conversationId, "capacity-add-200", "add", "capacity-200")]);
  assert.equal(capacityResults.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(capacityResults.find((result) => result.status === "rejected").reason.code, "COLLAB_MEMBER_LIMIT");
  assert.equal(Number((await pool.query("select count(*) as n from conversation_members where conversation_id=$1 and status='active'", [almostFull.conversationId])).rows[0].n), 200);

  const directInput = { scopeType: "organization", organizationId: "org", kind: "direct", memberUserIds: ["a", "c"] };
  const directs = await Promise.all([create("a", "direct-a", directInput), create("c", "direct-c", { ...directInput, memberUserIds: ["c", "a"] })]);
  assert.equal(directs[0].conversationId, directs[1].conversationId, "crossed Team direct creates share one canonical conversation");
  assert.equal(Number((await pool.query("select count(*) as n from collaboration_events where type='conversation.created' and conversation_id=$1", [directs[0].conversationId])).rows[0].n), 1);
  await send("c", directs[0].conversationId, "no-friendship-needed");
  await pool.query("insert into user_blocks(blocker_user_id,blocked_user_id) values('a','c')");
  await assert.rejects(send("c", directs[0].conversationId, "blocked-direct"), (e) => e.code === "COLLAB_BLOCKED");
  await pool.query("delete from user_blocks where blocker_user_id='a' and blocked_user_id='c'");

  const publicInput = { scopeType: "organization", organizationId: "org", kind: "channel", visibility: "public", title: "Public" };
  await assert.rejects(create("c", "public-denied", publicInput));
  const pub = await create("b", "public-created", publicInput);
  assert.equal((await decision("d", pub.conversationId)).ok, true, "public access derives from org roster, not explicit membership");
  assert.deepEqual(await db.transaction().execute((trx) => repository.activeConversationMemberIds(trx, pub.conversationId)), ["a", "b", "c", "d"]);
  assert.equal((await decision("outsider", pub.conversationId)).ok, false);
  const publicMessage = await send("c", pub.conversationId, "public-send");
  assert.equal(Number((await pool.query("select count(*) as n from user_sync_events where event_id=$1", [publicMessage.eventId])).rows[0].n), 4);
  const readPublic = await messages.markConversationRead({ account: account("d"), conversationId: pub.conversationId, submittedSeq: publicMessage.message.seq, clientCommandId: "read-public", authorize: createLockedMessageAuthorizer(), database: db });
  assert.equal(readPublic.lastReadSeq, publicMessage.message.seq, "public read pointer materializes without an explicit channel invitation");
  const staleRead = await messages.markConversationRead({ account: account("d"), conversationId: pub.conversationId, submittedSeq: 0, clientCommandId: "read-public-stale", authorize: createLockedMessageAuthorizer(), database: db });
  assert.equal(staleRead.lastReadSeq, readPublic.lastReadSeq);
  const beforeHugeRead = Number((await pool.query("select next_seq from conversations where id=$1", [pub.conversationId])).rows[0].next_seq) - 1;
  const hugeRead = await messages.markConversationRead({ account: account("d"), conversationId: pub.conversationId, submittedSeq: Number.MAX_SAFE_INTEGER, clientCommandId: "read-public-huge", authorize: createLockedMessageAuthorizer(), database: db });
  const hugeEvent = (await pool.query("select payload from collaboration_events where id=$1", [hugeRead.eventId])).rows[0];
  const persistedRead = Number((await pool.query("select last_read_seq from conversation_members where conversation_id=$1 and user_id='d'", [pub.conversationId])).rows[0].last_read_seq);
  assert.equal(hugeEvent.payload.lastReadSeq, persistedRead, "durable event and database must agree even for an excessive submitted seq");
  assert.equal(persistedRead, beforeHugeRead, "read cannot acknowledge its own event or future events");
  assert.equal(hugeRead.lastReadSeq, persistedRead);
  await assert.rejects(change("a", pub.conversationId, "public-explicit-member-denied", "add", "outsider"));

  const priv = await create("c", "private-created", { ...publicInput, visibility: "private", memberUserIds: ["c", "d"] });
  assert.equal((await decision("a", priv.conversationId)).ok, false, "org owner is not implicitly a private reader");
  assert.equal((await decision("a", priv.conversationId, "audit")).ok, true);
  await assert.rejects(change("a", priv.conversationId, "private-org-owner-denied", "add", "b"));
  await assert.rejects(change("c", priv.conversationId, "private-outsider-denied", "add", "outsider"));

  // The shipped default message authorizer, not a test-only replacement, must
  // take Organization before Conversation just like member mutations.
  const memberLocked = deferred(), releaseMember = deferred();
  const memberRace = createCollaborationConversationService({ repository: { ...repository, async changeMember(...args) { memberLocked.resolve(); await releaseMember.promise; return repository.changeMember(...args); } } });
  const removing = memberRace.mutateMember({ account: account("c"), conversationId: priv.conversationId, targetUserId: "d", operation: "remove", clientCommandId: "member-race-remove" });
  await memberLocked.promise;
  const blockedSend = send("d", priv.conversationId, "member-race-send").then(() => ({ ok: true }), (error) => ({ error }));
  try {
    let waiting = false;
    for (let i = 0; i < 200 && !waiting; i++) waiting = Number((await admin.query("select count(*) as n from pg_stat_activity where application_name=$1 and wait_event_type='Lock'", [schema])).rows[0].n) > 0;
    assert.equal(waiting, true);
  } finally { releaseMember.resolve(); }
  await removing;
  assert.equal((await blockedSend).error?.code, "COLLAB_MEMBERSHIP_INACTIVE");
  await change("c", priv.conversationId, "member-race-readd", "add", "d");

  for (const code of ["40P01", "40001"]) {
    let attempts = 0;
    const retrying = createCollaborationConversationService({ repository: { ...repository, async lockTeamScope(...args) {
      if (++attempts === 1) throw Object.assign(new Error("injected transaction restart"), { code });
      return repository.lockTeamScope(...args);
    } } });
    const response = await retrying.createConversation({ account: account("b"), clientCommandId: `retry-${code}`, ...publicInput });
    assert.equal(attempts, 2);
    assert.equal(Number((await pool.query("select count(*) as n from collaboration_events where conversation_id=$1", [response.conversationId])).rows[0].n), 1);
    assert.equal(Number((await pool.query("select count(*) as n from command_receipts where client_command_id=$1", [`retry-${code}`])).rows[0].n), 1);
  }
  await pool.query("insert into organizations values('other','active'); insert into organization_members values('other','a','owner','active'),('other','b','admin','active')");
  const otherPublic = await create("a", "other-public", { ...publicInput, organizationId: "other" });
  for (let i = 0; i < 5; i++) {
    const results = await Promise.all([send("a", pub.conversationId, `cross-a-${i}`), send("b", otherPublic.conversationId, `cross-b-${i}`)]);
    assert.equal(results.length, 2, "cross-Team fanout sharing recipients respects sorted cursor locks");
  }

  // Pause the real revocation transaction after taking the authorization lock.
  // A concurrent message must wait, re-read membership, and produce no event.
  const locked = deferred(); const release = deferred();
  const racingScopes = createCollaborationTeamScopeService({ repository: { ...repository, async lockTeamScope(...args) { const result = await repository.lockTeamScope(...args); locked.resolve(); await release.promise; return result; } } });
  const revoking = racingScopes.revokeTeamMember({ account: account("a"), organizationId: "org", targetUserId: "d", clientCommandId: "revoke-d" });
  await locked.promise;
  const sending = send("d", priv.conversationId, "racing-revoked-send").then(() => ({ ok: true }), (error) => ({ error }));
  try {
    let waiting = false;
    for (let i = 0; i < 200 && !waiting; i++) {
      waiting = Number((await admin.query("select count(*) as n from pg_stat_activity where application_name=$1 and wait_event_type='Lock'", [schema])).rows[0].n) > 0;
    }
    assert.equal(waiting, true, "a real backend is blocked on the revocation transaction's lock");
  } finally { release.resolve(); }
  const revoked = await revoking;
  assert.equal((await sending).error?.code, "COLLAB_ORGANIZATION_ACCESS_REVOKED");
  assert.equal((await decision("d", priv.conversationId)).ok, false, "active private membership cannot bypass revoked Team status");
  assert.equal((await decision("d", pub.conversationId)).ok, false);
  assert.deepEqual(await db.transaction().execute((trx) => repository.activeConversationMemberIds(trx, pub.conversationId)), ["a", "b", "c"], "public fanout follows revoked enterprise membership immediately");
  assert.equal((await decision("d", group.conversationId)).ok, true, "Team revocation preserves personal scope");
  const scopeRows = (await pool.query("select e.payload,s.user_id from collaboration_events e join user_sync_events s on s.event_id=e.id where e.id=$1", [revoked.eventId])).rows;
  assert.deepEqual(scopeRows.map((row) => row.user_id), ["d"], "revocation must not wipe unaffected Team members' local scope keys");
  assert.equal(scopeRows[0].payload.organizationId, "org");
  assert.equal(Number((await pool.query("select count(*) as n from command_receipts where client_command_id='racing-revoked-send'")).rows[0].n), 0);
  await assert.rejects(create("d", "revoked-create", { ...publicInput, visibility: "private" }));
  await assert.rejects(scopes.revokeTeamMember({ account: account("b"), organizationId: "org", targetUserId: "a", clientCommandId: "cannot-revoke-owner" }));
  await pool.query("update organizations set status='disabled' where id='org'");
  await assert.rejects(create("b", "public-created", publicInput), (e) => e.code === "COLLAB_ORGANIZATION_ACCESS_REVOKED", "receipt replay rechecks current organization status");
  assert.equal((await decision("c", directs[0].conversationId)).ok, false);
  console.log("collaboration Team integration: permissions, idempotency, canonical direct race, joined history, public fanout and revoke-vs-send passed");
} finally {
  await db.destroy();
  await admin.query(`drop schema if exists ${schema} cascade`);
  await admin.end();
}
