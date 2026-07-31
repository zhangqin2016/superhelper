"use strict";

const crypto = require("node:crypto");
const v8 = require("node:v8");
const { MAX_CHARACTER_SOURCE_BYTES } = require("./constants");
const {
  buildCanonicalV3,
  buildExportLossReport,
  readExactOriginal,
} = require("./export-card");
const {
  CharacterDestinationWriter,
} = require("./export-destination-writer");
const {
  CharacterSourceAuthority,
  fingerprintMatches,
  importError,
} = require("./import-file-authority");
const { CharacterImportWorkerPool } = require("./import-worker-pool");
const { stableJson } = require("./persistence-codec");

const DEFAULT_PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_PREVIEW_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_PREVIEWS = 16;
const MAX_PREVIEW_CACHE_BYTES = 64 * 1024 * 1024;

function contentHash(canonical) {
  return `sha256:${crypto.createHash("sha256").update(stableJson(canonical)).digest("hex")}`;
}

function validOwner(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 1024
    && !/[\u0000-\u001f\u007f]/.test(value);
}

class CharacterWorldsService {
  constructor({
    messageStore,
    repository,
    resolveOwnerScope,
    now = Date.now,
    sourceAuthority,
    destinationWriter,
    ownsDestinationWriter = false,
    workerPool,
    previewTtlMs = DEFAULT_PREVIEW_TTL_MS,
    maxPreviews = DEFAULT_MAX_PREVIEWS,
    maxPreviewBytes = MAX_PREVIEW_CACHE_BYTES,
  } = {}) {
    if (!messageStore?.blobs) {
      throw new TypeError("CharacterWorldsService requires MessageStore");
    }
    const resolvedRepository = repository || messageStore.characterWorlds?.();
    if (
      !resolvedRepository?.importCharacter
      || !resolvedRepository?.findImportDuplicates
      || !resolvedRepository?.getRevision
    ) {
      throw new TypeError("CharacterWorldsService requires CharacterWorldsRepository");
    }
    if (typeof resolveOwnerScope !== "function") {
      throw new TypeError("CharacterWorldsService requires resolveOwnerScope");
    }
    if (!sourceAuthority?.read) {
      throw new TypeError("CharacterWorldsService requires sourceAuthority");
    }
    if (!destinationWriter?.write || !destinationWriter?.release) {
      throw new TypeError("CharacterWorldsService requires destinationWriter");
    }
    if (typeof now !== "function") throw new TypeError("now must be a function");

    this.messageStore = messageStore;
    this.repository = resolvedRepository;
    this.resolveOwnerScope = resolveOwnerScope;
    this.now = now;
    this.sourceAuthority = sourceAuthority;
    this.destinationWriter = destinationWriter;
    this.ownsDestinationWriter = ownsDestinationWriter === true;
    this.workerPool = workerPool || new CharacterImportWorkerPool();
    this.ownsWorkerPool = !workerPool;
    this.previewTtlMs = Math.max(1, Math.min(
      Number.isSafeInteger(previewTtlMs) ? previewTtlMs : DEFAULT_PREVIEW_TTL_MS,
      MAX_PREVIEW_TTL_MS,
    ));
    this.maxPreviews = Math.max(1, Math.min(
      Math.floor(Number(maxPreviews) || DEFAULT_MAX_PREVIEWS),
      DEFAULT_MAX_PREVIEWS,
    ));
    this.maxPreviewBytes = Math.max(1, Math.min(
      Math.floor(Number(maxPreviewBytes) || MAX_PREVIEW_CACHE_BYTES),
      MAX_PREVIEW_CACHE_BYTES,
    ));
    this.previews = new Map();
    this.previewBytes = 0;
    this.closed = false;
    this.closeComplete = false;
    this.lifecycleEpoch = 0;
    this.operations = new Set();
    this.closePromise = null;
  }

  _time() {
    const value = Number(this.now());
    return Number.isFinite(value) ? Math.trunc(value) : Date.now();
  }

