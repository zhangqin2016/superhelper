import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Import production HTTP parsing without a live database: requests deliberately
// stop at input validation or missing authentication, before any SQL is needed.
process.env.DATABASE_URL = "postgres://unused:unused@127.0.0.1:1/unused";
const require = createRequire(new URL("../server/package.json", import.meta.url));
const Fastify = require("fastify");
const { config } = await import("../server/src/config.js");
const { closeDb } = await import("../server/src/db.js");
const { installDocOnlyCompilers } = await import("../server/src/openapi.js");
const { registerCollaborationRoutes } = await import("../server/src/routes/public/collaboration.js");
config.collaborationEnabled = true; config.collaborationKillSwitch = false;
const app = Fastify({ logger: false });
installDocOnlyCompilers(app);
registerCollaborationRoutes(app, { database: { transaction() { throw new Error("input test must never reach SQL"); } }, objectService: {}, syncService: {}, ticketService: {}, friendService: {}, messageService: {}, authorizeMessage: async () => ({ ok: true }) });
const payload = { action: "send", deviceId: "device", clientCommandId: "command", conversationId: "conversation", bodyText: "reply", replyToMessageId: "source" };
const inject = (change) => app.inject({ method: "POST", url: "/api/collaboration/v1/messages", payload: { ...payload, ...change } });
try {
  for (const value of [{ bodyText: "FORGED_SNAPSHOT_BODY" }, "FORGED_SNAPSHOT_BODY", null]) {
    const rejected = await inject({ replySnapshot: value });
    assert.equal(rejected.statusCode, 400, "client quote authority is rejected at the real HTTP parser, not silently stripped");
    assert.equal(rejected.body.includes("FORGED_SNAPSHOT_BODY"), false);
  }
  for (const field of ["replySnapshotCiphertext", "replySnapshotKeyVersion"]) {
    assert.equal((await inject({ [field]: "forged" })).statusCode, 400, "server-only encrypted snapshot fields are never admitted");
  }
  assert.equal((await inject({})).statusCode, 401, "ordinary send passes parsing and reaches existing authentication");
  assert.equal((await inject({ unrelatedLegacyField: "ignored" })).statusCode, 401, "other historical unknown fields retain existing permissive parsing");
  console.log("collaboration reply snapshot input: explicit reserved-field rejection and baseline-compatible parsing passed");
} finally { await app.close(); await closeDb(); }
