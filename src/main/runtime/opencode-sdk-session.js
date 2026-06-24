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

function summarizeParams(directory, sessionID, body = {}) {
  const summarizeBody = {};
  if (body.providerID) summarizeBody.providerID = body.providerID;
  if (body.modelID) summarizeBody.modelID = body.modelID;
  if (body.auto !== undefined) summarizeBody.auto = Boolean(body.auto);
  return {
    path: { id: sessionID },
    ...(directory ? { query: { directory } } : {}),
    body: summarizeBody,
  };
}

function createOpencodeSdkSession(client, directory) {
  if (!client?.session) throw new Error("OpenCode SDK client has no session resource");
  return {
    async get(sessionID) {
      return unwrapSdkResult(
        await client.session.get(withDirectory(directory, { sessionID })),
        "session.get",
      );
    },

    async create(params = {}) {
      return unwrapSdkResult(
        await client.session.create(withDirectory(directory, params)),
        "session.create",
      );
    },

    async promptAsync(sessionID, body = {}) {
      return unwrapSdkResult(
        await client.session.promptAsync(withDirectory(directory, { sessionID, ...body })),
        "session.promptAsync",
      );
    },

    async summarize(sessionID, body = {}) {
      if (typeof client.session.summarize !== "function") {
        throw new Error("OpenCode SDK client has no session.summarize resource");
      }
      return unwrapSdkResult(
        await client.session.summarize(summarizeParams(directory, sessionID, body)),
        "session.summarize",
      );
    },

    async status() {
      return unwrapSdkResult(
        await client.session.status(withDirectory(directory)),
        "session.status",
      );
    },

    async messages(sessionID, opts = {}) {
      return unwrapSdkPageResult(
        await client.session.messages(withDirectory(directory, {
          sessionID,
          ...(Number.isInteger(opts.limit) ? { limit: opts.limit } : {}),
          ...(opts.before ? { before: opts.before } : {}),
        })),
        "session.messages",
      );
    },

    async abort(sessionID) {
      return unwrapSdkResult(
        await client.session.abort(withDirectory(directory, { sessionID })),
        "session.abort",
      );
    },

    async revert(sessionID, messageID) {
      return unwrapSdkResult(
        await client.session.revert(withDirectory(directory, { sessionID, messageID })),
        "session.revert",
      );
    },

    async unrevert(sessionID) {
      return unwrapSdkResult(
        await client.session.unrevert(withDirectory(directory, { sessionID })),
        "session.unrevert",
      );
    },

    async respondPermission(sessionID, permissionID, decision = {}) {
      const permission = client.permission;
      if (!permission) throw new Error("OpenCode SDK client has no permission resource");
      if (typeof permission.reply === "function") {
        return unwrapSdkResult(
          await permission.reply(withDirectory(directory, {
            requestID: permissionID,
            reply: decision.reply,
            ...(decision.message ? { message: decision.message } : {}),
          })),
          "permission.reply",
        );
      }
      return unwrapSdkResult(
        await permission.respond(withDirectory(directory, {
          sessionID,
          permissionID,
          response: decision.reply,
        })),
        "permission.respond",
      );
    },

    async respondQuestion(requestID, answers) {
      const question = client.question;
      if (!question) throw new Error("OpenCode SDK client has no question resource");
      return unwrapSdkResult(
        await question.reply(withDirectory(directory, { requestID, answers })),
        "question.reply",
      );
    },

    async health() {
      const global = client.global;
      if (!global) throw new Error("OpenCode SDK client has no global resource");
      return unwrapSdkResult(await global.health(), "global.health");
    },
  };
}

module.exports = {
  createOpencodeSdkSession,
  unwrapSdkResult,
  unwrapSdkPageResult,
  summarizeParams,
};
