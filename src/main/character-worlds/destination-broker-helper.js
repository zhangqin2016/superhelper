"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const {
  MAX_CHARACTER_SOURCE_BYTES,
} = require("./constants");
const {
  BROKER_PROTOCOL_VERSION,
} = require("./destination-broker-protocol");

const AUTH = process.env.LILY_DESTINATION_BROKER_AUTH || "";
const MAX_RESERVATIONS = 64;
const MAX_FILE_NAME_BYTES = 255;
const MAX_MESSAGE_KEYS = 6;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const reservations = new Map();
const requestReservations = new Map();
const testReserveDelayMs = Math.max(0, Math.min(
  Number(process.env.LILY_DESTINATION_BROKER_TEST_RESERVE_DELAY_MS) || 0,
  1000,
));
const testCommitDelayMs = Math.max(0, Math.min(
  Number(process.env.LILY_DESTINATION_BROKER_TEST_COMMIT_DELAY_MS) || 0,
  1000,
));
const testCommitNeverRespond = (
  process.env.LILY_DESTINATION_BROKER_TEST_COMMIT_NEVER_RESPOND === "1"
);
let closing = false;

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function identity(stat) {
  return {
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: String(stat.mode),
  };
}

function sameObject(left, right) {
  return left.device === right.device
    && left.inode === right.inode
    && left.mode === right.mode;
}

function validFileName(fileName) {
  return typeof fileName === "string"
    && fileName.length > 0
    && Buffer.byteLength(fileName, "utf8") <= MAX_FILE_NAME_BYTES
    && fileName !== "."
    && fileName !== ".."
    && !fileName.startsWith(".")
    && !/[\/\\:\u0000-\u001f\u007f]/.test(fileName)
    && !/[ .]$/.test(fileName)
    && !WINDOWS_RESERVED_NAME.test(fileName);
}

function assertMessage(message) {
  if (
    !message
    || typeof message !== "object"
    || Array.isArray(message)
    || Object.keys(message).length > MAX_MESSAGE_KEYS
    || message.auth !== AUTH
    || typeof message.id !== "string"
    || message.id.length < 1
    || message.id.length > 96
    || typeof message.type !== "string"
    || message.type.length > 32
  ) {
    throw codedError("EXPORT_BROKER_PROTOCOL", "Invalid broker request");
  }
}

function assertReservationId(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw codedError("EXPORT_BROKER_PROTOCOL", "Invalid reservation handle");
  }
}

function targetExistsCode(fileName) {
  try {
    return fs.lstatSync(fileName).isSymbolicLink()
      ? "EXPORT_DESTINATION_SYMLINK"
      : "EXPORT_DESTINATION_EXISTS";
  } catch {
    return "EXPORT_DESTINATION_EXISTS";
  }
}

