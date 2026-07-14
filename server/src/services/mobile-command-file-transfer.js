import { createHash, randomUUID } from "node:crypto";

const MAX_SINGLE_FILE_BYTES = 500 * 1024 * 1024;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DOWNLOAD_TTL_MS = 15 * 60 * 1000;

const HIGH_RISK_EXTENSIONS = new Set([
  "exe", "msi", "bat", "cmd", "ps1", "sh", "app", "dmg", "pkg", "deb", "rpm", "jar", "vbs", "js",
  "docm", "xlsm", "pptm",
]);
const ARCHIVE_EXTENSIONS = new Set(["zip", "7z", "rar", "tar"]);

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function publicId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

function safeMobileFileName(name) {
  let safe = String(name || "upload.bin")
    .split(/[\\/]/)
    .pop()
    .replace(/[^\w.\-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(0, 120);
  if (!safe) safe = "upload.bin";
  return safe;
}

function extensionOf(name) {
  const match = /\.([^.]+)$/.exec(String(name || "").toLowerCase());
  return match ? match[1] : "";
}

function classifyMobileFileRisk(name) {
  const ext = extensionOf(name);
  if (HIGH_RISK_EXTENSIONS.has(ext)) {
    return { level: "high", reasons: ["executable_extension"], requiresApproval: true };
  }
  if (ARCHIVE_EXTENSIONS.has(ext)) {
    return { level: "medium", reasons: ["archive_extension"], requiresApproval: false };
  }
  return { level: "low", reasons: [], requiresApproval: false };
}

function shapeUpload(record) {
  return {
    uploadId: record.uploadId,
    grantId: record.grantId,
    lilySessionId: record.lilySessionId,
    mobileDeviceId: record.mobileDeviceId,
    originalName: record.originalName,
    displayName: record.displayName,
    sizeBytes: record.sizeBytes,
    sha256: record.sha256,
    chunkCount: record.chunkCount,
    uploadedChunks: [...record.chunks.keys()].sort((a, b) => a - b),
    status: record.status,
    risk: record.risk,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function shapeArtifact(record) {
  return {
    artifactId: record.artifactId,
    uploadId: record.uploadId,
    lilySessionId: record.lilySessionId,
    name: record.name,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    sha256: record.sha256,
    availableFrom: "temporary_object",
    expiresAt: record.expiresAt,
    risk: record.risk,
  };
}

function createMobileFileTransferService({ nowMs = () => Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  const uploads = new Map();
  const createIdempotency = new Map();
  const artifacts = new Map();

  function createUpload(input = {}) {
    const mobileDeviceId = String(input.deviceId || input.mobileDeviceId || "");
    const grantId = String(input.grantId || "");
    const lilySessionId = String(input.lilySessionId || "");
    const idempotencyKey = String(input.idempotencyKey || input.idempotency || "");
    const originalName = String(input.fileName || input.originalName || "upload.bin");
    const displayName = safeMobileFileName(originalName);
    const sizeBytes = Number(input.sizeBytes || 0);
    const expectedSha = String(input.sha256 || "");
    const chunkCount = Number(input.chunkCount || 1);
    if (!mobileDeviceId || !grantId || !lilySessionId || !idempotencyKey) return { ok: false, code: "MC-ERR-PROTOCOL-INVALID" };
    if (!/^[a-f0-9]{64}$/.test(expectedSha)) return { ok: false, code: "MC-ERR-PROTOCOL-INVALID" };
    if (!Number.isInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_SINGLE_FILE_BYTES) return { ok: false, code: "MC-ERR-UPLOAD-TOO-LARGE" };
    if (!Number.isInteger(chunkCount) || chunkCount <= 0 || chunkCount > 100000) return { ok: false, code: "MC-ERR-PROTOCOL-INVALID" };

    const idemScope = `${mobileDeviceId}:${grantId}:${lilySessionId}:${idempotencyKey}`;
    const payloadHash = sha256(Buffer.from(JSON.stringify({ originalName, sizeBytes, expectedSha, chunkCount })));
    const existing = createIdempotency.get(idemScope);
    if (existing) {
      if (existing.payloadHash !== payloadHash) return { ok: false, code: "MC-ERR-PROTOCOL-IDEMPOTENCY-CONFLICT" };
      const record = uploads.get(existing.uploadId);
      return record ? { ok: true, upload: shapeUpload(record) } : { ok: false, code: "MC-ERR-UPLOAD-NOT-FOUND" };
    }

    const now = nowMs();
    const uploadId = publicId("mcu");
    const record = {
      uploadId,
      grantId,
      lilySessionId,
      mobileDeviceId,
      originalName,
      displayName,
      sizeBytes,
      sha256: expectedSha,
      chunkCount,
      chunks: new Map(),
      chunkHashes: new Map(),
      status: "created",
      risk: classifyMobileFileRisk(displayName),
      expiresAt: now + ttlMs,
      createdAt: now,
      updatedAt: now,
    };
    uploads.set(uploadId, record);
    createIdempotency.set(idemScope, { uploadId, payloadHash });
    return { ok: true, upload: shapeUpload(record) };
  }

  function getUpload(uploadId) {
    const record = uploads.get(String(uploadId || ""));
    if (!record) return { ok: false, code: "MC-ERR-UPLOAD-NOT-FOUND" };
    return { ok: true, upload: shapeUpload(record) };
  }

  function putChunk(input = {}) {
    const uploadId = String(input.uploadId || "");
    const chunkIndex = Number(input.chunkIndex);
    const bytes = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes || "");
    const expectedSha = String(input.sha256 || "");
    const record = uploads.get(uploadId);
    if (!record) return { ok: false, code: "MC-ERR-UPLOAD-NOT-FOUND" };
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= record.chunkCount) return { ok: false, code: "MC-ERR-PROTOCOL-INVALID" };
    if (!bytes.length || bytes.length > 25 * 1024 * 1024) return { ok: false, code: "MC-ERR-PROTOCOL-INVALID" };
    const actualSha = sha256(bytes);
    if (expectedSha && expectedSha !== actualSha) return { ok: false, code: "MC-ERR-UPLOAD-CHUNK-HASH-MISMATCH" };
    const priorHash = record.chunkHashes.get(chunkIndex);
    if (priorHash) {
      if (priorHash !== actualSha) return { ok: false, code: "MC-ERR-PROTOCOL-IDEMPOTENCY-CONFLICT" };
      return { ok: true, upload: shapeUpload(record) };
    }
    record.chunks.set(chunkIndex, Buffer.from(bytes));
    record.chunkHashes.set(chunkIndex, actualSha);
    record.status = record.chunks.size === record.chunkCount ? "uploaded" : "uploading";
    record.updatedAt = nowMs();
    return { ok: true, upload: shapeUpload(record) };
  }

  function completeUpload(input = {}) {
    const uploadId = String(input.uploadId || "");
    const expectedSha = String(input.sha256 || "");
    const record = uploads.get(uploadId);
    if (!record) return { ok: false, code: "MC-ERR-UPLOAD-NOT-FOUND" };
    if (record.chunks.size !== record.chunkCount) return { ok: false, code: "MC-ERR-UPLOAD-CHUNK-MISSING" };
    const buffers = [];
    for (let i = 0; i < record.chunkCount; i += 1) {
      const chunk = record.chunks.get(i);
      if (!chunk) return { ok: false, code: "MC-ERR-UPLOAD-CHUNK-MISSING" };
      buffers.push(chunk);
    }
    const full = Buffer.concat(buffers);
    const actualSha = sha256(full);
    if ((expectedSha && expectedSha !== actualSha) || actualSha !== record.sha256 || full.length !== record.sizeBytes) {
      record.status = "recoverable";
      record.updatedAt = nowMs();
      return { ok: false, code: "MC-ERR-UPLOAD-FILE-HASH-MISMATCH", upload: shapeUpload(record) };
    }
    record.status = "verified";
    record.updatedAt = nowMs();
    const artifactId = publicId("mca");
    const artifact = {
      artifactId,
      uploadId,
      lilySessionId: record.lilySessionId,
      name: record.displayName,
      mimeType: "application/octet-stream",
      sizeBytes: record.sizeBytes,
      sha256: actualSha,
      bytes: full,
      risk: record.risk,
      expiresAt: record.expiresAt,
    };
    artifacts.set(artifactId, artifact);
    return { ok: true, upload: shapeUpload(record), artifact: shapeArtifact(artifact) };
  }

  function getArtifact(artifactId) {
    const artifact = artifacts.get(String(artifactId || ""));
    if (!artifact) return { ok: false, code: "MC-ERR-ARTIFACT-NOT-FOUND" };
    return { ok: true, artifact: shapeArtifact(artifact) };
  }

  function createArtifactDownload({ artifactId } = {}) {
    const artifact = artifacts.get(String(artifactId || ""));
    if (!artifact) return { ok: false, code: "MC-ERR-ARTIFACT-NOT-FOUND" };
    return {
      ok: true,
      artifact: shapeArtifact(artifact),
      downloadUrl: `mobile-artifact://${artifact.artifactId}`,
      expiresAt: nowMs() + DOWNLOAD_TTL_MS,
    };
  }

  return { createUpload, getUpload, putChunk, completeUpload, getArtifact, createArtifactDownload };
}

export {
  MAX_SINGLE_FILE_BYTES,
  DEFAULT_TTL_MS,
  DOWNLOAD_TTL_MS,
  classifyMobileFileRisk,
  createMobileFileTransferService,
  safeMobileFileName,
};
