"use strict";
const {randomUUID} = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
function resolveRemoteTaskBinding(projectManager,sessionManager,{projectId,sessionId,bindingId,title}) {
  const missing = () => { throw Object.assign(new Error("Local workspace unavailable"),{code:"COLLAB_TASK_LOCAL_MISSING"}); };
  const project = projectManager.find(projectId);
  if (!project || !path.isAbsolute(project.path || "")) return missing();
  let rootPath;
  try { rootPath=fs.realpathSync(project.path); if (!fs.statSync(rootPath).isDirectory()) return missing(); }
  catch { return missing(); }
  // Existing sessions can be running: binding must never mutate runtime state,
  // switch the active project, or change the session's engine directory.
  const selected = sessionId ? sessionManager._find(sessionId) : null;
  if (sessionId && (!selected || selected.projectId !== projectId)) return missing();
  const session = selected || createRemoteTaskSession(sessionManager,projectId,title,bindingId);
  return {projectId,sessionId:session.id,rootPath};
}
/** Register an idle task workspace; execution still requires an explicit prompt. */
function createRemoteTaskSession(manager,projectId,title,bindingId) {
  const existing = manager.sessions[projectId]?.find(item=>item.remoteTaskBinding === bindingId);
  if (existing) return existing;
  const now = new Date().toISOString();
  const session = {id:randomUUID(),projectId,title:(title || "Remote task").slice(0,80),createdAt:now,updatedAt:now,
    status:"idle",messages:[],messageCount:0,remoteTaskBinding:bindingId};
  (manager.sessions[projectId] ||= []).push(session);
  manager.saveImmediate();
  return session;
}
function registerRemoteTaskWorkspace(projectManager,sessionManager,{rootPath,title,bindingId}) {
  const previousProjectId=projectManager.activeProjectId;
  const existing=projectManager.hasPath(rootPath);
  const project=projectManager.add(rootPath);
  if (!existing && typeof title === "string" && title.trim()) projectManager.rename(project.id,title.trim());
  if (previousProjectId) projectManager.switchTo(previousProjectId);
  const session=createRemoteTaskSession(sessionManager,project.id,title,bindingId);
  return {projectId:project.id,sessionId:session.id};
}
function focusRegisteredSession(manager,win,sessionId) {
  if (typeof sessionId !== "string" || sessionId.length > 200 || !manager._find(sessionId) || !win || win.isDestroyed()) return {ok:false};
  const session=manager._find(sessionId);
  if (win.isMinimized()) win.restore();
  win.show();win.focus();
  win.webContents.send("assistant:focus-session",{sessionId,projectId:session.projectId});
  return {ok:true};
}
module.exports = {createRemoteTaskSession,registerRemoteTaskWorkspace,focusRegisteredSession,resolveRemoteTaskBinding};