function basenameIdentity(entry) {
  let current;
  try {
    current = identity(fs.lstatSync(entry.fileName, { bigint: true }));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  return current;
}

function assertBasenameIdentity(entry) {
  const current = basenameIdentity(entry);
  if (!current || !sameObject(current, entry.identity)) {
    throw codedError(
      "EXPORT_RESERVATION_CHANGED",
      "Export reservation identity changed",
    );
  }
}

function closeDescriptor(entry) {
  if (!Number.isInteger(entry.fd)) return;
  fs.closeSync(entry.fd);
  entry.fd = null;
}

function forgetReservationRequest(reservationId) {
  for (const [requestId, current] of requestReservations) {
    if (current === reservationId) requestReservations.delete(requestId);
  }
}

function reserve(payload) {
  if (closing || reservations.size >= MAX_RESERVATIONS) {
    throw codedError("EXPORT_DESTINATION_BUSY", "Destination broker is busy");
  }
  const fileName = payload?.fileName;
  if (!validFileName(fileName)) {
    throw codedError("EXPORT_DESTINATION_INVALID", "Export destination is invalid");
  }
  const reservationId = crypto.randomBytes(32).toString("hex");
  const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW)
    ? fs.constants.O_NOFOLLOW
    : 0;
  let fd;
  try {
    fd = fs.openSync(
      fileName,
      fs.constants.O_RDWR
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | noFollow,
      0o600,
    );
    const entry = {
      fd,
      fileName,
      identity: identity(fs.fstatSync(fd, { bigint: true })),
      committed: false,
      written: false,
      bytes: 0,
    };
    reservations.set(reservationId, entry);
    return { reservationId, fileName };
  } catch (error) {
    if (Number.isInteger(fd)) {
      try {
        fs.closeSync(fd);
      } catch {
        // The descriptor did not escape this helper.
      }
    }
    if (error?.code === "EEXIST") {
      throw codedError(
        targetExistsCode(fileName),
        "Export destination already exists",
      );
    }
    if (error?.code === "ELOOP") {
      throw codedError(
        "EXPORT_DESTINATION_SYMLINK",
        "Symbolic-link export destinations are not allowed",
      );
    }
    throw codedError("EXPORT_DESTINATION_UNAUTHORIZED", "Export destination is not authorized");
  }
}

function getEntry(payload) {
  assertReservationId(payload?.reservationId);
  const entry = reservations.get(payload.reservationId);
  if (!entry) {
    throw codedError("EXPORT_DESTINATION_INVALID", "Export reservation is invalid");
  }
  return entry;
}

function write(payload) {
  const entry = getEntry(payload);
  const bytes = Buffer.isBuffer(payload.bytes)
    ? payload.bytes
    : payload.bytes instanceof Uint8Array
      ? Buffer.from(payload.bytes)
      : null;
  if (!bytes || bytes.length > MAX_CHARACTER_SOURCE_BYTES) {
    throw codedError("EXPORT_TOO_LARGE", "Character export exceeds the size limit");
  }
  if (entry.committed || !Number.isInteger(entry.fd)) {
    throw codedError("EXPORT_DESTINATION_INVALID", "Export reservation is invalid");
  }
  fs.ftruncateSync(entry.fd, 0);
  let offset = 0;
  while (offset < bytes.length) {
    const length = Math.min(64 * 1024, bytes.length - offset);
    const written = fs.writeSync(entry.fd, bytes, offset, length, offset);
    if (written <= 0) {
      throw codedError("EXPORT_WRITE_FAILED", "Character export could not be written");
    }
    offset += written;
  }
  fs.ftruncateSync(entry.fd, bytes.length);
  fs.fsyncSync(entry.fd);
  entry.written = true;
  entry.bytes = bytes.length;
  return { bytes: bytes.length };
}

function commit(payload) {
  const entry = getEntry(payload);
  if (!entry.written || entry.committed) {
    throw codedError("EXPORT_DESTINATION_INVALID", "Export reservation is invalid");
  }
  const current = identity(fs.fstatSync(entry.fd, { bigint: true }));
  if (!sameObject(current, entry.identity)) {
    throw codedError("EXPORT_RESERVATION_CHANGED", "Export reservation identity changed");
  }
  assertBasenameIdentity(entry);
  fs.fsyncSync(entry.fd);
  assertBasenameIdentity(entry);
  closeDescriptor(entry);
  assertBasenameIdentity(entry);

  // The final create-only file is visible from reserve onward. Commit only
  // verifies and closes that same inode; a crash can leave a zero/partial file.
  entry.committed = true;
  reservations.delete(payload.reservationId);
  forgetReservationRequest(payload.reservationId);
  return {
    bytes: entry.bytes,
    fileName: entry.fileName,
    publication: "bound_directory_direct_reservation",
    atomicVisibility: false,
    crashRecovery: "create_only_partial_file_may_remain",
    reservationReleased: true,
    maintenanceWarnings: [],
  };
}

