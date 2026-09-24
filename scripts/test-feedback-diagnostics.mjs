#!/usr/bin/env node
// Feedback carries the diagnostics report + a redacted log tail, end to end:
// the client module builds it, the server module accepts it, and what the
// admin downloads is exactly the redacted text — never the raw log.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import module from "node:module";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const require = module.createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-feedback-diag-"));

process.resourcesPath = ROOT;
const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: {
      isPackaged: false,
      getPath: (name) => (name === "userData" ? tmp : os.tmpdir()),
      getVersion: () => "0.1.99",
    },
  },
};

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

const bundle = require(path.join(ROOT, "src/main/support-log-bundle.js"));
const server = await import("../server/src/services/contact-diagnostics.js");

// ── redaction ──────────────────────────────────────────────────────────────
const home = "/Users/alice";
const raw = [
  "2026-09-24 10:00:00.000 INFO  key sk-abcdefghijklmnop used",
  "gateway lilygw.dev_123.sig_abc token",
  "Authorization: Bearer abcdefgh12345678xyz",
  'config {"apiKey":"plain-secret-value","outputTokens":812}',
  "password=hunter2&next=1",
  "sms login 13812345678 ok",
  `opened ${home}/Documents/project/a.txt`,
  "jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4f",
].join("\n");
const red = bundle.redactLogText(raw, { homeDir: home });
for (const secret of ["sk-abcdefghijklmnop", "lilygw.dev_123", "abcdefgh12345678xyz", "plain-secret-value", "hunter2", "13812345678", home, "eyJhbGciOiJIUzI1"]) {
  assert.ok(!red.includes(secret), `redacted log still contains ${secret}:\n${red}`);
}
assert.ok(red.includes('"outputTokens":812'), "a token COUNT is not a secret and must survive");
assert.ok(red.includes("~/Documents/project/a.txt"), "home dir becomes ~, the rest of the path stays useful");
assert.ok(bundle.redactLogText("C:\\Users\\bob\\x.log", { homeDir: "C:\\Users\\bob" }).startsWith("~"), "windows home dir");

// ── tail across rotated generations, newest bytes, oldest line first ──────
const logDir = path.join(tmp, "logs");
fs.mkdirSync(logDir, { recursive: true });
const live = path.join(logDir, "main.log");
fs.writeFileSync(`${live}.1`, "old-1\nold-2\n");
fs.writeFileSync(live, "new-1\nnew-2\n");
const whole = bundle.collectLogTail({ paths: [live, `${live}.1`], maxBytes: 1024 });
assert.equal(whole.text, "old-1\nold-2\nnew-1\nnew-2\n");
assert.equal(whole.truncated, false);
const cut = bundle.collectLogTail({ paths: [live, `${live}.1`], maxBytes: 15 });
assert.equal(cut.truncated, true);
assert.ok(cut.text.endsWith("new-2\n") && !cut.text.startsWith("ld-"), `partial first line dropped: ${JSON.stringify(cut.text)}`);
assert.equal(bundle.collectLogTail({ paths: [path.join(tmp, "missing.log")] }), null);

// ── client → server round trip ────────────────────────────────────────────
fs.writeFileSync(live, `${raw}\n`);
fs.rmSync(`${live}.1`);
const attachment = bundle.buildLogAttachment({ paths: [live], homeDir: home });
assert.equal(attachment.encoding, server.LOG_ENCODING);
const row = server.normalizeSubmittedDiagnostics({ report: { summary: { status: "warning" }, checks: [] }, log: attachment });
assert.ok(row?.log_gzip && row.report);
const downloaded = server.inflateStoredLog(row.log_gzip).toString("utf8");
assert.equal(downloaded, bundle.redactLogText(`${raw}\n`, { homeDir: home }), "admin downloads exactly the redacted text");
assert.equal(row.log_sha256, crypto.createHash("sha256").update(downloaded).digest("hex"));
assert.ok(!downloaded.includes("hunter2"));
const admin = server.diagnosticsForAdmin(row);
assert.equal(admin.hasLog, true);
assert.equal(admin.log_gzip, undefined, "the admin list never carries log bytes");

// Badly-compressing text shrinks instead of being silently dropped server-side.
fs.writeFileSync(live, crypto.randomBytes(3 * 1024 * 1024).toString("base64"));
const dense = bundle.buildLogAttachment({ paths: [live], homeDir: home });
assert.ok(dense && dense.compressedBytes <= server.MAX_LOG_COMPRESSED_BYTES, "dense log fits the server cap");
assert.ok(server.normalizeSubmittedDiagnostics({ log: dense })?.log_gzip, "server keeps the shrunk log");