  _assertOpen() {
    if (this.closed) {
      throw importError("IMPORT_SERVICE_CLOSED", "Character import service is closed");
    }
  }

  _admit(signal) {
    this._assertOpen();
    const controller = new AbortController();
    const operation = {
      epoch: this.lifecycleEpoch,
      controller,
      signal: controller.signal,
      externalSignal: signal || null,
      externalAbort: null,
      settled: null,
      finish: null,
    };
    operation.settled = new Promise((resolve) => { operation.finish = resolve; });
    if (signal) {
      operation.externalAbort = () => {
        const reason = signal.reason?.code
          ? signal.reason
          : importError("IMPORT_PARSE_CANCELLED", "Character import was cancelled");
        controller.abort(reason);
      };
      if (signal.aborted) operation.externalAbort();
      else signal.addEventListener("abort", operation.externalAbort, { once: true });
    }
    this.operations.add(operation);
    return operation;
  }

  _finishOperation(operation) {
    if (operation.externalSignal && operation.externalAbort) {
      operation.externalSignal.removeEventListener("abort", operation.externalAbort);
    }
    this.operations.delete(operation);
    operation.finish();
  }

  _assertOperation(operation) {
    if (this.closed || operation.epoch !== this.lifecycleEpoch) {
      throw importError("IMPORT_SERVICE_CLOSED", "Character import service is closed");
    }
    if (operation.signal.aborted) {
      const reason = operation.signal.reason;
      if (reason && typeof reason.code === "string") throw reason;
      throw importError("IMPORT_PARSE_CANCELLED", "Character import was cancelled");
    }
  }

  async _runOperation(signal, callback) {
    const operation = this._admit(signal);
    try {
      return await callback(operation);
    } catch (error) {
      if (error?.code === "EXPORT_COMMIT_OUTCOME_UNKNOWN") throw error;
      if (this.closed || operation.epoch !== this.lifecycleEpoch) {
        throw importError("IMPORT_SERVICE_CLOSED", "Character import service is closed");
      }
      throw error;
    } finally {
      this._finishOperation(operation);
    }
  }

  _prune(now = this._time()) {
    for (const [token, preview] of this.previews) {
      if (preview.expiresAt <= now && preview.state !== "committing") {
        this._deletePreview(token);
      }
    }
  }

  _deletePreview(token) {
    const preview = this.previews.get(token);
    if (!preview) return false;
    this.previews.delete(token);
    this.previewBytes = Math.max(0, this.previewBytes - preview.cacheBytes);
    return true;
  }

  _makePreviewRoom(cacheBytes) {
    this._prune();
    while (
      this.previews.size >= this.maxPreviews
      || this.previewBytes + cacheBytes > this.maxPreviewBytes
    ) {
      const evictable = [...this.previews].find(([, preview]) => preview.state === "ready");
      if (!evictable) {
        throw importError("IMPORT_PREVIEW_BUSY", "Import preview cache is busy");
      }
      this._deletePreview(evictable[0]);
    }
  }

  async _owner(callerOwner, operation) {
    if (operation) this._assertOperation(operation);
    let owner;
    try {
      owner = await this.resolveOwnerScope();
    } catch {
      throw importError("IMPORT_OWNER_UNAVAILABLE", "Current owner scope is unavailable");
    }
    if (!validOwner(owner)) {
      throw importError("IMPORT_OWNER_UNAVAILABLE", "Current owner scope is unavailable");
    }
    if (callerOwner !== owner) {
      throw importError("IMPORT_OWNER_MISMATCH", "Owner scope changed");
    }
    if (operation) this._assertOperation(operation);
    return owner;
  }

