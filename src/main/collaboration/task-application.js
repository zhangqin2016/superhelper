"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { manifestMap, planTaskApplication } = require("./task-apply-plan");
const fail = (name) => Object.assign(new Error(`COLLAB_TASK_APPLICATION_${name}`), { code: `COLLAB_TASK_APPLICATION_${name}` });
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => hash(JSON.stringify(canonical(value)));
const identity = (stat) => `${stat.dev}:${stat.ino}`;
const within = (a, b) => a === b || b.startsWith(`${a}${path.sep}`);
function statOrNull(file) {
  try { return fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function safeRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw fail("UNSAFE_PATH");
  const resolved = path.resolve(root);
  // Reject aliases through symlinks, including ancestors of the supplied root.
  if (fs.realpathSync(resolved) !== resolved || !fs.lstatSync(resolved).isDirectory()) throw fail("UNSAFE_PATH");
  return resolved;
}
function safePath(root, relative, { createParents = false } = {}) {
  let parent = root;
  const parts = relative.split("/");
  for (let index = 0; index < parts.length; index++) {
    const piece = parts[index];
    const siblings = fs.readdirSync(parent);
    if (siblings.some((name) => name !== piece && name.normalize("NFC").toLowerCase() === piece.toLowerCase())) throw fail("UNSAFE_PATH");
    const target = path.join(parent, piece), stat = statOrNull(target);
    if (stat?.isSymbolicLink() || (stat && !stat.isDirectory() && !stat.isFile())) throw fail("UNSAFE_PATH");
    if (index === parts.length - 1) return { target, stat };
    if (!stat) {
      if (!createParents) return { target: path.join(root, relative), stat: null };
      fs.mkdirSync(target, { mode: 0o700 });
    } else if (!stat.isDirectory()) throw fail("PATH_CONFLICT");
    parent = target;
  }
  throw fail("UNSAFE_PATH");
}
function readFile(root, relative) {
  const { target, stat } = safePath(root, relative);
  if (!stat) return null;
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024) throw fail("UNSAFE_PATH");
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (identity(fs.fstatSync(fd)) !== identity(stat)) throw fail("INPUT_CHANGED");
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
    if (identity(after) !== identity(stat) || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs
      || after.ctimeMs !== stat.ctimeMs || identity(fs.lstatSync(target)) !== identity(stat)) throw fail("INPUT_CHANGED");
    return { bytes, sha256: hash(bytes), sizeBytes: bytes.length, mode: stat.mode & 0o777 };
  } finally { fs.closeSync(fd); }
}
function writeExclusive(file, bytes, mode = 0o600) {
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, mode);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function syncDirectory(directory) {
  let fd;
  try { fd = fs.openSync(directory, fs.constants.O_RDONLY); fs.fsyncSync(fd); } catch (error) {
    // Windows does not expose portable directory fsync. File contents are still fsynced.
    if (process.platform !== "win32" || !["EPERM", "EISDIR", "EINVAL", "ENOTSUP"].includes(error.code)) throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** The caller owns account/task authorization and an encrypted durable journal.
 * Filesystem commits use synchronous, per-file checkpoints. There is deliberately
 * no await between the final hash check and mutation. A hostile concurrent local
 * process is outside this broker's portable Node filesystem threat boundary. */
function createTaskApplication({ journal, journalRoot, assertAuthorized } = {}) {
  if (!journal?.get || !journal?.put || typeof assertAuthorized !== "function") throw fail("CONFIG_INVALID");
  const storage = safeRoot(journalRoot);
  const busy = new Set();
  async function authorize(input) {
    if (typeof input?.applicationId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(input.applicationId)) throw fail("ID_INVALID");
    if (await assertAuthorized(input) === false) throw fail("FORBIDDEN");
  }
  function describe(input) {
    safeRoot(storage);
    const rootPath = safeRoot(input.rootPath), deliveryRoot = safeRoot(input.deliveryRoot);
    if (within(rootPath, storage) || within(storage, rootPath) || within(deliveryRoot, storage)
      || within(storage, deliveryRoot) || within(rootPath, deliveryRoot) || within(deliveryRoot, rootPath)) throw fail("ROOT_OVERLAP");
    const baseManifest = [...manifestMap(input.baseManifest).values()];
    const deliveryManifest = [...manifestMap(input.deliveryManifest).values()];
    const union = new Map([...baseManifest, ...deliveryManifest].map((file) => [file.path, file]));
    if (union.size > 10000 || deliveryManifest.reduce((sum, file) => sum + file.sizeBytes, 0) > 512 * 1024 * 1024) throw fail("LIMIT_EXCEEDED");
    // Validate allowlist and cross-manifest paths before any filesystem reads.
    planTaskApplication({base:baseManifest,current:[],delivery:deliveryManifest,editablePaths:input.editablePaths});
    const current = [];
    for (const file of union.values()) {
      const local = readFile(rootPath, file.path);
      if (local) current.push({path:file.path,sha256:local.sha256,sizeBytes:local.sizeBytes});
    }
    for (const file of deliveryManifest) {
      const delivered = readFile(deliveryRoot, file.path);
      if (!delivered || delivered.sha256 !== file.sha256 || delivered.sizeBytes !== file.sizeBytes) throw fail("DELIVERY_MISMATCH");
    }
    const plan = planTaskApplication({base:baseManifest,current,delivery:deliveryManifest,editablePaths:input.editablePaths});
    const binding = {applicationId:input.applicationId,rootPath,deliveryRoot,baseManifest,deliveryManifest,editablePaths:input.editablePaths};
    return {binding, plan, planHash:digest({...binding,current,plan,rootIdentity:identity(fs.lstatSync(rootPath)),deliveryIdentity:identity(fs.lstatSync(deliveryRoot))})};
  }
  async function preview(input) {
    await authorize(input);
    const {plan,planHash} = describe(input);
    return {ok:true,plan,planHash};
  }
  function checkRoot(record) {
    if (safeRoot(record.binding.rootPath) !== record.binding.rootPath
      || identity(fs.lstatSync(record.binding.rootPath)) !== record.rootIdentity) throw fail("INPUT_CHANGED");
  }
  function mutate(record, operation, bytes, expectedHash, resultHash) {
    checkRoot(record);
    const root = record.binding.rootPath;
    const existing = readFile(root, operation.path);
    if ((existing?.sha256 || null) !== expectedHash) throw fail("INPUT_CHANGED");
    const {target} = safePath(root, operation.path, {createParents:bytes !== null});
    if (bytes === null) {
      if (existing) fs.unlinkSync(target);
    } else {
      // Staged on the target volume so replacement rename is atomic. The
      // journal records the name before creating it for crash inspection.
      const temporary = path.join(path.dirname(target), operation.temporaryName);
      writeExclusive(temporary, bytes, operation.mode || 0o600);
      checkRoot(record);
      const current = readFile(root, operation.path);
      if ((current?.sha256 || null) !== expectedHash) throw fail("INPUT_CHANGED");
      safePath(root, operation.path);
      fs.renameSync(temporary, target);
    }
    syncDirectory(path.dirname(target));
    if ((readFile(root,operation.path)?.sha256 || null) !== resultHash) throw fail("INPUT_CHANGED");
  }
  async function apply(input) {
    await authorize(input);
    if (busy.has(input.applicationId)) throw fail("BUSY");
    busy.add(input.applicationId);
    try {
      const previous = journal.get(input.applicationId);
      if (previous) {
        const binding = {applicationId:input.applicationId,rootPath:path.resolve(input.rootPath),deliveryRoot:path.resolve(input.deliveryRoot),baseManifest:input.baseManifest,deliveryManifest:input.deliveryManifest,editablePaths:input.editablePaths};
        if (digest(binding) !== digest(previous.binding) || input.expectedPlanHash !== previous.planHash) throw fail("ID_REUSED");
        if (previous.state === "applied") return previous.result;
        throw fail("RECOVERY_REQUIRED");
      }
      const description = describe(input);
      if (input.expectedPlanHash !== description.planHash) throw fail("PREVIEW_CHANGED");
      if (description.plan.entries.some((entry) => ["conflict","outside_scope"].includes(entry.status))) throw fail("CONFLICT");
      if (description.plan.entries.some((entry) => entry.status === "confirmation_required") && input.confirmDeletions !== true) throw fail("DELETION_CONFIRMATION_REQUIRED");
      const backupDirectory = path.join(storage, hash(input.applicationId));
      const record = {...description,state:"preparing",rootIdentity:identity(fs.lstatSync(description.binding.rootPath)),backupDirectory,operations:[]};
      journal.put(input.applicationId,record);
      fs.mkdirSync(backupDirectory, {mode:0o700});
      syncDirectory(storage);
      for (const entry of description.plan.entries.filter((entry)=>entry.status!=="already_applied")) {
        const local = readFile(record.binding.rootPath,entry.path);
        const delivered = entry.operation === "delete" ? null : readFile(record.binding.deliveryRoot,entry.path);
        if ((local?.sha256 || null) !== entry.expectedLocalHash || (delivered?.sha256 || null) !== entry.resultHash) throw fail("INPUT_CHANGED");
        const index = record.operations.length;
        const operation = {...entry,mode:local?.mode || 0o600,backupName:`${index}.before`,stagedName:`${index}.after`,temporaryName:`.lily-apply-${crypto.randomUUID()}`,state:"prepared"};
        if (local) writeExclusive(path.join(backupDirectory,operation.backupName),local.bytes);
        if (delivered) writeExclusive(path.join(backupDirectory,operation.stagedName),delivered.bytes);
        record.operations.push(operation);
        journal.put(input.applicationId,record);
      }
      syncDirectory(backupDirectory);
      // Recheck every source before the first mutation, including unchanged files.
      if (describe(input).planHash !== record.planHash) throw fail("PREVIEW_CHANGED");
      record.state = "applying";
      journal.put(input.applicationId,record);
      for (const operation of record.operations) {
        const staged = operation.resultHash ? readFile(backupDirectory,operation.stagedName) : null;
        if ((staged?.sha256 || null) !== operation.resultHash) throw fail("BACKUP_MISMATCH");
        operation.state = "writing";
        journal.put(input.applicationId,record);
        mutate(record,operation,staged?.bytes || null,operation.expectedLocalHash,operation.resultHash);
        operation.state = "done";
        journal.put(input.applicationId,record);
      }
      record.state = "applied";
      record.result = {ok:true,state:"applied",applicationId:input.applicationId,planHash:record.planHash,entries:record.plan.entries};
      journal.put(input.applicationId,record);
      return record.result;
    } finally { busy.delete(input.applicationId); }
  }
  async function recover(input) {
    await authorize(input);
    if (input.mode !== "rollback") throw fail("RECOVERY_MODE_INVALID");
    if (busy.has(input.applicationId)) throw fail("BUSY");
    busy.add(input.applicationId);
    try {
      const record = journal.get(input.applicationId);
      if (!record) throw fail("NOT_FOUND");
      if (record.state === "rolled_back") return {ok:true,state:"rolled_back",applicationId:input.applicationId,conflicts:[]};
      checkRoot(record);
      safeRoot(storage);
      if (record.backupDirectory !== path.join(storage,hash(input.applicationId))) throw fail("UNSAFE_PATH");
      if (statOrNull(record.backupDirectory)) safeRoot(record.backupDirectory);
      else if (record.operations.length) throw fail("BACKUP_MISMATCH");
      const conflicts = [];
      for (const operation of [...record.operations].reverse()) {
        if (["prepared","rolled_back"].includes(operation.state)) continue;
        // A failed rename can leave a fully written temporary sibling. Only
        // remove our exact recorded name while its bytes still match ours.
        const temporaryRelative = path.posix.join(path.posix.dirname(operation.path), operation.temporaryName);
        const temporary = readFile(record.binding.rootPath,temporaryRelative);
        if (temporary) {
          const expected = operation.state === "rolling_back" ? operation.expectedLocalHash : operation.resultHash;
          if (temporary.sha256 !== expected) { conflicts.push(operation.path); continue; }
          fs.unlinkSync(safePath(record.binding.rootPath,temporaryRelative).target);
          syncDirectory(path.dirname(path.join(record.binding.rootPath,temporaryRelative)));
        }
        const local = readFile(record.binding.rootPath,operation.path);
        const localHash = local?.sha256 || null;
        if (localHash === operation.expectedLocalHash) { operation.state = "rolled_back"; journal.put(input.applicationId,record); continue; }
        if (localHash !== operation.resultHash) { conflicts.push(operation.path); continue; }
        const before = operation.expectedLocalHash ? readFile(record.backupDirectory,operation.backupName) : null;
        if ((before?.sha256 || null) !== operation.expectedLocalHash) throw fail("BACKUP_MISMATCH");
        operation.state = "rolling_back";
        operation.temporaryName = `.lily-rollback-${crypto.randomUUID()}`;
        journal.put(input.applicationId,record);
        mutate(record,operation,before?.bytes || null,operation.resultHash,operation.expectedLocalHash);
        operation.state = "rolled_back";
        journal.put(input.applicationId,record);
      }
      record.state = conflicts.length ? "recovery_conflict" : "rolled_back";
      journal.put(input.applicationId,record);
      return {ok:conflicts.length===0,state:record.state,applicationId:input.applicationId,conflicts};
    } finally { busy.delete(input.applicationId); }
  }
  return {preview,apply,recover};
}
module.exports = { createTaskApplication };
