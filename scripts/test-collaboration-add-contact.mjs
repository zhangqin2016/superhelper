#!/usr/bin/env node
/**
 * Adding a contact.
 *
 * What was wrong, measured against the flow every chat client has:
 *   - the request was sent BLIND. You typed an exact Lily ID, submitted, and
 *     learned from a generic "operation failed" whether that person existed.
 *     The server has had a rate-limited `lookupLilyId` all along; it simply had
 *     no HTTP route, so the client could not reach it.
 *   - the server accepts a greeting with the request (`message`, <=500 chars)
 *     and the client never sent one, so a recipient saw a bare request from an
 *     unfamiliar id.
 *   - your own Lily ID — the only way anyone can add you — was plain text with
 *     no way to copy it.
 *
 * The load-bearing constraint: a lookup may report AVAILABLE or NOT, and never
 * why. The server answers identically for "no such id", "that is you",
 * "discoverability is hidden" and "either side blocked the other", because
 * telling them apart would let anyone probe which Lily IDs exist. Any UI copy
 * that explains the failure would undo that.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const { createFriendLookup, normalizeLilyId } = require("../src/main/collaboration/friend-lookup");

// ---- The lookup is a read, and fails closed -----------------------------
{
  const stoppedResult = () => ({ ok: false, code: "COLLABORATION_STOPPED" });
  const unavailableService = () => ({ ok: false, code: "COLLABORATION_UNAVAILABLE" });
  const calls = [];
  const client = { lookupFriend: async ({ lilyId }) => { calls.push(lilyId); return { userId: "u1", lilyId, displayName: "Zhou" }; } };
  const lookup = createFriendLookup({ client, deviceId: "d1", stoppedResult, unavailableService });

  assert.deepEqual(await lookup({ lilyId: "  Lily_New  " }), { ok: true, profile: { userId: "u1", lilyId: "lily_new", displayName: "Zhou" } },
    "an id is trimmed and lower-cased before it is sent");
  assert.deepEqual(calls, ["lily_new"], "the normalized id reaches the transport");

  // Rejected locally, so a malformed id never spends a server rate-limit slot.
  for (const bad of ["", "  ", "ab", "a".repeat(65), "has space", "UPPER!", "-leading", null, 7, undefined]) {
    const result = await lookup({ lilyId: bad });
    assert.equal(result.ok, false, `a malformed id is refused locally: ${JSON.stringify(bad)}`);
    assert.equal(result.code, "COLLABORATION_INVALID_INPUT", "and is reported as invalid input, not as a missing person");
  }
  assert.deepEqual(calls, ["lily_new"], "no malformed id reached the transport");

  // An empty answer is "not available", never a half-rendered profile.
  for (const empty of [null, undefined, {}, { lilyId: "x" }]) {
    const result = await createFriendLookup({ client: { lookupFriend: async () => empty }, deviceId: "d1", stoppedResult, unavailableService })({ lilyId: "lily_new" });
    assert.deepEqual(result, { ok: false, code: "COLLAB_TARGET_UNAVAILABLE", retryable: false },
      `a profile with no user id is not available: ${JSON.stringify(empty)}`);
  }

  // Transport failure is reported, not swallowed into a fake success.
  const failing = createFriendLookup({ client: { lookupFriend: async () => { throw Object.assign(new Error("nope"), { code: "COLLAB_FRIEND_RATE_LIMITED", retryable: true }); } }, deviceId: "d1", stoppedResult, unavailableService });
  assert.deepEqual(await failing({ lilyId: "lily_new" }), { ok: false, code: "COLLAB_FRIEND_RATE_LIMITED", retryable: true },
    "the server's rate-limit refusal reaches the caller intact");

  // An account swap mid-flight must not deliver the previous account's answer.
  const swapped = createFriendLookup({
    client: { lookupFriend: async () => ({ userId: "u1", lilyId: "lily_new" }) }, deviceId: "d1",
    assertActive: () => { throw Object.assign(new Error("changed"), { code: "COLLAB_ACCOUNT_CHANGED" }); },
    stoppedResult, unavailableService,
  });
  await assert.rejects(() => swapped({ lilyId: "lily_new" }), /changed/, "a switched account aborts rather than answering");

  assert.equal((await createFriendLookup({ client, deviceId: "d1", isStopped: () => true, stoppedResult, unavailableService })({ lilyId: "lily_new" })).code,
    "COLLABORATION_STOPPED", "a stopped service does not look anyone up");
  assert.equal((await createFriendLookup({ client: null, deviceId: "d1", stoppedResult, unavailableService })({ lilyId: "lily_new" })).code,
    "COLLABORATION_UNAVAILABLE", "no transport means unavailable, not missing");

  assert.equal(normalizeLilyId("A_b-1"), "a_b-1");
  assert.equal(normalizeLilyId("../etc"), "", "a path-shaped id is not an id");
}

// ---- The route exists, and is a read -----------------------------------
{
  const routes = read("server/src/routes/public/collaboration.js");
  const lookupRoute = routes.slice(routes.indexOf('"/api/collaboration/v1/friends/lookup"'), routes.indexOf('post("/api/collaboration/v1/messages"'));
  assert.ok(lookupRoute.length > 0, "a lookup route exists; the service capability had none");
  // A read must not demand a clientCommandId: it persists nothing and has no
  // receipt, so making it a command would leave retryable rows behind.
  assert.match(lookupRoute, /deviceBody\.extend/, "the lookup takes deviceBody, not commandBody");
  assert.doesNotMatch(lookupRoute, /clientCommandId/, "a read has no client command id");
  assert.match(lookupRoute, /ip: request\.ip/, "the caller ip is passed so the service can rate-limit it");

  // The greeting reaches the service.
  assert.match(routes, /message: z\.string\(\)\.max\(500\)\.optional\(\)/, "the friends route accepts a greeting");
  assert.match(routes, /requestFriend\(\{ account, clientCommandId: input\.clientCommandId, lilyId: input\.lilyId, message: input\.message \?\? null/,
    "and passes it through instead of dropping it");
}

// ---- The IPC boundary projects three fields and nothing else -----------
{
  const ipc = read("src/main/ipc-collaboration.js");
  const projection = ipc.slice(ipc.indexOf('if (method === "lookupFriend")'), ipc.indexOf('if (value?.ok === false) return { ok: false, code: safeIdentifier(value.code)'));
  assert.ok(projection.length > 0, "the lookup result has its own projection");
  assert.match(projection, /profile: \{ userId, lilyId, displayName/, "only the public identity fields cross");
  // `discoverability` is an internal policy value and `avatarObjectId` has no
  // authorized fetch path in this view, so neither may leak into the renderer.
  assert.doesNotMatch(projection, /discoverability|avatarObjectId/, "no internal profile fields cross the boundary");
  assert.match(ipc, /registerCommand\(ipcMain, "collaboration:lookup-friend"/, "the channel is registered");
}

// ---- The client never sends blind, and never explains a failure --------
{
  const friends = read("src/renderer/modules/collaboration-friends.js");
  // The request may only be dispatched from the confirmation the lookup built.
  const requests = friends.match(/api\.friend\(\{ action: "request"/g) || [];
  assert.equal(requests.length, 1, "there is exactly one place a request is sent");
  const sendBlock = friends.slice(friends.indexOf('send.addEventListener("click"'), friends.indexOf("foundBox.append(greeting, send)"));
  assert.match(sendBlock, /const target = found\?\.lilyId;\s*\n\s*if \(!target\) return;/,
    "the request is addressed to the looked-up person, not to whatever is in the text field");
  assert.match(friends, /lilyId\.addEventListener\("input", clearLookup\)/,
    "editing the id invalidates a stale lookup, so the confirmation cannot describe someone else");
  assert.match(friends, /if \(generation !== lookupGeneration\) return;/,
    "a superseded lookup cannot paint over a newer one");

  // The lookup must not run through the command path.
  const submitBlock = friends.slice(friends.indexOf('addForm.addEventListener("submit"'),
    friends.indexOf('lookupNote.textContent = t("collaboration.social.notFound");'))
    // Comment lines are stripped: the block explains WHY it avoids `ui.run`,
    // and a naive grep matches that explanation instead of a call.
    .split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.doesNotMatch(submitBlock, /ui\.run\(/, "the lookup is a read: it does not go through the command runner");

  // One honest message. Anything that names a cause would leak whether an id
  // exists, which is exactly what the server refuses to disclose.
  assert.match(friends, /t\("collaboration\.social\.notFound"\)/, "a failed lookup says only that the id is unavailable");
  for (const locale of ["en", "zh-CN", "ar"]) {
    const strings = JSON.parse(read(`src/renderer/i18n/locales/${locale}.json`));
    const message = strings["collaboration.social.notFound"];
    assert.ok(message, `${locale} has the message`);
    assert.doesNotMatch(message, /not exist|doesn't exist|不存在|blocked|屏蔽|hidden|隐藏|yourself|自己/i,
      `${locale} must not name a cause: the server answers identically for missing, self, hidden and blocked`);
  }
}

// ---- Your own id is shareable -----------------------------------------
{
  const friends = read("src/renderer/modules/collaboration-friends.js");
  assert.match(friends, /socialIconButton\("copy-lily-id"/, "your own Lily ID can be copied");
  assert.match(friends, /navigator\.clipboard\?\.writeText\(profile\.lilyId\)/, "it copies the id itself");
  assert.match(friends, /if \(!copy\.isConnected\) return;/,
    "the confirmation is undone only if the button is still on screen");
  const css = read("src/renderer/styles/collaboration.css");
  assert.match(css, /\.collaboration-social-actions\.is-persistent \{\s*opacity: 1;/,
    "the copy action is not hidden until hover: it is the only thing that row is for");
}

console.log("collaboration-add-contact: ok");
