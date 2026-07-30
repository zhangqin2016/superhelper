#!/usr/bin/env node
// Hostile filesystem and worker-isolation checks for Character Worlds import.
// Run: node scripts/test-character-worlds-import-hardening.mjs

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import v8 from "node:v8";
import { createRequire } from "node:module";
import { createTestDestinationBroker } from "./character-destination-test-broker.mjs";

const require = createRequire(import.meta.url);
const { MessageStore } = require("../src/main/store/message-store.js");
const {
  CharacterWorldsService,
  CharacterSourceAuthority,
  CharacterDestinationWriter,
} = require("../src/main/character-worlds/service.js");
const {
  CharacterImportWorkerPool,
} = require("../src/main/character-worlds/import-worker-pool.js");
const {
  MAX_CHARACTER_SOURCE_BYTES,
} = require("../src/main/character-worlds/constants.js");
const {
  DESTINATION_BROKER_PROTOCOL,
  DESTINATION_RESERVATION_PROTOCOL,
} = require("../src/main/character-worlds/destination-broker-protocol.js");
const {
  createReferenceDestinationBroker,
} = require("../src/main/character-worlds/reference-destination-broker.js");

const OWNER = "profile:local";
const OTHER_OWNER = "profile:other";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "character-import-hardening-"));
const sourceRoot = path.join(tmp, "source");
const destinationRoot = path.join(tmp, "destination");
const outsideRoot = path.join(tmp, "outside");
fs.mkdirSync(sourceRoot);
fs.mkdirSync(destinationRoot);
fs.mkdirSync(outsideRoot);

let checks = 0;
async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`  ok - ${name}`);
}

function codeIs(code) {
  return (error) => error?.code === code;
}