  async previewImport({ ownerScope, sourcePath, signal } = {}) {
    return this._runOperation(signal, async (operation) => {
      const owner = await this._owner(ownerScope, operation);
      this._prune();
      const snapshot = await this.sourceAuthority.read(sourcePath, {
        signal: operation.signal,
      });
      this._assertOperation(operation);
      const parsed = await this.workerPool.parse(snapshot.bytes, {
        signal: operation.signal,
      });
      this._assertOperation(operation);
      if (parsed.ok === false && parsed.kind === "ordinaryAttachment") return parsed;
      await this._owner(ownerScope, operation);
      const duplicates = this.repository.findImportDuplicates(owner, {
        originalHash: snapshot.fingerprint.sha256,
        canonicalHash: contentHash(parsed.canonical),
      });
      this._assertOperation(operation);
      const serialized = v8.serialize(parsed);
      this._makePreviewRoom(serialized.byteLength);
      const cachedParsed = v8.deserialize(serialized);

      let previewToken;
      do {
        previewToken = crypto.randomBytes(32).toString("hex");
      } while (this.previews.has(previewToken));
      const expiresAt = this._time() + this.previewTtlMs;
      this._assertOperation(operation);
      this.previews.set(previewToken, {
        state: "ready",
        owner,
        expiresAt,
        sourcePath: snapshot.fingerprint.canonicalPath,
        fingerprint: snapshot.fingerprint,
        parsed: cachedParsed,
        cacheBytes: serialized.byteLength,
      });
      this.previewBytes += serialized.byteLength;
      return {
        ok: true,
        kind: "characterCard",
        previewToken,
        expiresAt,
        format: cachedParsed.format,
        container: cachedParsed.container || "json",
        canonical: structuredClone(cachedParsed.canonical),
        compatibility: structuredClone(cachedParsed.compatibility),
        characterBook: cachedParsed.characterBook
          ? structuredClone(cachedParsed.characterBook.summary)
          : null,
        duplicates: structuredClone(duplicates),
      };
    });
  }

  _claim(previewToken, owner) {
    if (typeof previewToken !== "string" || !/^[a-f0-9]{64}$/.test(previewToken)) {
      throw importError("IMPORT_PREVIEW_EXPIRED", "Import preview is unavailable");
    }
    const preview = this.previews.get(previewToken);
    if (!preview) {
      throw importError("IMPORT_PREVIEW_EXPIRED", "Import preview is unavailable");
    }
    if (preview.owner !== owner) {
      this._deletePreview(previewToken);
      throw importError("IMPORT_OWNER_MISMATCH", "Owner scope changed");
    }
    if (preview.expiresAt <= this._time()) {
      this._deletePreview(previewToken);
      throw importError("IMPORT_PREVIEW_EXPIRED", "Import preview expired");
    }
    if (preview.state !== "ready") {
      throw importError("IMPORT_PREVIEW_IN_USE", "Import preview is already being committed");
    }
    preview.state = "committing";
    return preview;
  }

  async commitImport({
    ownerScope,
    previewToken,
    duplicateResolution,
    signal,
  } = {}) {
    return this._runOperation(signal, async (operation) => {
      let owner;
      try {
        owner = await this._owner(ownerScope, operation);
      } catch (error) {
        if (typeof previewToken === "string") this._deletePreview(previewToken);
        throw error;
      }
      const preview = this._claim(previewToken, owner);
      let snapshot;
      try {
        snapshot = await this.sourceAuthority.read(preview.sourcePath, {
          signal: operation.signal,
        });
        this._assertOperation(operation);
        if (!fingerprintMatches(snapshot.fingerprint, preview.fingerprint)) {
          throw importError("IMPORT_SOURCE_CHANGED", "Import source changed after preview");
        }
      } catch (error) {
        this._deletePreview(previewToken);
        throw error;
      }
      try {
        await this._owner(ownerScope, operation);
      } catch (error) {
        this._deletePreview(previewToken);
        throw error;
      }

      const parsed = preview.parsed;
      const original = Object.freeze({
        hash: snapshot.fingerprint.sha256,
        bytes: snapshot.bytes.length,
        mime: snapshot.mime,
        purpose: "character-card-original",
      });
      const source = {
        kind: "imported",
        format: parsed.format,
        container: parsed.container || "json",
        original,
        originalCanonicalHash: contentHash(parsed.canonical),
        preserved: parsed.preserved,
        compatibility: structuredClone(parsed.compatibility),
        provenance: {
          schemaVersion: 1,
          importer: "lily_character_card_worker",
          sourceFormat: parsed.format,
          sourceContainer: parsed.container || "json",
          canonicalSchemaVersion: parsed.canonical.schemaVersion,
        },
      };
      let committed;
      try {
        this._assertOperation(operation);
        committed = this.repository.importCharacter({
          ownerScope: owner,
          canonical: parsed.canonical,
          source,
          assets: [{
            purpose: original.purpose,
            mime: original.mime,
            data: snapshot.bytes,
          }],
          characterBook: parsed.characterBook
            ? {
                canonical: parsed.characterBook.canonical,
                source: {
                  kind: "imported",
                  format: parsed.format,
                  container: parsed.container || "json",
                  embedding: "character_book",
                },
              }
            : null,
          duplicateResolution,
          assertCanCommit: () => this._assertOperation(operation),
        });
        if (committed && typeof committed.then === "function") {
          throw importError(
            "IMPORT_REPOSITORY_PROTOCOL",
            "Character repository persistence must be synchronous",
          );
        }
      } catch (error) {
        if (this.closed || operation.epoch !== this.lifecycleEpoch) {
          this._deletePreview(previewToken);
        } else {
          preview.state = "ready";
        }
        throw error;
      }
      this._deletePreview(previewToken);
      return {
        ...committed,
        compatibility: structuredClone(parsed.compatibility),
      };
    });
  }

