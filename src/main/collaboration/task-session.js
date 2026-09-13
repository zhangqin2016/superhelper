"use strict";
const {randomUUID} = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
function listRemoteTaskBindingTargets(projectManager,sessionManager) {
  return (projectManager.projects || []).slice(0,100).map(project=>({id:project.id,name:project.name,
    sessions:(sessionManager.sessions[project.id] || []).filter(s=>!s.remoteTaskExecution && !s.archived).slice(0,100).map(s=>({id:s.id,title:s.title})),
  }));
}
function resolveRemoteTaskBinding(projectManager,sessionManager,{projectId,sessionId,bindingId,title,rootPath:selectedRoot}) {
  const missing = () => { throw Object.assign(new Error("Local workspace unavailable"),{code:"COLLAB_TASK_LOCAL_MISSING"}); };
  if (!projectId) {
    if (!selectedRoot || sessionId) return missing();
    try { if (fs.realpathSync(selectedRoot)!==selectedRoot || !fs.statSync(selectedRoot).isDirectory()) return missing(); } catch { return missing(); }
    const previous=projectManager.activeProjectId;
    projectId=projectManager.add(selectedRoot).id;
    if (previous) projectManager.switchTo(previous);
  }
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
function createRemoteTaskSession(manager,projectId,title,bindingId,executionRoot) {
  const execution = executionRoot ? require("../session-workspace").captureExecutionWorkspace(executionRoot) : null;
  const existing = manager.sessions[projectId]?.find(item=>item.remoteTaskBinding === bindingId);
  if (existing) {
    if (execution && JSON.stringify(existing.remoteTaskExecution)!==JSON.stringify(execution))
      throw Object.assign(new Error("Task execution directory changed"),{code:"COLLAB_TASK_BINDING_CONFLICT"});
    return existing;
  }
  const now = new Date().toISOString();
  const session = {id:randomUUID(),projectId,title:(title || "Remote task").slice(0,80),createdAt:now,updatedAt:now,
    status:"idle",messages:[],messageCount:0,remoteTaskBinding:bindingId,
    ...(execution ? {remoteTaskExecution:execution} : {})};
  (manager.sessions[projectId] ||= []).push(session);
  manager.saveImmediate();
  return session;
}
function registerRemoteTaskWorkspace(projectManager,sessionManager,{rootPath,title,bindingId,projectId}) {
  if (projectId) {
    if (!projectManager.find(projectId)) throw Object.assign(new Error("Workspace missing"),{code:"COLLAB_TASK_LOCAL_MISSING"});
    const session=createRemoteTaskSession(sessionManager,projectId,title,bindingId,rootPath);
    return {projectId,sessionId:session.id};
  }
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
module.exports = {createRemoteTaskSession,registerRemoteTaskWorkspace,focusRegisteredSession,resolveRemoteTaskBinding,listRemoteTaskBindingTargets};
