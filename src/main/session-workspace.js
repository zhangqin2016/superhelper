"use strict";
const fs = require("node:fs");
const path = require("node:path");

function captureExecutionWorkspace(rootPath) {
  if (typeof rootPath !== "string" || !path.isAbsolute(rootPath) || fs.realpathSync(rootPath) !== rootPath)
    throw new Error("Invalid task execution directory");
  const stat=fs.lstatSync(rootPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid task execution directory");
  return {rootPath,device:String(stat.dev),inode:String(stat.ino)};
}

/** Main-only session metadata. An invalid isolated root must never fall back
 * to the private top-level project. This selects cwd; it is not an OS sandbox. */
function resolveSessionWorkspace(projectManager,session) {
  const project=session ? projectManager?.find?.(session.projectId) : null;
  if (!project || !session.remoteTaskExecution) return project || null;
  if (!session.remoteTaskBinding) return null;
  try {
    const current=captureExecutionWorkspace(session.remoteTaskExecution.rootPath);
    if (current.device!==session.remoteTaskExecution.device || current.inode!==session.remoteTaskExecution.inode) return null;
    return {...project,path:current.rootPath};
  } catch { return null; }
}
module.exports={captureExecutionWorkspace,resolveSessionWorkspace};