  async exportCharacter({
    ownerScope,
    revisionId,
    destinationCapability,
    signal,
  } = {}) {
    return this._runOperation(signal, async (operation) => {
      try {
        const owner = await this._owner(ownerScope, operation);
        const revision = this.repository.getRevision(owner, revisionId);
        if (!revision) {
          throw importError("CHARACTER_REVISION_NOT_FOUND", "Character revision was not found");
        }
        const original = readExactOriginal(this.messageStore, revision);
        const output = original
          ? { bytes: original, mode: "original", omittedExecutable: [] }
          : { ...buildCanonicalV3(revision), mode: "canonical_v3" };
        if (output.bytes.length > MAX_CHARACTER_SOURCE_BYTES) {
          throw importError("EXPORT_TOO_LARGE", "Character export exceeds the size limit");
        }
        const lossReport = buildExportLossReport(revision, output);
        await this._owner(ownerScope, operation);
        this._assertOperation(operation);
        const written = await this.destinationWriter.write(
          destinationCapability,
          output.bytes,
          { signal: operation.signal },
        );
        return {
          ok: true,
          mode: output.mode,
          bytes: written.bytes,
          fileName: written.fileName,
          publication: written.publication || "destination_writer",
          atomicVisibility: written.atomicVisibility === true,
          crashRecovery: written.crashRecovery || "destination_writer_defined",
          maintenanceWarnings: [...(written.maintenanceWarnings || [])],
          omittedExecutable: lossReport.omittedExecutable,
          lossReport,
        };
      } finally {
        await this.destinationWriter.release(destinationCapability);
      }
    });
  }

  async close() {
    if (this.closeComplete) return;
    if (this.closePromise) return this.closePromise;
    if (!this.closed) {
      this.closed = true;
      this.lifecycleEpoch += 1;
    }
    const settling = [];
    const closedError = importError(
      "IMPORT_SERVICE_CLOSED",
      "Character import service is closed",
    );
    for (const operation of this.operations) {
      settling.push(operation.settled);
      operation.controller.abort(closedError);
    }
    this.previews.clear();
    this.previewBytes = 0;
    const attempt = (async () => {
      await Promise.allSettled(settling);
      if (this.ownsWorkerPool) await this.workerPool.close();
      if (this.ownsDestinationWriter && typeof this.destinationWriter.close === "function") {
        await this.destinationWriter.close();
      }
      this.closeComplete = true;
    })().finally(() => {
      if (!this.closeComplete) this.closePromise = null;
    });
    this.closePromise = attempt;
    return attempt;
  }
}

module.exports = {
  CharacterDestinationWriter,
  CharacterSourceAuthority,
  CharacterWorldsService,
};