function release(payload) {
  const entry = getEntry(payload);
  closeDescriptor(entry);
  const current = basenameIdentity(entry);
  if (!current || !sameObject(current, entry.identity)) {
    reservations.delete(payload.reservationId);
    forgetReservationRequest(payload.reservationId);
    return { released: true, replacementPreserved: current !== null };
  }
  try {
    fs.unlinkSync(entry.fileName);
  } catch (error) {
    if (error?.code === "ENOENT") {
      reservations.delete(payload.reservationId);
      forgetReservationRequest(payload.reservationId);
      return { released: true, replacementPreserved: false };
    }
    throw codedError(
      "EXPORT_RELEASE_FAILED",
      "Export reservation could not be released",
    );
  }
  reservations.delete(payload.reservationId);
  forgetReservationRequest(payload.reservationId);
  return { released: true };
}

function cancelRequest(payload) {
  const requestId = payload?.requestId;
  if (
    typeof requestId !== "string"
    || requestId.length < 1
    || requestId.length > 96
  ) {
    throw codedError("EXPORT_BROKER_PROTOCOL", "Invalid broker request");
  }
  const reservationId = requestReservations.get(requestId);
  if (!reservationId) return { cancelled: false };
  release({ reservationId });
  return { cancelled: true };
}

function closeAll() {
  closing = true;
  const failures = [];
  for (const [reservationId] of [...reservations]) {
    try {
      release({ reservationId });
    } catch (error) {
      failures.push(error?.code || "EXPORT_RELEASE_FAILED");
    }
  }
  if (failures.length > 0) {
    throw codedError("EXPORT_CLOSE_FAILED", "Destination broker cleanup failed");
  }
  return { closed: true };
}

function handle(type, payload) {
  switch (type) {
    case "reserve": return reserve(payload);
    case "write": return write(payload);
    case "commit": return commit(payload);
    case "release": return release(payload);
    case "cancelRequest": return cancelRequest(payload);
    case "close": return closeAll();
    default:
      throw codedError("EXPORT_BROKER_PROTOCOL", "Unknown broker request");
  }
}

async function respond(message) {
  try {
    assertMessage(message);
    if (message.type === "reserve" && testReserveDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, testReserveDelayMs));
    }
    if (message.type === "commit" && testCommitDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, testCommitDelayMs));
    }
    if (message.type === "commit" && testCommitNeverRespond) {
      await new Promise(() => {});
    }
    const result = handle(message.type, message.payload);
    if (message.type === "reserve") {
      requestReservations.set(message.id, result.reservationId);
    }
    process.send?.({ auth: AUTH, id: message.id, ok: true, result }, () => {
      if (message.type === "close") process.exit(0);
    });
  } catch (error) {
    process.send?.({
      auth: AUTH,
      id: typeof message?.id === "string" ? message.id.slice(0, 96) : "",
      ok: false,
      error: {
        code: typeof error?.code === "string" ? error.code : "EXPORT_BROKER_FAILURE",
        message: "Destination broker operation failed",
      },
    });
  }
}

function emergencyCleanup() {
  for (const entry of reservations.values()) {
    try {
      closeDescriptor(entry);
      const current = basenameIdentity(entry);
      if (current && sameObject(current, entry.identity)) fs.unlinkSync(entry.fileName);
    } catch {
      // The parent receives a fail-loud process exit; this is last-resort cleanup.
    }
  }
}

if (!AUTH || AUTH.length < 64 || typeof process.send !== "function") {
  process.exit(70);
}

process.on("message", (message) => {
  void respond(message);
});
process.on("disconnect", () => {
  emergencyCleanup();
  process.exit(0);
});
process.on("SIGTERM", () => {
  emergencyCleanup();
  process.exit(0);
});

const cwdStat = fs.statSync(".", { bigint: true });
process.send({
  auth: AUTH,
  kind: "hello",
  version: BROKER_PROTOCOL_VERSION,
  identity: identity(cwdStat),
});
