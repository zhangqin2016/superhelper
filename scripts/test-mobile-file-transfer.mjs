#!/usr/bin/env node
// Mobile Command local upload/artifact v1. This is the small, server-local
// implementation behind the final HTTP surface; production object storage and
// native/background upload remain separate capability gates.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const {
  createMobileFileTransferService,
  classifyMobileFileRisk,
  safeMobileFileName,
} = await import('../server/src/services/mobile-command-file-transfer.js');

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

const hello = Buffer.from('hello mobile upload');
const world = Buffer.from(' world chunk');
const full = Buffer.concat([hello, world]);
const service = createMobileFileTransferService({ nowMs: () => 1000 });

assert.equal(safeMobileFileName('../bad name?.txt'), 'bad_name_.txt');
assert.deepEqual(classifyMobileFileRisk('notes.txt'), { level: 'low', reasons: [], requiresApproval: false });
assert.deepEqual(classifyMobileFileRisk('setup.exe'), { level: 'high', reasons: ['executable_extension'], requiresApproval: true });
assert.deepEqual(classifyMobileFileRisk('bundle.zip'), { level: 'medium', reasons: ['archive_extension'], requiresApproval: false });

const created = service.createUpload({
  deviceId: 'mob_test',
  grantId: 'grant_test',
  lilySessionId: 'sess_test',
  fileName: '../bad name?.txt',
  sizeBytes: full.length,
  sha256: sha256(full),
  chunkCount: 2,
  idempotencyKey: 'idem_create_1',
});
assert.equal(created.ok, true);
assert.equal(created.upload.displayName, 'bad_name_.txt');
assert.equal(created.upload.status, 'created');
assert.equal(created.upload.uploadedChunks.length, 0);

const duplicateCreate = service.createUpload({
  deviceId: 'mob_test',
  grantId: 'grant_test',
  lilySessionId: 'sess_test',
  fileName: '../bad name?.txt',
  sizeBytes: full.length,
  sha256: sha256(full),
  chunkCount: 2,
  idempotencyKey: 'idem_create_1',
});
assert.equal(duplicateCreate.upload.uploadId, created.upload.uploadId, 'same idempotency key returns existing upload');

const conflictCreate = service.createUpload({
  deviceId: 'mob_test',
  grantId: 'grant_test',
  lilySessionId: 'sess_test',
  fileName: 'other.txt',
  sizeBytes: full.length,
  sha256: sha256(full),
  chunkCount: 2,
  idempotencyKey: 'idem_create_1',
});
assert.equal(conflictCreate.ok, false);
assert.equal(conflictCreate.code, 'MC-ERR-PROTOCOL-IDEMPOTENCY-CONFLICT');

const chunk0 = service.putChunk({
  uploadId: created.upload.uploadId,
  chunkIndex: 0,
  bytes: hello,
  sha256: sha256(hello),
});
assert.equal(chunk0.ok, true);
assert.equal(chunk0.upload.status, 'uploading');
assert.deepEqual(chunk0.upload.uploadedChunks, [0]);

const dupChunk0 = service.putChunk({
  uploadId: created.upload.uploadId,
  chunkIndex: 0,
  bytes: hello,
  sha256: sha256(hello),
});
assert.equal(dupChunk0.ok, true);
assert.deepEqual(dupChunk0.upload.uploadedChunks, [0], 'same chunk hash is idempotent');

const badChunk0 = service.putChunk({
  uploadId: created.upload.uploadId,
  chunkIndex: 0,
  bytes: Buffer.from('changed'),
  sha256: sha256(Buffer.from('changed')),
});
assert.equal(badChunk0.ok, false);
assert.equal(badChunk0.code, 'MC-ERR-PROTOCOL-IDEMPOTENCY-CONFLICT');

const hashMismatch = service.putChunk({
  uploadId: created.upload.uploadId,
  chunkIndex: 1,
  bytes: world,
  sha256: '0'.repeat(64),
});
assert.equal(hashMismatch.ok, false);
assert.equal(hashMismatch.code, 'MC-ERR-UPLOAD-CHUNK-HASH-MISMATCH');

const chunk1 = service.putChunk({
  uploadId: created.upload.uploadId,
  chunkIndex: 1,
  bytes: world,
  sha256: sha256(world),
});
assert.equal(chunk1.ok, true);
assert.deepEqual(chunk1.upload.uploadedChunks, [0, 1]);

const completed = service.completeUpload({
  uploadId: created.upload.uploadId,
  sha256: sha256(full),
});
assert.equal(completed.ok, true);
assert.equal(completed.upload.status, 'verified');
assert.equal(completed.artifact.name, 'bad_name_.txt');
assert.equal(completed.artifact.sizeBytes, full.length);
assert.equal(completed.artifact.sha256, sha256(full));

const descriptor = service.getArtifact(completed.artifact.artifactId);
assert.equal(descriptor.ok, true);
assert.equal(descriptor.artifact.artifactId, completed.artifact.artifactId);
assert.equal(descriptor.artifact.availableFrom, 'temporary_object');

const download = service.createArtifactDownload({ artifactId: completed.artifact.artifactId });
assert.equal(download.ok, true);
assert.match(download.downloadUrl, /^mobile-artifact:\/\/mca_/);
assert.equal(download.expiresAt, 1000 + 15 * 60 * 1000);

const missing = service.getUpload('missing');
assert.equal(missing.ok, false);
assert.equal(missing.code, 'MC-ERR-UPLOAD-NOT-FOUND');

console.log('mobile-file-transfer: ok');
