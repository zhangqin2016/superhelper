"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { MAX_CHARACTER_SOURCE_BYTES } = require("./constants");
const {
  assertNotAborted,
  canonicalRoots,
  identity,
  importError,
  sameFilesystemObject,
  sameIdentity,
} = require("./file-authority-shared");

function fingerprintMatches(left, right) {
  return Boolean(left && right)
    && left.authorizedRoot === right.authorizedRoot
    && left.canonicalPath === right.canonicalPath
    && left.sha256 === right.sha256
    && sameIdentity(left.identity, right.identity);
}

function mimeFor(bytes) {
  const png = bytes.length >= 8
    && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return png ? "image/png" : "application/json";
}

const TRANSIENT_CLOSE_CODES = new Set(["EAGAIN", "EBUSY", "EINTR"]);
const MAX_CLOSE_ATTEMPTS = 3;

async function closeSourceHandle(handle) {
  let lastError;
  for (let attempt = 0; attempt < MAX_CLOSE_ATTEMPTS; attempt += 1) {
    try {
      await handle.close();
      return null;
    } catch (error) {
      lastError = error;
      if (!TRANSIENT_CLOSE_CODES.has(error?.code)) break;
    }
  }
  return importError(
    "IMPORT_SOURCE_CLOSE_FAILED",
    "Import source could not be closed",
    { cause: lastError },
  );
}

function attachCleanupError(primaryError, cleanupError) {
  const summary = Object.freeze({
    code: cleanupError.code,
    message: cleanupError.message,
  });
  if (primaryError && typeof primaryError === "object") {
    try {
      primaryError.cleanupError = summary;
      return primaryError;
    } catch {
      // Fall through to a stable wrapper when the primary error is immutable.
    }
  }
  return Object.assign(new Error("Import source read and cleanup failed"), {
    code: primaryError?.code || "IMPORT_SOURCE_UNAVAILABLE",
    cause: primaryError,
    cleanupError: summary,
  });
}

class CharacterSourceAuthority {
  constructor({
    roots,
    maxBytes = MAX_CHARACTER_SOURCE_BYTES,
    fileSystem = fs,
  } = {}) {
    if (
      !fileSystem
      || typeof fileSystem.lstatSync !== "function"
      || typeof fileSystem.promises?.open !== "function"
    ) {
      throw new TypeError("CharacterSourceAuthority requires a filesystem adapter");
    }
    this.fileSystem = fileSystem;
    this.roots = canonicalRoots(roots);
    this.rootAliases = new Set([
      ...this.roots.map((root) => root.canonicalPath),
      ...roots.map((root) => path.resolve(String(root))),
    ]);
    this.maxBytes = Math.max(0, Math.min(
      Number.isSafeInteger(maxBytes) ? maxBytes : MAX_CHARACTER_SOURCE_BYTES,
      MAX_CHARACTER_SOURCE_BYTES,
    ));
  }

  _rootChanged() {
    return importError(
      "IMPORT_SOURCE_ROOT_CHANGED",
      "Import source authorization root changed",
    );
  }

  _assertRootSync(root) {
    let current;
    try {
      current = this.fileSystem.lstatSync(root.canonicalPath, { bigint: true });
    } catch {
      throw this._rootChanged();
    }
    if (
      current.isSymbolicLink()
      || !current.isDirectory()
      || !sameFilesystemObject(root.identity, identity(current))
    ) {
      throw this._rootChanged();
    }
  }

  async _assertRoot(root) {
    let current;
    try {
      current = await this.fileSystem.promises.lstat(root.canonicalPath, { bigint: true });
    } catch {
      throw this._rootChanged();
    }
    if (
      current.isSymbolicLink()
      || !current.isDirectory()
      || !sameFilesystemObject(root.identity, identity(current))
    ) {
      throw this._rootChanged();
    }
  }

