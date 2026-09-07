"use strict";
const {randomUUID} = require("node:crypto");
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
function focusRegisteredSession(manager,win,sessionId) {
  if (typeof sessionId !== "string" || sessionId.length > 200 || !manager._find(sessionId) || !win || win.isDestroyed()) return {ok:false};
  const session=manager._find(sessionId);
  if (win.isMinimized()) win.restore();
  win.show();win.focus();
  win.webContents.send("assistant:focus-session",{sessionId,projectId:session.projectId});
  return {ok:true};
}
module.exports = {createRemoteTaskSession,focusRegisteredSession};
