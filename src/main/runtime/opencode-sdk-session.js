"use strict";

/**
 * Thin adapter around the official OpenCode SDK resources.
 *
 * This is intentionally boring: no HTTP routes, no Lily prompt logic, no runtime
 * state. It only centralizes SDK parameter/response shape so the rest of the app
 * does not depend on generated-client details.
 */

function unwrapSdkResult(result, operation) {
  if (!result || typeof result !== "object") return result ?? null;
  if (result.error) {
    const detail =
      typeof result.error === "string"
        ? result.error
        : result.error.message || JSON.stringify(result.error);
    throw new Error(`${operation} failed: ${detail}`);
  }
  if ("data" in result) return result.data;
  return result;
}

function unwrapSdkPageResult(result, operation) {
  if (!result || typeof result !== "object") {
    return { data: Array.isArray(result) ? result : [], response: null };
  }
  if (result.error) {
    const detail =
      typeof result.error === "string"
        ? result.error
        : result.error.message || JSON.stringify(result.error);
    throw new Error(`${operation} failed: ${detail}`);
  }
  return {
    data: Array.isArray(result.data) ? result.data : [],
    response: result.response || null,
  };
}

function withDirectory(directory, extra = {}) {
  return {
    ...(directory ? { directory } : {}),
    ...extra,
  };
}

/**
 * Every control-plane call gets a hard timeout. A wedged serve (alive but
 * event-loop-stuck) used to suspend these awaits FOREVER — health probes
 * never resolved, failures never accumulated, and the user watched a spinner
 * for up to an hour until the turn watchdog fired. Rejecting with a distinct
 * code lets liveness logic treat the serve as dead within seconds.
 */
const SDK_CALL_TIMEOUTS_MS = Object.freeze({
  health: 5_000,
  status: 5_000,
  get: 10_000,
  create: 30_000,
  promptAsync: 30_000,
  summarize: 30_000,
  messages: 15_000,
  abort: 10_000,
  revert: 15_000,
  unrevert: 15_000,
  respondPermission: 10_000,
  respondQuestion: 10_000,
});

function withCallTimeout(promise, timeoutMs, operation) {
  let timer = null;
  const tracked = Promise.resolve(promise);
  // When the timeout wins the race the SDK promise lives on; attach a sink so
  // its late settlement can never surface as an unhandledRejection.
  tracked.catch(() => {});
  return Promise.race([
    tracked,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${operation} failed: OPENCODE_HTTP_TIMEOUT after ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function summarizeParams(directory, sessionID, body = {}) {
  const params = { sessionID };
  if (body.providerID) params.providerID = body.providerID;
  if (body.modelID) params.modelID = body.modelID;
  if (body.auto !== undefined) params.auto = Boolean(body.auto);
  return withDirectory(directory, params);
}

function createOpencodeSdkSession(client, directory, options = {}) {
  if (!client?.session) throw new Error("Lily runtime client has no session resource");
  const timeouts = { ...SDK_CALL_TIMEOUTS_MS, ...(options.timeouts || {}) };
  const call = (operation, promise) => withCallTimeout(promise, timeouts[operation] || 15_000, operation);
  return {
    async get(sessionID) {
      return unwrapSdkResult(
        await call("get", client.session.get(withDirectory(directory, { sessionID }))),
        "session.get",
      );
    },

    async create(params = {}) {
      return unwrapSdkResult(
        await call("create", client.session.create(withDirectory(directory, params))),
        "session.create",
      );
    },

    async promptAsync(sessionID, body = {}) {
      return unwrapSdkResult(
        await call("promptAsync", client.session.promptAsync(withDirectory(directory, { sessionID, ...body }))),
        "session.promptAsync",
      );
    },

    async summarize(sessionID, body = {}) {
      if (typeof client.session.summarize !== "function") {
        throw new Error("Lily runtime client has no session.summarize resource");
      }
      return unwrapSdkResult(
        await call("summarize", client.session.summarize(summarizeParams(directory, sessionID, body))),
        "session.summarize",
      );
    },

    async status() {
      return unwrapSdkResult(
        await call("status", client.session.status(withDirectory(directory))),
        "session.status",
      );
    },

    async messages(sessionID, opts = {}) {
      return unwrapSdkPageResult(
        await call("messages", client.session.messages(withDirectory(directory, {
          sessionID,
          ...(Number.isInteger(opts.limit) ? { limit: opts.limit } : {}),
          ...(opts.before ? { before: opts.before } : {}),
        }))),
        "session.messages",
      );
    },

    async abort(sessionID) {
      return unwrapSdkResult(
        await call("abort", client.session.abort(withDirectory(directory, { sessionID }))),
        "session.abort",
      );
    },

    async revert(sessionID, messageID) {
      return unwrapSdkResult(
        await call("revert", client.session.revert(withDirectory(directory, { sessionID, messageID }))),
        "session.revert",
      );
    },

    async unrevert(sessionID) {
      return unwrapSdkResult(
        await call("unrevert", client.session.unrevert(withDirectory(directory, { sessionID }))),
        "session.unrevert",
      );
    },

    async fork(sessionID, messageID) {
      if (typeof client.session.fork !== "function") {
        throw new Error("Lily runtime client has no session.fork resource");
      }
      return unwrapSdkResult(
        await call("fork", client.session.fork(withDirectory(directory, { sessionID, messageID }))),
        "session.fork",
      );
    },

    async respondPermission(sessionID, permissionID, decision = {}) {
      const permission = client.permission;
      if (!permission) throw new Error("Lily runtime client has no permission resource");
      if (typeof permission.reply === "function") {
        return unwrapSdkResult(
          await call("respondPermission", permission.reply(withDirectory(directory, {
            requestID: permissionID,
            reply: decision.reply,
            ...(decision.message ? { message: decision.message } : {}),
          }))),
          "permission.reply",
        );
      }
      return unwrapSdkResult(
        await call("respondPermission", permission.respond(withDirectory(directory, {
          sessionID,
          permissionID,
          response: decision.reply,
        }))),
        "permission.respond",
      );
    },

    async respondQuestion(requestID, answers) {
      const question = client.question;
      if (!question) throw new Error("Lily runtime client has no question resource");
      return unwrapSdkResult(
        await call("respondQuestion", question.reply(withDirectory(directory, { requestID, answers }))),
        "question.reply",
      );
    },

    async health() {
      const global = client.global;
      if (!global) throw new Error("Lily runtime client has no global resource");
      return unwrapSdkResult(await call("health", global.health()), "global.health");
    },
  };
}

module.exports = {
  createOpencodeSdkSession,
  unwrapSdkResult,
  unwrapSdkPageResult,
  summarizeParams,
  withCallTimeout,
  SDK_CALL_TIMEOUTS_MS,
};