function workerScript(name, source) {
  const filePath = path.join(tmp, name);
  fs.writeFileSync(filePath, source);
  return filePath;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function trustedReservation(overrides = {}) {
  return {
    protocol: DESTINATION_RESERVATION_PROTOCOL,
    fileName: "card.json",
    async write() {},
    async commit() {
      return {
        fileName: "card.json",
        publication: "test_broker_transaction",
        atomicVisibility: true,
        maintenanceWarnings: [],
      };
    },
    async reconcile() {
      return { status: "retryable_safe", errorCode: null };
    },
    async release() {},
    ...overrides,
  };
}

function trustedBroker(overrides = {}) {
  return {
    protocol: DESTINATION_BROKER_PROTOCOL,
    async reserve() {
      return trustedReservation();
    },
    ...overrides,
  };
}

const validSource = path.join(sourceRoot, "valid.json");
fs.copyFileSync("fixtures/character-worlds/v2-character.json", validSource);
const store = new MessageStore(path.join(tmp, "messages.db"), path.join(tmp, "blobs"));
const repository = store.characterWorlds();
const sourceAuthority = new CharacterSourceAuthority({ roots: [sourceRoot] });
const destinationBroker = createTestDestinationBroker(destinationRoot);
const destinationWriter = new CharacterDestinationWriter({ broker: destinationBroker });

function makeService(overrides = {}) {
  return new CharacterWorldsService({
    messageStore: store,
    repository,
    sourceAuthority,
    destinationWriter,
    resolveOwnerScope: async () => OWNER,
    ...overrides,
  });
}

const service = makeService();

try {
  console.log("character-worlds-import-hardening:");

  await check("source authority rejects traversal, symlinks, directories, and oversized files", async () => {
    const outside = path.join(outsideRoot, "private.json");
    fs.copyFileSync(validSource, outside);
    await assert.rejects(
      service.previewImport({ ownerScope: OWNER, sourcePath: outside }),
      codeIs("IMPORT_SOURCE_UNAUTHORIZED"),
    );
    await assert.rejects(
      service.previewImport({
        ownerScope: OWNER,
        sourcePath: path.join(sourceRoot, "..", "outside", "private.json"),
      }),
      codeIs("IMPORT_SOURCE_UNAUTHORIZED"),
    );

    const link = path.join(sourceRoot, "linked.json");
    fs.symlinkSync(outside, link);
    await assert.rejects(
      service.previewImport({ ownerScope: OWNER, sourcePath: link }),
      codeIs("IMPORT_SOURCE_SYMLINK"),
    );
    await assert.rejects(
      service.previewImport({ ownerScope: OWNER, sourcePath: sourceRoot }),
      codeIs("IMPORT_SOURCE_NOT_FILE"),
    );

    const oversized = path.join(sourceRoot, "oversized.bin");
    fs.closeSync(fs.openSync(oversized, "w"));
    fs.truncateSync(oversized, MAX_CHARACTER_SOURCE_BYTES + 1);
    await assert.rejects(
      service.previewImport({ ownerScope: OWNER, sourcePath: oversized }),
      codeIs("IMPORT_SOURCE_TOO_LARGE"),
    );
  });

  await check("source authority rejects a root replaced before read", async () => {
    const root = path.join(tmp, "root-replaced-before-read");
    const displaced = `${root}-original`;
    const outside = path.join(tmp, "root-replaced-before-read-outside");
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(root, "card.json"), '{"name":"authorized"}');
    fs.writeFileSync(path.join(outside, "card.json"), '{"name":"outside"}');
    const authority = new CharacterSourceAuthority({ roots: [root] });
    fs.renameSync(root, displaced);
    fs.symlinkSync(outside, root);
    try {
      await assert.rejects(
        authority.read(path.join(root, "card.json")),
        codeIs("IMPORT_SOURCE_ROOT_CHANGED"),
      );
    } finally {
      fs.unlinkSync(root);
      fs.renameSync(displaced, root);
    }
  });

  await check("source authority rechecks root identity after opening the source", async () => {
    const root = path.join(tmp, "root-replaced-during-read");
    const displaced = `${root}-original`;
    const outside = path.join(tmp, "root-replaced-during-read-outside");
    const source = path.join(root, "card.json");
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.writeFileSync(source, '{"name":"authorized"}');
    fs.writeFileSync(path.join(outside, "card.json"), '{"name":"outside"}');
    const originalOpen = fs.promises.open;
    let replaced = false;
    const fileSystem = {
      ...fs,
      promises: {
        ...fs.promises,
        async open(...args) {
          const handle = await originalOpen(...args);
          if (!replaced) {
            fs.renameSync(root, displaced);
            fs.symlinkSync(outside, root);
            replaced = true;
          }
          return handle;
        },
      },
    };
    const authority = new CharacterSourceAuthority({ roots: [root], fileSystem });
    try {
      await assert.rejects(
        authority.read(source),
        codeIs("IMPORT_SOURCE_ROOT_CHANGED"),
      );
    } finally {
      if (fs.lstatSync(root).isSymbolicLink()) fs.unlinkSync(root);
      if (fs.existsSync(displaced)) fs.renameSync(displaced, root);
    }
  });

  await check("case-insensitive path variants are not mistaken for symlinks", async () => {
    const root = path.join(tmp, "CaseVariantRoot");
    const source = path.join(root, "MixedCase.JSON");
    fs.mkdirSync(root);
    fs.writeFileSync(source, '{"name":"Case Variant"}');
    const variant = path.join(tmp, "casevariantroot", "mixedcase.json");
    if (!fs.existsSync(variant)) return;
    const authority = new CharacterSourceAuthority({ roots: [root] });
    const snapshot = await authority.read(variant);
    assert.equal(snapshot.bytes.toString("utf8"), '{"name":"Case Variant"}');
    assert.equal(
      fs.statSync(snapshot.fingerprint.canonicalPath).ino,
      fs.statSync(source).ino,
    );
  });

  await check("source handles retry transient close failures without accumulating descriptors", async () => {
    const originalOpen = fs.promises.open;
    let liveHandles = 0;
    const fileSystem = {
      ...fs,
      promises: {
        ...fs.promises,
        async open(...args) {
          const handle = await originalOpen(...args);
          liveHandles += 1;
          let closeAttempts = 0;
          return {
            stat: handle.stat.bind(handle),
            read: handle.read.bind(handle),
            async close() {
              closeAttempts += 1;
              if (closeAttempts === 1) {
                throw Object.assign(new Error("interrupted close"), { code: "EINTR" });
              }
              await handle.close();
              liveHandles -= 1;
            },
          };
        },
      },
    };
    const authority = new CharacterSourceAuthority({
      roots: [sourceRoot],
      fileSystem,
    });
    for (let index = 0; index < 20; index += 1) {
      const snapshot = await authority.read(validSource);
      assert(snapshot.bytes.length > 0);
    }
    assert.equal(liveHandles, 0);
  });

  await check("source close failures are stable and preserve a primary read error", async () => {
    const sourceBytes = fs.readFileSync(validSource);
    const sourceStat = await fs.promises.stat(validSource, { bigint: true });
    let failRead = false;
    let closeCalls = 0;
    const fileSystem = {
      ...fs,
      promises: {
        ...fs.promises,
        async open() {
          return {
            async stat() {
              return sourceStat;
            },
            async read(buffer, offset, length, position) {
              if (failRead) {
                throw Object.assign(new Error("read changed"), {
                  code: "IMPORT_SOURCE_CHANGED",
                });
              }
              const bytesRead = Math.min(length, sourceBytes.length - position);
              sourceBytes.copy(buffer, offset, position, position + bytesRead);
              return { bytesRead };
            },
            async close() {
              closeCalls += 1;
              throw Object.assign(new Error("persistent close failure"), { code: "EIO" });
            },
          };
        },
      },
    };
    const authority = new CharacterSourceAuthority({
      roots: [sourceRoot],
      fileSystem,
    });
    await assert.rejects(
      authority.read(validSource),
      codeIs("IMPORT_SOURCE_CLOSE_FAILED"),
    );
    failRead = true;
    await assert.rejects(
      authority.read(validSource),
      (error) => error?.code === "IMPORT_SOURCE_CHANGED"
        && error.cleanupError?.code === "IMPORT_SOURCE_CLOSE_FAILED",
    );
    assert.equal(closeCalls, 2);
  });

  await check("a source swapped to a symlink after preview is rejected terminally", async () => {
    const swap = path.join(sourceRoot, "swap.json");
    fs.copyFileSync(validSource, swap);
    const preview = await service.previewImport({ ownerScope: OWNER, sourcePath: swap });
    fs.unlinkSync(swap);
    fs.symlinkSync(path.join(outsideRoot, "private.json"), swap);
    await assert.rejects(
      service.commitImport({ ownerScope: OWNER, previewToken: preview.previewToken }),
      (error) => ["IMPORT_SOURCE_SYMLINK", "IMPORT_SOURCE_CHANGED"].includes(error?.code),
    );
    fs.unlinkSync(swap);
    fs.copyFileSync(validSource, swap);
    await assert.rejects(
      service.commitImport({ ownerScope: OWNER, previewToken: preview.previewToken }),
      codeIs("IMPORT_PREVIEW_EXPIRED"),
    );
  });

  await check("path errors and tokens never disclose private paths or contents", async () => {
    const secretName = "customer-secret-do-not-leak.json";
    const outside = path.join(outsideRoot, secretName);
    fs.writeFileSync(outside, "TOP-SECRET-CONTENT");
    let error;
    try {
      await service.previewImport({ ownerScope: OWNER, sourcePath: outside });
    } catch (caught) {
      error = caught;
    }
    const diagnostic = JSON.stringify({
      code: error?.code,
      message: error?.message,
      stack: error?.stack?.split("\n")[0],
    });
    assert(!diagnostic.includes(secretName));
    assert(!diagnostic.includes(outsideRoot));
    assert(!diagnostic.includes("TOP-SECRET-CONTENT"));

    const hostile = path.join(sourceRoot, "hostile-private.json");
    const privateContent = "PRIVATE-CARD-CONTENT-7391";
    fs.writeFileSync(hostile, `{"name":"${privateContent}","name":"duplicate"}`);
    let hostileError;
    try {
      await service.previewImport({ ownerScope: OWNER, sourcePath: hostile });
    } catch (caught) {
      hostileError = caught;
    }
    assert.equal(hostileError?.code, "CARD_DUPLICATE_KEY");
    assert(!JSON.stringify({
      message: hostileError?.message,
      stack: hostileError?.stack?.split("\n")[0],
    }).includes(privateContent));
  });

  await check("source fingerprints bind canonical identity, metadata, and SHA-256", async () => {
    const snapshot = await sourceAuthority.read(validSource);
    const fingerprint = snapshot.fingerprint;
    assert.equal(fingerprint.canonicalPath, fs.realpathSync(validSource));
    assert.equal(fingerprint.sha256, crypto.createHash("sha256")
      .update(fs.readFileSync(validSource)).digest("hex"));
    assert.match(fingerprint.identity.device, /^\d+$/);
    assert.match(fingerprint.identity.inode, /^\d+$/);
    assert.equal(fingerprint.identity.size, fs.statSync(validSource).size);
    assert.match(fingerprint.identity.mtimeNs, /^\d+$/);
  });

  await check("unapproved, traversing, existing, and symlink destinations are rejected", async () => {
    const preview = await service.previewImport({ ownerScope: OWNER, sourcePath: validSource });
    const committed = await service.commitImport({
      ownerScope: OWNER,
      previewToken: preview.previewToken,
    });
    await assert.rejects(
      service.exportCharacter({
        ownerScope: OWNER,
        revisionId: committed.revision.id,
        destinationCapability: path.join(destinationRoot, "renderer-path.json"),
      }),
      codeIs("EXPORT_DESTINATION_INVALID"),
    );
    await assert.rejects(
      destinationWriter.approve(path.join(destinationRoot, "..", "outside.json")),
      codeIs("EXPORT_DESTINATION_UNAUTHORIZED"),
    );
    const existing = path.join(destinationRoot, "existing.json");
    fs.writeFileSync(existing, "keep");
    await assert.rejects(
      destinationWriter.approve(existing),
      codeIs("EXPORT_DESTINATION_EXISTS"),
    );
    const symlink = path.join(destinationRoot, "symlink.json");
    fs.symlinkSync(path.join(outsideRoot, "private.json"), symlink);
    await assert.rejects(
      destinationWriter.approve(symlink),
      codeIs("EXPORT_DESTINATION_SYMLINK"),
    );
  });

  await check("writer has no production path fallback and trusts only broker reservations", async () => {
    assert.throws(
      () => new CharacterDestinationWriter({ roots: [destinationRoot] }),
      /destination broker/i,
    );
    const parent = path.join(destinationRoot, "approval-race");
    const displaced = `${parent}-approved`;
    fs.mkdirSync(parent);
    const target = path.join(parent, "card.json");
    let released = 0;
    const adversarialBroker = trustedBroker({
      async reserve() {
        fs.renameSync(parent, displaced);
        fs.symlinkSync(outsideRoot, parent);
        const reservation = {
          async write() {
            throw Object.assign(new Error("changed"), {
              code: "EXPORT_DESTINATION_CHANGED",
            });
          },
          async release() {
            released += 1;
          },
        };
        await reservation.release();
        throw Object.assign(new Error("changed"), {
          code: "EXPORT_DESTINATION_CHANGED",
        });
      },
    });
    const writer = new CharacterDestinationWriter({ broker: adversarialBroker });
    await assert.rejects(writer.approve(target), codeIs("EXPORT_DESTINATION_CHANGED"));
    assert.equal(released, 1);
    assert.equal(fs.existsSync(path.join(outsideRoot, "card.json")), false);
    await writer.close();
  });

  await check("an approved transaction cannot be redirected by swapping its parent", async () => {
    const parent = path.join(destinationRoot, "replaceable");
    fs.mkdirSync(parent);
    const destination = path.join(parent, "card.json");
    const capability = await destinationWriter.approve(destination);
    fs.renameSync(parent, `${parent}-old`);
    fs.symlinkSync(outsideRoot, parent);

    const revision = repository.listCharacters(OWNER)[0];
    const result = await service.exportCharacter({
      ownerScope: OWNER,
      revisionId: revision.currentRevisionId,
      destinationCapability: capability,
    });
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(path.join(outsideRoot, "card.json")), false);
    assert(fs.statSync(`${parent}-old/card.json`).size > 0);
  });

  await check("a post-commit reservation cleanup failure cannot turn export into failure", async () => {
    const releaseRoot = path.join(destinationRoot, "post-commit-release");
    fs.mkdirSync(releaseRoot);
    const baseBroker = createTestDestinationBroker(releaseRoot);
    let injected = 0;
    const broker = trustedBroker({
      async reserve(...args) {
        const reservation = await baseBroker.reserve(...args);
        return trustedReservation({
          fileName: reservation.fileName,
          write: reservation.write.bind(reservation),
          commit: reservation.commit.bind(reservation),
          async release() {
            await reservation.release();
            if (injected === 0) {
              injected += 1;
              throw Object.assign(new Error("injected cleanup failure"), {
                code: "EACCES",
              });
            }
          },
        });
      },
    });
    const writer = new CharacterDestinationWriter({ broker });
    const releaseService = makeService({ destinationWriter: writer });
    const target = path.join(releaseRoot, "release-failure.json");
    const capability = await writer.approve(target);
    const revision = repository.listCharacters(OWNER)[0];
    const result = await releaseService.exportCharacter({
      ownerScope: OWNER,
      revisionId: revision.currentRevisionId,
      destinationCapability: capability,
    });
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(target), true);
    assert(fs.statSync(target).size > 0);
    assert.equal(injected, 1);
    await releaseService.close();
    await writer.close();
    await baseBroker.close();
  });

  await check("unused destination capabilities expire and never create output", async () => {
    let now = 5000;
    const expiringBroker = createTestDestinationBroker(destinationRoot);
    const writer = new CharacterDestinationWriter({
      broker: expiringBroker,
      now: () => now,
      capabilityTtlMs: 50,
    });
    const target = path.join(destinationRoot, "expired-capability.json");
    const capability = await writer.approve(target);
    assert.equal(fs.existsSync(target), true, "approval creates the direct reservation");
    assert.equal(fs.statSync(target).size, 0);
    now += 51;
    await assert.rejects(
      writer.write(capability, Buffer.from("{}")),
      codeIs("EXPORT_DESTINATION_INVALID"),
    );
    assert.equal(fs.existsSync(target), false);
    await writer.close();
    await expiringBroker.close();
  });

  await check("destination cancel and release are idempotent and close drains owned reservations", async () => {
    const cancelRoot = path.join(destinationRoot, "cancel");
    fs.mkdirSync(cancelRoot);
    const broker = createTestDestinationBroker(cancelRoot);
    const writer = new CharacterDestinationWriter({ broker, ownsBroker: true });
    const target = path.join(cancelRoot, "cancelled.json");
    const capability = await writer.approve(target);
    assert.equal(broker.stats().reservations, 1);
    assert.equal(await writer.cancel(capability), true);
    assert.equal(await writer.release(capability), false);
    assert.equal(fs.existsSync(target), false);
    assert.equal(broker.stats().reservations, 0);

    const unused = path.join(cancelRoot, "unused.json");
    await writer.approve(unused);
    await writer.close();
    await writer.close();
    assert.equal(fs.existsSync(unused), false);
    assert.deepEqual(broker.stats(), { reservations: 0, closed: true });
  });

  await check("destination close waits for an in-flight broker reservation and releases it", async () => {
    const reserveStarted = deferred();
    const releaseReserve = deferred();
    let released = 0;
    let brokerClosed = 0;
    const broker = trustedBroker({
      async reserve(_request, { signal, deadline } = {}) {
        assert(signal instanceof AbortSignal);
        assert(Number.isFinite(deadline));
        reserveStarted.resolve();
        await releaseReserve.promise;
        return trustedReservation({
          async write() {
            throw new Error("not written");
          },
          async release() {
            released += 1;
          },
        });
      },
      async close() {
        brokerClosed += 1;
      },
    });
    const writer = new CharacterDestinationWriter({ broker, ownsBroker: true });
    const approving = writer.approve({ saveDialogGrant: "opaque" });
    await reserveStarted.promise;
    const closing = writer.close();
    assert.equal(await Promise.race([
      closing.then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("waiting"), 30)),
    ]), "waiting");
    releaseReserve.resolve();
    await assert.rejects(approving, codeIs("EXPORT_DESTINATION_CLOSED"));
    await closing;
    assert.equal(released, 1);
    assert.equal(brokerClosed, 1);
    assert.equal(writer.capabilities.size, 0);
  });

  await check("destination close aborts and drains an in-flight reservation write", async () => {
    const writeStarted = deferred();
    const fallbackRelease = deferred();
    let released = 0;
    let brokerClosed = 0;
    const broker = trustedBroker({
      async reserve() {
        return trustedReservation({
          async write(_bytes, { signal } = {}) {
            writeStarted.resolve();
            return new Promise((resolve, reject) => {
              const abort = () => reject(
                signal.reason || Object.assign(new Error("closed"), {
                  code: "EXPORT_DESTINATION_CLOSED",
                }),
              );
              if (signal?.aborted) abort();
              else signal?.addEventListener("abort", abort, { once: true });
              fallbackRelease.promise.then(resolve);
            });
          },
          async release() {
            released += 1;
          },
        });
      },
      async close() {
        brokerClosed += 1;
      },
    });
    const writer = new CharacterDestinationWriter({ broker, ownsBroker: true });
    const capability = await writer.approve({ saveDialogGrant: "opaque" });
    const writing = writer.write(capability, Buffer.from("{}"));
    await writeStarted.promise;
    const closing = writer.close();
    const settled = await Promise.race([
      writing.then(
        () => ({ status: "fulfilled" }),
        (error) => ({ status: "rejected", error }),
      ),
      new Promise((resolve) => setTimeout(() => resolve({ status: "pending" }), 100)),
    ]);
    fallbackRelease.resolve({
      bytes: 2,
      fileName: "late.json",
    });
    assert.equal(settled.status, "rejected");
    assert.equal(settled.error?.code, "EXPORT_DESTINATION_CLOSED");
    await closing;
    assert.equal(released, 1);
    assert.equal(brokerClosed, 1);
  });

  await check("export failures before write release destination capabilities", async () => {
    const releaseRoot = path.join(destinationRoot, "prewrite-release");
    fs.mkdirSync(releaseRoot);
    const broker = createTestDestinationBroker(releaseRoot);
    const writer = new CharacterDestinationWriter({ broker });
    const releaseService = makeService({ destinationWriter: writer });

    const missingTarget = path.join(releaseRoot, "missing.json");
    const missingCapability = await writer.approve(missingTarget);
    await assert.rejects(
      releaseService.exportCharacter({
        ownerScope: OWNER,
        revisionId: crypto.randomUUID(),
        destinationCapability: missingCapability,
      }),
      codeIs("CHARACTER_REVISION_NOT_FOUND"),
    );
    assert.equal(fs.existsSync(missingTarget), false);

    const ownerTarget = path.join(releaseRoot, "owner.json");
    const ownerCapability = await writer.approve(ownerTarget);
    const wrongOwnerService = makeService({
      destinationWriter: writer,
      resolveOwnerScope: async () => OTHER_OWNER,
    });
    const revision = repository.listCharacters(OWNER)[0];
    await assert.rejects(
      wrongOwnerService.exportCharacter({
        ownerScope: OWNER,
        revisionId: revision.currentRevisionId,
        destinationCapability: ownerCapability,
      }),
      codeIs("IMPORT_OWNER_MISMATCH"),
    );
    assert.equal(fs.existsSync(ownerTarget), false);
    assert.equal(broker.stats().reservations, 0);
    await wrongOwnerService.close();
    await releaseService.close();
    await writer.close();
    await broker.close();
  });

  await check("service surfaces pre-write release failure and preserves a retryable tombstone", async () => {
    let releaseCalls = 0;
    const broker = trustedBroker({
      async reserve() {
        return trustedReservation({
          async release() {
            releaseCalls += 1;
            if (releaseCalls === 1) throw new Error("injected release failure");
          },
        });
      },
    });
    const writer = new CharacterDestinationWriter({ broker });
    const releaseService = makeService({ destinationWriter: writer });
    const capability = await writer.approve({ saveDialogGrant: "opaque" });
    await assert.rejects(
      releaseService.exportCharacter({
        ownerScope: OWNER,
        revisionId: crypto.randomUUID(),
        destinationCapability: capability,
      }),
      codeIs("EXPORT_RELEASE_FAILED"),
    );
    assert.equal(writer.capabilities.size, 1);
    assert.equal(await writer.release(capability), true);
    assert.equal(releaseCalls, 2);
    assert.equal(writer.capabilities.size, 0);
    await releaseService.close();
    await writer.close();
  });

  await check("service close during owner resolution releases the unwritten capability", async () => {
    const lifecycleRoot = path.join(destinationRoot, "lifecycle-release");
    fs.mkdirSync(lifecycleRoot);
    const broker = createTestDestinationBroker(lifecycleRoot);
    const writer = new CharacterDestinationWriter({ broker });
    const ownerStarted = deferred();
    const releaseOwner = deferred();
    const lifecycleService = makeService({
      destinationWriter: writer,
      async resolveOwnerScope() {
        ownerStarted.resolve();
        await releaseOwner.promise;
        return OWNER;
      },
    });
    const target = path.join(lifecycleRoot, "closed-before-write.json");
    const capability = await writer.approve(target);
    const revision = repository.listCharacters(OWNER)[0];
    const exporting = lifecycleService.exportCharacter({
      ownerScope: OWNER,
      revisionId: revision.currentRevisionId,
      destinationCapability: capability,
    });
    await ownerStarted.promise;
    const closing = lifecycleService.close();
    releaseOwner.resolve();
    await assert.rejects(exporting, codeIs("IMPORT_SERVICE_CLOSED"));
    await closing;
    assert.equal(fs.existsSync(target), false);
    assert.equal(broker.stats().reservations, 0);
    await writer.close();
    await broker.close();
  });

  await check("service close owns writer cleanup only when explicitly configured", async () => {
    const ownedRoot = path.join(destinationRoot, "owned-close");
    fs.mkdirSync(ownedRoot);
    const ownedBroker = createTestDestinationBroker(ownedRoot);
    const ownedWriter = new CharacterDestinationWriter({
      broker: ownedBroker,
      ownsBroker: true,
    });
    const ownedService = makeService({
      destinationWriter: ownedWriter,
      ownsDestinationWriter: true,
    });
    const ownedTarget = path.join(ownedRoot, "unused.json");
    await ownedWriter.approve(ownedTarget);
    await ownedService.close();
    assert.equal(fs.existsSync(ownedTarget), false);
    assert.deepEqual(ownedBroker.stats(), { reservations: 0, closed: true });

    const sharedRoot = path.join(destinationRoot, "shared-close");
    fs.mkdirSync(sharedRoot);
    const sharedBroker = createTestDestinationBroker(sharedRoot);
    const sharedWriter = new CharacterDestinationWriter({ broker: sharedBroker });
    const sharedService = makeService({ destinationWriter: sharedWriter });
    const sharedTarget = path.join(sharedRoot, "unused.json");
    const sharedCapability = await sharedWriter.approve(sharedTarget);
    await sharedService.close();
    assert.equal(fs.existsSync(sharedTarget), true);
    assert.equal(sharedBroker.stats().reservations, 1);
    await sharedWriter.release(sharedCapability);
    await sharedWriter.close();
    await sharedBroker.close();
    assert.equal(fs.existsSync(sharedTarget), false);
  });

  await check("service-owned destination cleanup remains retryable after failure", async () => {
    let closeCalls = 0;
    const retryableWriter = {
      async write() {},
      async release() {},
      async close() {
        closeCalls += 1;
        if (closeCalls === 1) {
          throw Object.assign(new Error("cleanup failed"), {
            code: "EXPORT_CLOSE_FAILED",
          });
        }
      },
    };
    const retryableService = makeService({
      destinationWriter: retryableWriter,
      ownsDestinationWriter: true,
      workerPool: { async parse() {} },
    });
    await assert.rejects(
      retryableService.close(),
      codeIs("EXPORT_CLOSE_FAILED"),
    );
    await retryableService.close();
    assert.equal(closeCalls, 2);
  });

  await check("service close preserves unknown commit recovery information", async () => {
    const unknownRoot = path.join(destinationRoot, "service-unknown-commit");
    const target = path.join(unknownRoot, "unknown.json");
    fs.mkdirSync(unknownRoot);
    const broker = createReferenceDestinationBroker({
      approvedParent: unknownRoot,
      requestTimeoutMs: 500,
      testCommitNeverRespond: true,
    });
    const writer = new CharacterDestinationWriter({
      broker,
      ownsBroker: true,
      commitTimeoutMs: 30,
      closeTimeoutMs: 60,
    });
    const unknownService = makeService({
      destinationWriter: writer,
      ownsDestinationWriter: true,
    });
    let capability;
    try {
      await broker.ready();
      capability = await writer.approve({ fileName: "unknown.json" });
      const revision = repository.listCharacters(OWNER)[0];
      const exporting = unknownService.exportCharacter({
        ownerScope: OWNER,
        revisionId: revision.currentRevisionId,
        destinationCapability: capability,
      });
      const exportOutcome = exporting.then(
        (value) => ({ status: "fulfilled", value }),
        (error) => ({ status: "rejected", error }),
      );
      await waitFor(
        () => writer.capabilities.get(capability)?.state === "committing",
        "service export did not publish commit",
      );
      const closing = unknownService.close();
      const closeOutcome = closing.then(
        () => ({ status: "fulfilled" }),
        (error) => ({ status: "rejected", error }),
      );
      const exported = await exportOutcome;
      const closed = await closeOutcome;
      assert.equal(exported.status, "rejected");
      assert.equal(exported.error?.code, "EXPORT_COMMIT_OUTCOME_UNKNOWN");
      assert.equal(exported.error?.capability, capability);
      assert.equal(closed.status, "rejected");
      assert.equal(closed.error?.code, "EXPORT_CLOSE_OUTCOME_UNKNOWN");
      assert(closed.error?.unknownCapabilities?.includes(capability));
      assert.equal(writer.capabilities.get(capability)?.state, "outcome_unknown");
      assert.ok(fs.statSync(target).size > 0);
    } finally {
      broker._terminate();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });

  await check("JSON card discrimination is escape-aware and ignores marker-looking values", async () => {
    const pool = new CharacterImportWorkerPool({ timeoutMs: 5000 });
    await assert.rejects(
      pool.parse(Buffer.from(
        '{"sp\\u0065c":"chara\\u005fcard\\u005fv2",'
        + '"d\\u0061ta":{"na\\u006de":"Escaped hostile"},'
        + '"d\\u0061ta":{"na\\u006de":"Duplicate"}',
      )),
      (error) => typeof error?.code === "string" && error.code !== "NOT_A_CHARACTER_CARD",
    );
    assert.deepEqual(
      await pool.parse(Buffer.from(
        '{"note":"marker text: \\"spec\\":\\"chara_card_v2\\" and \\"name\\"",'
        + '"note":"duplicate"}',
      )),
      {
        ok: false,
        kind: "ordinaryAttachment",
        code: "NOT_A_CHARACTER_CARD",
      },
    );
    assert.deepEqual(
      await pool.parse(Buffer.from(
        `{"note":"${"x".repeat(1024 * 1024)} \\"spec\\":\\"chara_card_v2\\"",`
        + '"note":"duplicate"}',
      )),
      {
        ok: false,
        kind: "ordinaryAttachment",
        code: "NOT_A_CHARACTER_CARD",
      },
    );
    await pool.close();
  });

  await check("JSON discrimination scans the full container and deep ordinary JSON fails open", async () => {
    const pool = new CharacterImportWorkerPool({ timeoutMs: 10_000 });
    const lateMarker = Buffer.from(
      `{"padding":"${"x".repeat(2 * 1024 * 1024)}",`
      + '"sp\\u0065c":"chara\\u005fcard\\u005fv2",'
      + '"d\\u0061ta":{"na\\u006de":"Late marker"},'
      + '"d\\u0061ta":{"na\\u006de":"Duplicate"}}',
    );
    assert(lateMarker.length < MAX_CHARACTER_SOURCE_BYTES);
    await assert.rejects(
      pool.parse(lateMarker),
      (error) => typeof error?.code === "string"
        && error.code !== "NOT_A_CHARACTER_CARD",
    );

    const nested = `${'{"nested":'.repeat(96)}"ordinary"${"}".repeat(96)}`;
    assert.deepEqual(
      await pool.parse(Buffer.from(nested)),
      {
        ok: false,
        kind: "ordinaryAttachment",
        code: "NOT_A_CHARACTER_CARD",
      },
    );
    await pool.close();
  });

  await check("close cancels an active worker and drains it before returning", async () => {
    const file = workerScript("service-close-worker.cjs", `
      const { parentPort } = require("node:worker_threads");
      parentPort.on("message", () => {});
    `);
    const pool = new CharacterImportWorkerPool({
      workerFile: file,
      timeoutMs: 10_000,
      maxConcurrency: 1,
    });
    const closingService = makeService({ workerPool: pool });
    const externalAbort = new AbortController();
    const preview = closingService.previewImport({
      ownerScope: OWNER,
      sourcePath: validSource,
      signal: externalAbort.signal,
    });
    while (pool.stats().active === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await closingService.close();
    const settled = await Promise.race([
      preview.then(
        () => ({ status: "fulfilled" }),
        (error) => ({ status: "rejected", error }),
      ),
      new Promise((resolve) => setTimeout(() => resolve({ status: "pending" }), 100)),
    ]);
    if (settled.status === "pending") externalAbort.abort();
    assert.equal(settled.status, "rejected");
    assert(
      ["IMPORT_SERVICE_CLOSED", "IMPORT_PARSE_CANCELLED"].includes(settled.error?.code),
    );
    await pool.close();
    assert.deepEqual(pool.stats(), { active: 0, queued: 0 });
    assert.equal(closingService.previews.size, 0);
    await assert.rejects(
      closingService.previewImport({ ownerScope: OWNER, sourcePath: validSource }),
      codeIs("IMPORT_SERVICE_CLOSED"),
    );
  });

  await check("close waits for delayed commit admission and prevents later persistence", async () => {
    const delayedPath = path.join(sourceRoot, "close-commit.json");
    const fixture = JSON.parse(fs.readFileSync(validSource, "utf8"));
    fixture.data.name = "Close Commit Unique";
    fs.writeFileSync(delayedPath, JSON.stringify(fixture));
    const firstRead = await sourceAuthority.read(delayedPath);
    const readStarted = deferred();
    const releaseRead = deferred();
    let reads = 0;
    const delayedAuthority = {
      async read(sourcePath, options) {
        reads += 1;
        if (reads === 2) {
          readStarted.resolve();
          await releaseRead.promise;
        }
        if (reads === 1) return firstRead;
        return sourceAuthority.read(sourcePath, options);
      },
    };
    const closingService = makeService({ sourceAuthority: delayedAuthority });
    const preview = await closingService.previewImport({
      ownerScope: OWNER,
      sourcePath: delayedPath,
    });
    const before = repository.listCharacters(OWNER).length;
    const commit = closingService.commitImport({
      ownerScope: OWNER,
      previewToken: preview.previewToken,
    });
    await readStarted.promise;
    const close = closingService.close();
    const closeState = await Promise.race([
      close.then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("waiting"), 30)),
    ]);
    releaseRead.resolve();
    const settled = await Promise.allSettled([commit, close]);
    assert.equal(closeState, "waiting");
    assert.equal(settled[0].status, "rejected");
    assert.equal(settled[0].reason?.code, "IMPORT_SERVICE_CLOSED");
    assert.equal(repository.listCharacters(OWNER).length, before);
    assert.equal(closingService.previews.size, 0);
    await assert.rejects(
      closingService.commitImport({
        ownerScope: OWNER,
        previewToken: preview.previewToken,
      }),
      codeIs("IMPORT_SERVICE_CLOSED"),
    );
  });

  await check("close aborts delayed destination writes and leaves no export", async () => {
    const revision = repository.listCharacters(OWNER)[0];
    const writeStarted = deferred();
    const releaseWrite = deferred();
    const target = path.join(destinationRoot, "close-export.json");
    const delayedWriter = {
      async write(_capability, bytes, { signal } = {}) {
        writeStarted.resolve();
        await releaseWrite.promise;
        if (signal?.aborted) {
          throw Object.assign(new Error("closed"), { code: "IMPORT_SERVICE_CLOSED" });
        }
        fs.writeFileSync(target, bytes);
        return { bytes: bytes.length, fileName: path.basename(target) };
      },
      async release() {},
    };
    const closingService = makeService({ destinationWriter: delayedWriter });
    const exported = closingService.exportCharacter({
      ownerScope: OWNER,
      revisionId: revision.currentRevisionId,
      destinationCapability: "opaque-main-capability",
    });
    await writeStarted.promise;
    const close = closingService.close();
    const closeState = await Promise.race([
      close.then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("waiting"), 30)),
    ]);
    releaseWrite.resolve();
    const settled = await Promise.allSettled([exported, close]);
    assert.equal(closeState, "waiting");
    assert.equal(settled[0].status, "rejected");
    assert.equal(settled[0].reason?.code, "IMPORT_SERVICE_CLOSED");
    assert.equal(fs.existsSync(target), false);
  });

  await check("worker hard timeout terminates a non-responsive parser", async () => {
    const file = workerScript("timeout-worker.cjs", "setInterval(() => {}, 1000);");
    const pool = new CharacterImportWorkerPool({
      workerFile: file,
      timeoutMs: 30,
      maxConcurrency: 1,
      maxQueue: 1,
    });
    await assert.rejects(pool.parse(Buffer.from("{}")), codeIs("IMPORT_PARSE_TIMEOUT"));
    await pool.close();
    assert.deepEqual(pool.stats(), { active: 0, queued: 0 });
  });

  await check("worker slots remain occupied until termination and close waits for cleanup", async () => {
    const terminationGates = [deferred(), deferred()];
    let created = 0;
    let terminated = 0;
    class ControlledWorker extends EventEmitter {
      constructor() {
        super();
        this.gate = terminationGates[created];
        created += 1;
      }

      postMessage({ jobId }) {
        queueMicrotask(() => this.emit("message", {
          jobId,
          ok: true,
          payload: Uint8Array.from(v8.serialize({
            ok: false,
            kind: "ordinaryAttachment",
            code: "NOT_A_CHARACTER_CARD",
          })).buffer,
        }));
      }

      terminate() {
        return this.gate.promise.then(() => {
          terminated += 1;
          this.emit("exit", 0);
          return 0;
        });
      }
    }

    const pool = new CharacterImportWorkerPool({
      maxConcurrency: 1,
      maxQueue: 1,
      createWorker() {
        return new ControlledWorker();
      },
    });
    const first = pool.parse(Buffer.from("{}"));
    assert.equal((await first).kind, "ordinaryAttachment");
    assert.deepEqual(pool.stats(), { active: 1, queued: 0 });

    const second = pool.parse(Buffer.from("{}"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(created, 1);
    assert.deepEqual(pool.stats(), { active: 1, queued: 1 });
    terminationGates[0].resolve();
    while (created < 2) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal((await second).kind, "ordinaryAttachment");

    const closing = pool.close();
    const closeState = await Promise.race([
      closing.then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("waiting"), 10)),
    ]);
    assert.equal(closeState, "waiting");
    terminationGates[1].resolve();
    await closing;
    assert.equal(terminated, 2);
    assert.deepEqual(pool.stats(), { active: 0, queued: 0 });

  });

  await check("terminate rejection without exit retains its slot and close fails bounded", async () => {
    let created = 0;
    class RejectingTerminationWorker extends EventEmitter {
      constructor() {
        super();
        created += 1;
      }

      postMessage({ jobId }) {
        queueMicrotask(() => this.emit("message", {
          jobId,
          ok: true,
          payload: Uint8Array.from(v8.serialize({
            ok: false,
            kind: "ordinaryAttachment",
            code: "NOT_A_CHARACTER_CARD",
          })).buffer,
        }));
      }

      terminate() {
        return Promise.reject(new Error("injected terminate rejection"));
      }
    }
    const rejectingPool = new CharacterImportWorkerPool({
      maxConcurrency: 1,
      maxQueue: 1,
      terminationTimeoutMs: 40,
      createWorker() {
        return new RejectingTerminationWorker();
      },
    });
    assert.equal((await rejectingPool.parse(Buffer.from("{}"))).kind, "ordinaryAttachment");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(rejectingPool.stats(), { active: 1, queued: 0 });

    const queued = rejectingPool.parse(Buffer.from("{}"));
    const queuedOutcome = queued.then(
      () => ({ status: "fulfilled" }),
      (error) => ({ status: "rejected", error }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(created, 1);
    assert.deepEqual(rejectingPool.stats(), { active: 1, queued: 1 });
    const startedAt = Date.now();
    await assert.rejects(
      rejectingPool.close(),
      codeIs("IMPORT_WORKER_TERMINATION_FAILED"),
    );
    assert(Date.now() - startedAt < 500);
    const queuedResult = await queuedOutcome;
    assert.equal(queuedResult.status, "rejected");
    assert.equal(queuedResult.error?.code, "IMPORT_WORKER_CLOSED");
    assert.deepEqual(rejectingPool.stats(), { active: 1, queued: 0 });
  });

  await check("terminate rejection followed by exit releases the slot", async () => {
    class RejectThenExitWorker extends EventEmitter {
      postMessage({ jobId }) {
        queueMicrotask(() => this.emit("message", {
          jobId,
          ok: true,
          payload: Uint8Array.from(v8.serialize({
            ok: false,
            kind: "ordinaryAttachment",
            code: "NOT_A_CHARACTER_CARD",
          })).buffer,
        }));
      }

      terminate() {
        setTimeout(() => this.emit("exit", 0), 30);
        return Promise.reject(new Error("terminate raced with worker exit"));
      }
    }

    const pool = new CharacterImportWorkerPool({
      maxConcurrency: 1,
      terminationTimeoutMs: 100,
      createWorker() {
        return new RejectThenExitWorker();
      },
    });
    assert.equal((await pool.parse(Buffer.from("{}"))).kind, "ordinaryAttachment");
    const closing = pool.close();
    const closeState = await Promise.race([
      closing.then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("waiting"), 10)),
    ]);
    assert.equal(closeState, "waiting");
    await closing;
    assert.deepEqual(pool.stats(), { active: 0, queued: 0 });
  });

  await check("worker crashes and malformed messages become stable protocol errors", async () => {
    const crashFile = workerScript("crash-worker.cjs", "process.exit(7);");
    const crashPool = new CharacterImportWorkerPool({
      workerFile: crashFile,
      timeoutMs: 1000,
    });
    await assert.rejects(crashPool.parse(Buffer.from("{}")), codeIs("IMPORT_WORKER_CRASH"));
    await crashPool.close();

    const invalidFile = workerScript("invalid-worker.cjs", `
      const { parentPort } = require("node:worker_threads");
      parentPort.on("message", ({ jobId }) => {
        parentPort.postMessage({ jobId, ok: true, parsed: { canonical: { name: 42 } } });
      });
    `);
    const invalidPool = new CharacterImportWorkerPool({
      workerFile: invalidFile,
      timeoutMs: 1000,
    });
    await assert.rejects(
      invalidPool.parse(Buffer.from("{}")),
      codeIs("IMPORT_WORKER_PROTOCOL"),
    );
    await invalidPool.close();

    const forgedFile = workerScript("forged-error-worker.cjs", `
      const { parentPort } = require("node:worker_threads");
      parentPort.on("message", ({ jobId }) => {
        parentPort.postMessage({ jobId, ok: false, error: { code: "ROOT_PASSWORD" } });
      });
    `);
    const forgedPool = new CharacterImportWorkerPool({
      workerFile: forgedFile,
      timeoutMs: 1000,
    });
    await assert.rejects(
      forgedPool.parse(Buffer.from("{}")),
      codeIs("IMPORT_WORKER_PROTOCOL"),
    );
    await forgedPool.close();
  });

  await check("active and queued worker jobs honor AbortSignal cancellation", async () => {
    const file = workerScript("cancel-worker.cjs", `
      const { parentPort } = require("node:worker_threads");
      parentPort.on("message", () => {});
    `);
    const pool = new CharacterImportWorkerPool({
      workerFile: file,
      timeoutMs: 10_000,
      maxConcurrency: 1,
      maxQueue: 2,
    });
    const activeAbort = new AbortController();
    const queuedAbort = new AbortController();
    const active = pool.parse(Buffer.from("{}"), { signal: activeAbort.signal });
    const queued = pool.parse(Buffer.from("{}"), { signal: queuedAbort.signal });
    queuedAbort.abort();
    activeAbort.abort();
    await assert.rejects(queued, codeIs("IMPORT_PARSE_CANCELLED"));
    await assert.rejects(active, codeIs("IMPORT_PARSE_CANCELLED"));
    await pool.close();
    assert.deepEqual(pool.stats(), { active: 0, queued: 0 });
  });

  await check("worker queue has bounded backpressure and input bytes are hard-capped", async () => {
    const file = workerScript("busy-worker.cjs", `
      const { parentPort } = require("node:worker_threads");
      parentPort.on("message", () => {});
    `);
    const pool = new CharacterImportWorkerPool({
      workerFile: file,
      timeoutMs: 10_000,
      maxConcurrency: 1,
      maxQueue: 1,
    });
    const abort = new AbortController();
    const first = pool.parse(Buffer.from("{}"), { signal: abort.signal });
    const secondAbort = new AbortController();
    const second = pool.parse(Buffer.from("{}"), { signal: secondAbort.signal });
    await assert.rejects(
      pool.parse(Buffer.from("{}")),
      codeIs("IMPORT_PARSE_BUSY"),
    );
    await assert.rejects(
      pool.parse(Buffer.alloc(MAX_CHARACTER_SOURCE_BYTES + 1)),
      codeIs("IMPORT_SOURCE_TOO_LARGE"),
    );
    secondAbort.abort();
    abort.abort();
    await assert.rejects(second, codeIs("IMPORT_PARSE_CANCELLED"));
    await assert.rejects(first, codeIs("IMPORT_PARSE_CANCELLED"));
    await pool.close();

    const bytePool = new CharacterImportWorkerPool({
      workerFile: file,
      timeoutMs: 10_000,
      maxConcurrency: 1,
      maxQueue: 8,
      maxQueuedBytes: 2,
    });
    const activeAbort = new AbortController();
    const queuedAbort = new AbortController();
    const active = bytePool.parse(Buffer.from("{}"), { signal: activeAbort.signal });
    const queued = bytePool.parse(Buffer.from("{}"), { signal: queuedAbort.signal });
    await assert.rejects(
      bytePool.parse(Buffer.from("x")),
      codeIs("IMPORT_PARSE_BUSY"),
    );
    queuedAbort.abort();
    activeAbort.abort();
    await assert.rejects(queued, codeIs("IMPORT_PARSE_CANCELLED"));
    await assert.rejects(active, codeIs("IMPORT_PARSE_CANCELLED"));
    await bytePool.close();
  });

  await check("ordinary worker fallback and real parser messages remain bounded", async () => {
    const pool = new CharacterImportWorkerPool({ timeoutMs: 5000 });
    const fallback = await pool.parse(Buffer.alloc(1024 * 1024, 0xa5));
    assert.deepEqual(fallback, {
      ok: false,
      kind: "ordinaryAttachment",
      code: "NOT_A_CHARACTER_CARD",
    });
    const parsed = await pool.parse(fs.readFileSync(validSource));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.canonical.name, "Luna V2");
    await pool.close();
  });
} finally {
  await service.close();
  await destinationWriter.close();
  await destinationBroker.close();
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`character-worlds-import-hardening: ${checks} checks passed`);