// ── server never fails the ticket over a bad attachment ───────────────────
const bomb = zlib.gzipSync(Buffer.alloc(server.MAX_LOG_BYTES + 1024, 0x41)).toString("base64");
assert.equal(server.normalizeSubmittedDiagnostics({ log: { encoding: server.LOG_ENCODING, data: bomb } }), null, "zip bomb dropped");
assert.equal(server.normalizeSubmittedDiagnostics({ log: { encoding: server.LOG_ENCODING, data: "not-gzip" } }), null);
assert.equal(server.normalizeSubmittedDiagnostics({ log: { encoding: "raw", data: "x" } }), null);
assert.equal(server.normalizeSubmittedDiagnostics("nope"), null);
assert.equal(server.normalizeSubmittedDiagnostics(null), null);
const huge = { blob: "x".repeat(server.MAX_REPORT_BYTES + 1) };
assert.equal(server.normalizeSubmittedDiagnostics({ report: huge }), null, "oversized report dropped");
const reportOnly = server.normalizeSubmittedDiagnostics({ report: { a: 1 }, log: { encoding: "raw" } });
assert.ok(reportOnly.report && reportOnly.log_gzip === null, "a bad log does not cost the report");

// ── collectFeedbackDiagnostics is fail-open and bounded ───────────────────
const failing = await bundle.collectFeedbackDiagnostics({
  runReport: () => { throw new Error("boom"); },
  buildLog: () => { throw new Error("boom"); },
});
assert.equal(failing, null);
const slow = await bundle.collectFeedbackDiagnostics({
  runReport: () => new Promise(() => {}),
  buildLog: () => ({ encoding: "gzip+base64", data: "x" }),
  timeoutMs: 50,
});
assert.equal(slow.report, null, "a hung diagnostic does not hold the ticket");
assert.ok(slow.log);
const redactedReport = await bundle.collectFeedbackDiagnostics({
  runReport: () => ({ checks: [{ detail: `日志位于 ${home}/Library/logs/main.log` }] }),
  buildLog: () => null,
  homeDir: home,
});
assert.ok(!JSON.stringify(redactedReport.report).includes(home), "report paths lose the home dir too");

// ── support-contact: ticked sends it, unticked never does, failure is harmless
const serviceClientPath = require.resolve(path.join(ROOT, "src/main/service-client.js"));
let captured = null;
require.cache[serviceClientPath] = {
  id: serviceClientPath,
  filename: serviceClientPath,
  loaded: true,
  exports: {
    ...require(serviceClientPath),
    submitContactRequest: async (payload) => {
      captured = payload;
      return { ok: true, json: { ok: true, id: "contact_diag", diagnostics: payload.diagnostics ? { report: true, log: Boolean(payload.diagnostics.log) } : null } };
    },
  },
};
delete require.cache[require.resolve(path.join(ROOT, "src/main/support-contact.js"))];
const support = require(path.join(ROOT, "src/main/support-contact.js"));
const base = { name: "T", email: "t@example.com", message: "Something went wrong here." };

const ticked = await support.submitContactRequestPublic({
  ...base,
  includeDiagnostics: true,
  collectDiagnostics: async () => ({ report: { ok: true }, log: { encoding: "gzip+base64", data: "eA==" } }),
});
assert.equal(ticked.ok, true);
assert.ok(captured.diagnostics?.log, "ticked box sends the log");
assert.equal(ticked.diagnostics.stored.log, true);

await support.submitContactRequestPublic({ ...base, collectDiagnostics: async () => { throw new Error("must not run"); } });
assert.equal(captured.diagnostics, undefined, "unticked box sends nothing");

const broken = await support.submitContactRequestPublic({
  ...base,
  includeDiagnostics: true,
  collectDiagnostics: async () => { throw new Error("disk gone"); },
});
assert.equal(broken.ok, true, "a diagnostics failure still delivers the feedback");
assert.equal(captured.diagnostics, undefined);

// ── wiring: the IPC handler forwards screenshots and the checkbox ─────────
const ipc = fs.readFileSync(path.join(ROOT, "src/main/ipc-handlers.js"), "utf8");
const handler = ipc.slice(ipc.indexOf('"support:submit-feedback"'), ipc.indexOf('"support:submit-contact"'));
assert.ok(/attachments:\s*payload\?\.attachments/.test(handler), "feedback screenshots reach the upload path");
assert.ok(/includeDiagnostics:\s*payload\?\.includeDiagnostics === true/.test(handler), "only an explicit tick sends diagnostics");
const html = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf8");
assert.ok(/id="feedbackIncludeDiagnostics" type="checkbox" checked/.test(html), "box is on by default and visible");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("test-feedback-diagnostics: ok");
