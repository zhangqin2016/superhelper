import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
// Measured transfer scale and fault cases. Encryption, multipart protocol, journals and
// Git plumbing are real; the object provider is an in-memory fixture, so numbers describe
// the client pipeline, not network throughput.
const CONCURRENCY = process.env.LILY_COLLAB_UPLOAD_CONCURRENCY = process.env.LILY_SCALE_CONCURRENCY || "4";
const MB = 1024 ** 2, SIZE = Number(process.env.LILY_SCALE_TRANSFER_MB || 256) * MB;
const require = createRequire(import.meta.url);
const { createTransferManifestStore } = require("../src/main/collaboration/transfer-manifest");
const { LocalCollaborationKeyring } = require("../src/main/collaboration/local-keyring");
const { decryptFile } = require("../src/main/collaboration/encrypted-container");
const { createTransferManager } = require("../src/main/collaboration/transfer-manager");
const { TaskGit } = require("../src/main/collaboration/task-git");
const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "lily-scale-report-"));
let peak = process.memoryUsage().rss; const monitor = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 25);
const report = { recordedAt: new Date().toISOString(), runtime: { node: process.version, platform: `${process.platform}-${process.arch}`, git: execFileSync("git", ["--version"], { encoding: "utf8" }).trim(), electron: process.versions.electron || null }, transfer: {}, faults: {} };
const streamHash = (file) => new Promise((resolve, reject) => { const digest = crypto.createHash("sha256"); fs.createReadStream(file).on("data", (c) => digest.update(c)).on("end", () => resolve(digest.digest("hex"))).on("error", reject); });
const timed = async (fn) => { const start = process.hrtime.bigint(); const value = await fn(); return { value, ms: Math.round(Number(process.hrtime.bigint() - start) / 1e6) }; };
try {
  const source = path.join(dir, "source.bin"); const chunk = crypto.randomBytes(4 * MB);
  const fd = fs.openSync(source, "w"); for (let written = 0; written < SIZE;) { const piece = chunk.subarray(0, Math.min(chunk.length, SIZE - written)); fs.writeSync(fd, piece); written += piece.length; } fs.closeSync(fd);
  const keyring = new LocalCollaborationKeyring({ filePath: path.join(dir, "keys"), safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() } });
  const manifests = createTransferManifestStore({ rootPath: path.join(dir, "collaboration-transfer"), accountId: "alice", keyring });
  const remote = { parts: new Map(), puts: 0, bytes: 0, inFlight: 0, maxInFlight: 0, ciphertext: null, state: "uploading", metadata: null, failAt: Number(process.env.LILY_SCALE_FAIL_PART || 17) };
  const ticket = { bucket: "test", objectKey: `collaboration/${"a".repeat(64)}`, token: "UPLOAD_SECRET", uploadUrl: "https://upload.invalid" };
  const objectClient = {
    async init(input) { remote.metadata = input; return { objectId: "obj", state: "uploading", upload: ticket }; },
    async status() { return { objectId: "obj", state: remote.state, ciphertextSize: remote.metadata.ciphertextSize, ciphertextSha256: remote.metadata.ciphertextSha256, etag: remote.ciphertext ? "object-etag" : null, upload: ticket, provider: remote.ciphertext ? { state: "present", etag: "object-etag" } : { state: "missing" } }; },
    async complete(input) { assert.equal(await streamHash(remote.ciphertext), input.ciphertextSha256); remote.state = "verified"; return { objectId: "obj", state: "verified" }; },
    async abort() { remote.state = "aborted"; return { objectId: "obj", state: "aborted" }; },
  };
  const multipart = {
    async initiate() { return { uploadId: "upload", expireAt: 2_000_000_000 }; },
    async listParts() { return { uploadId: "upload", marker: 0, expireAt: 2_000_000_000, parts: [...remote.parts].map(([partNumber, part]) => ({ partNumber, etag: `etag-${partNumber}`, size: part.length })) }; },
    async uploadPart({ partNumber, bytes }) {
      remote.inFlight++; remote.maxInFlight = Math.max(remote.maxInFlight, remote.inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5)); remote.inFlight--;
      if (remote.failAt === partNumber) { remote.failAt = null; throw Object.assign(new Error("provider dropped the response"), { code: "COLLAB_TRANSFER_RESPONSE_LOST" }); }
      remote.puts++; remote.bytes += bytes.length; const file = path.join(partsDir, `part-${partNumber}`); fs.writeFileSync(file, bytes); remote.parts.set(partNumber, { file, length: bytes.length }); return { partNumber, etag: `etag-${partNumber}` };
    },
    async complete({ parts }) {
      const out = fs.openSync(ciphertextPath, "w"); for (const { partNumber } of parts) fs.writeSync(out, fs.readFileSync(remote.parts.get(partNumber).file)); fs.closeSync(out);
      remote.ciphertext = ciphertextPath; return { etag: "object-etag" };
    },
  };
  const partsDir = path.join(dir, "provider-parts"); fs.mkdirSync(partsDir); const ciphertextPath = path.join(dir, "received.lilyenc");
  const options = { manifests, objectClient, multipart, deviceId: "device", assertAuthorized: () => {} };
  const api = createTransferManager(options);
  const prepared = await timed(() => api.prepareUpload({ inputPath: source, conversationId: "conversation", scopeId: "team:org", purpose: "attachment", originalName: "source.bin", mimeType: "application/octet-stream" }));
  const rssAfterPrepare = process.memoryUsage().rss;
  let upload = await timed(() => api.resumeUpload(prepared.value.id).catch((error) => ({ state: "failed", code: error.code })));
  let recovered = null;
  if (upload.value.state !== "verified") recovered = await timed(() => createTransferManager(options).resumeUpload(prepared.value.id));
  const final = recovered ? recovered.value : upload.value;
  assert.equal(final.state, "verified");
  assert.equal(remote.puts, Math.ceil(remote.metadata.ciphertextSize / (4 * MB)), "every part uploaded exactly once across the fault");
  const output = path.join(dir, "restored.bin");
  const rssAfterUpload = process.memoryUsage().rss;
  const decrypt = await timed(() => decryptFile({ inputPath: ciphertextPath, outputPath: output, key: Buffer.from(remote.metadata.dek, "base64") }));
  assert.equal(await streamHash(output), await streamHash(source), "authentic plaintext after a faulted, concurrent upload");
  report.transfer = { plaintextBytes: SIZE, ciphertextBytes: remote.metadata.ciphertextSize, parts: remote.puts, concurrencyPolicy: Number(CONCURRENCY), maxInFlight: remote.maxInFlight,
    prepareEncryptMs: prepared.ms, uploadMs: upload.ms + (recovered?.ms || 0), faultInjectedAtPart: Number(process.env.LILY_SCALE_FAIL_PART || 17), recoveredByResume: Boolean(recovered), decryptMs: decrypt.ms,
    rssAfterPrepareBytes: rssAfterPrepare, rssAfterUploadBytes: rssAfterUpload };
  // Fault: a materialization interrupted after N blobs leaves no partial snapshot claim and reruns cleanly.
  const treeRoot = path.join(dir, "tree"); fs.mkdirSync(treeRoot); const manifest = [];
  for (let i = 0; i < 400; i++) { const text = `row ${i}\n`.repeat(50); const name = `f${i}.txt`; fs.writeFileSync(path.join(treeRoot, name), text); manifest.push({ path: name, sha256: crypto.createHash("sha256").update(text).digest("hex"), sizeBytes: Buffer.byteLength(text) }); }
  const tasks = new TaskGit({ rootPath: path.join(dir, "collaboration"), gitOptions: { autoInstall: false } });
  const baseline = await tasks.captureBaseline({ taskId: "fault", snapshotRoot: treeRoot, manifest });
  // Kill a separate process while it materializes: the partial destination carries no
  // manifest claim, the shared object store is untouched, and a fresh run completes.
  const { spawn } = await import("node:child_process");
  const killedRoot = path.join(dir, "killed");
  const child = spawn(process.execPath, ["-e", `const {TaskGit}=require(${JSON.stringify(path.resolve("src/main/collaboration/task-git.js"))});const t=new TaskGit({rootPath:${JSON.stringify(path.join(dir, "collaboration"))},gitOptions:{autoInstall:false}});t.materializeSnapshot({revision:${JSON.stringify(baseline)},destinationRoot:${JSON.stringify(killedRoot)},parents:[]}).then(()=>process.exit(0),e=>{console.error(e);process.exit(2);});`], { stdio: "ignore", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  const started = Date.now(); while (Date.now() - started < 10000 && !(fs.existsSync(path.join(killedRoot, "snapshot")) && fs.readdirSync(path.join(killedRoot, "snapshot")).length >= 20)) await new Promise((r) => setTimeout(r, 5));
  child.kill("SIGKILL"); await new Promise((resolve) => child.once("exit", resolve));
  const partial = fs.existsSync(path.join(killedRoot, "snapshot")) ? fs.readdirSync(path.join(killedRoot, "snapshot")).length : 0;
  assert.ok(partial > 0 && partial <= 400, `the killed run left a partial destination (${partial} files) and no completion claim`);
  const interrupted = { value: `killed-after-${partial}-files` };
  const clash = await tasks.materializeSnapshot({ revision: baseline, destinationRoot: path.join(dir, "clash"), parents: [] }).then(() => "second-run-ok");
  assert.equal(execFileSync("git", ["--git-dir", baseline.repository, "fsck", "--strict", "--no-dangling"], { encoding: "utf8" }).trim(), "", "the object store is intact after the kill");
  await assert.rejects(tasks.materializeSnapshot({ revision: baseline, destinationRoot: path.join(dir, "clash"), parents: [] }), /EEXIST|UNSAFE_PATH|EXIST/, "a destination that already exists is refused, never partially overwritten");
  const rerun = await timed(() => tasks.materializeSnapshot({ revision: baseline, destinationRoot: path.join(dir, "rerun"), parents: [] }));
  assert.equal(rerun.value.manifest.length, 400);
  report.faults = { materializationKilledMidway: interrupted.value, partialFilesLeft: partial, objectStoreIntactAfterKill: true, freshRun: clash, rerunMs: rerun.ms, existingDestinationRefused: true, transferLostPartRecovered: remote.failAt === null };
  clearInterval(monitor); report.peakRssBytes = peak;
  const target = process.env.LILY_SCALE_REPORT || path.join(dir, "report.json");
  const gitScale = path.resolve("docs/research/2026-09-14-collaboration-git-scale.json");
  if (fs.existsSync(gitScale)) report.gitScale = JSON.parse(fs.readFileSync(gitScale, "utf8"));
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, JSON.stringify(report, null, 2));
  console.log(`transfer: ${(SIZE / MB).toFixed(0)} MiB plaintext, ${report.transfer.parts} parts, policy ${CONCURRENCY}, max in flight ${remote.maxInFlight}, encrypt ${prepared.ms} ms, upload ${report.transfer.uploadMs} ms (fault at part ${report.transfer.faultInjectedAtPart}, resume ${recovered ? "yes" : "internal"}), decrypt ${decrypt.ms} ms, RSS after prepare ${(rssAfterPrepare / MB).toFixed(1)} MiB, after upload ${(rssAfterUpload / MB).toFixed(1)} MiB, peak ${(peak / MB).toFixed(1)} MiB; materialization killed after ${partial} files, fresh run ${rerun.ms} ms`);
  console.log(`PASS collaboration scale report written to ${target}`);
} finally { clearInterval(monitor); fs.rmSync(dir, { recursive: true, force: true }); }