  _directoryWithinRootSync(root, directory) {
    let current = path.resolve(directory);
    for (let depth = 0; depth < 256; depth += 1) {
      let stat;
      try {
        stat = this.fileSystem.lstatSync(current, { bigint: true });
      } catch {
        return false;
      }
      if (
        stat.isDirectory()
        && sameFilesystemObject(root.identity, identity(stat))
      ) {
        return true;
      }
      const parent = path.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
    return false;
  }

  _resolve(sourcePath) {
    if (typeof sourcePath !== "string" || !sourcePath) {
      throw importError("IMPORT_SOURCE_UNAUTHORIZED", "Import source is not authorized");
    }
    if (this.rootAliases.has(path.resolve(sourcePath))) {
      throw importError("IMPORT_SOURCE_NOT_FILE", "Import source must be a regular file");
    }
    for (const root of this.roots) {
      this._assertRootSync(root);
      const requested = path.isAbsolute(sourcePath)
        ? path.resolve(sourcePath)
        : path.resolve(root.canonicalPath, sourcePath);
      let realParent;
      try {
        realParent = this.fileSystem.realpathSync(path.dirname(requested));
      } catch {
        continue;
      }
      const candidate = path.join(realParent, path.basename(requested));
      this._assertRootSync(root);
      if (this._directoryWithinRootSync(root, realParent)) {
        return { authorizedRoot: root, candidate };
      }
    }
    throw importError("IMPORT_SOURCE_UNAUTHORIZED", "Import source is not authorized");
  }

  async read(sourcePath, { signal } = {}) {
    assertNotAborted(signal, "IMPORT_PARSE_CANCELLED", "Character import was cancelled");
    const { authorizedRoot, candidate } = this._resolve(sourcePath);
    await this._assertRoot(authorizedRoot);
    let before;
    try {
      before = await this.fileSystem.promises.lstat(candidate, { bigint: true });
    } catch {
      throw importError("IMPORT_SOURCE_UNAVAILABLE", "Import source is unavailable");
    }
    if (before.isSymbolicLink()) {
      throw importError("IMPORT_SOURCE_SYMLINK", "Symbolic-link import sources are not allowed");
    }
    if (!before.isFile()) {
      throw importError("IMPORT_SOURCE_NOT_FILE", "Import source must be a regular file");
    }
    if (before.size > BigInt(this.maxBytes)) {
      throw importError("IMPORT_SOURCE_TOO_LARGE", "Import source exceeds the size limit");
    }

    let canonicalPath;
    try {
      canonicalPath = await this.fileSystem.promises.realpath(candidate);
    } catch {
      throw importError("IMPORT_SOURCE_UNAVAILABLE", "Import source is unavailable");
    }
    if (!this._directoryWithinRootSync(
      authorizedRoot,
      path.dirname(canonicalPath),
    )) {
      throw importError("IMPORT_SOURCE_UNAUTHORIZED", "Import source is not authorized");
    }
    await this._assertRoot(authorizedRoot);

    const constants = this.fileSystem.constants || fs.constants;
    const noFollow = Number.isInteger(constants.O_NOFOLLOW)
      ? constants.O_NOFOLLOW
      : 0;
    let handle;
    try {
      handle = await this.fileSystem.promises.open(
        canonicalPath,
        constants.O_RDONLY | noFollow,
      );
    } catch (error) {
      if (error?.code === "ELOOP") {
        throw importError("IMPORT_SOURCE_SYMLINK", "Symbolic-link import sources are not allowed");
      }
      throw importError("IMPORT_SOURCE_UNAVAILABLE", "Import source is unavailable");
    }

    let result;
    let primaryError;
    try {
      assertNotAborted(signal, "IMPORT_PARSE_CANCELLED", "Character import was cancelled");
      await this._assertRoot(authorizedRoot);
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile()) {
        throw importError("IMPORT_SOURCE_NOT_FILE", "Import source must be a regular file");
      }
      const beforeIdentity = identity(before);
      const openedIdentity = identity(opened);
      if (!sameIdentity(beforeIdentity, openedIdentity)) {
        throw importError("IMPORT_SOURCE_CHANGED", "Import source changed during admission");
      }
      if (opened.size > BigInt(this.maxBytes)) {
        throw importError("IMPORT_SOURCE_TOO_LARGE", "Import source exceeds the size limit");
      }

      const length = Number(opened.size);
      const bytes = Buffer.allocUnsafe(length);
      const digest = crypto.createHash("sha256");
      let offset = 0;
      while (offset < length) {
        assertNotAborted(signal, "IMPORT_PARSE_CANCELLED", "Character import was cancelled");
        const requested = Math.min(64 * 1024, length - offset);
        const result = await handle.read(bytes, offset, requested, offset);
        if (result.bytesRead === 0) {
          throw importError("IMPORT_SOURCE_CHANGED", "Import source changed during read");
        }
        digest.update(bytes.subarray(offset, offset + result.bytesRead));
        offset += result.bytesRead;
      }
      assertNotAborted(signal, "IMPORT_PARSE_CANCELLED", "Character import was cancelled");
      const afterIdentity = identity(await handle.stat({ bigint: true }));
      if (!sameIdentity(openedIdentity, afterIdentity)) {
        throw importError("IMPORT_SOURCE_CHANGED", "Import source changed during read");
      }
      await this._assertRoot(authorizedRoot);
      result = {
        bytes,
        mime: mimeFor(bytes),
        fingerprint: Object.freeze({
          authorizedRoot: authorizedRoot.canonicalPath,
          canonicalPath,
          identity: afterIdentity,
          sha256: digest.digest("hex"),
        }),
      };
    } catch (error) {
      primaryError = error;
    }
    const cleanupError = await closeSourceHandle(handle);
    if (primaryError) {
      throw cleanupError
        ? attachCleanupError(primaryError, cleanupError)
        : primaryError;
    }
    if (cleanupError) throw cleanupError;
    return result;
  }
}

module.exports = {
  CharacterSourceAuthority,
  fingerprintMatches,
  importError,
};
