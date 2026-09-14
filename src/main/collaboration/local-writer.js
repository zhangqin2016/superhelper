"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const fail = name => Object.assign(new Error(`COLLAB_TASK_APPLICATION_${name}`), {code:`COLLAB_TASK_APPLICATION_${name}`});

// One permanent coordination file per OS user, independent of account, edition
// and Electron userData overrides. Never unlink it: replacing a locked inode
// would let a second process acquire a different lock. No task metadata is stored.
function createLocalWriter({filePath} = {}) {
  const target = filePath || path.join(fs.realpathSync(os.homedir()), ".lily-workbench-coordination", "writer.sqlite");
  if (!path.isAbsolute(target)) throw fail("UNSAFE_PATH");
  function run(operation) {
    if (typeof operation !== "function" || operation.constructor.name === "AsyncFunction") throw fail("SYNC_REQUIRED");
    const directory = path.dirname(target);
    fs.mkdirSync(directory, {recursive:true,mode:0o700});
    if (fs.realpathSync(directory) !== directory) throw fail("UNSAFE_PATH");
    const fd = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) throw fail("UNSAFE_PATH");
    } finally { fs.closeSync(fd); }
    const {DatabaseSync} = require("node:sqlite");
    const db = new DatabaseSync(target);
    let locked = false;
    try {
      // The kernel retains this write lock even if the process stalls. Crashes
      // release it; wall-clock time and lease renewal cannot grant a rival writer.
      db.exec("PRAGMA busy_timeout = 0");
      try { db.exec("BEGIN IMMEDIATE"); locked = true; } catch (error) {
        if ([5,6].includes(error.errcode)) throw fail("BUSY");
        throw error;
      }
      const result = operation();
      if (result && typeof result.then === "function") throw fail("SYNC_REQUIRED");
      return result;
    } finally {
      try { if (locked) db.exec("ROLLBACK"); } finally { db.close(); }
    }
  }
  return {run};
}
module.exports = {createLocalWriter};
