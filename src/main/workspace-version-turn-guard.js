"use strict";

function rejectIfWorkspaceVersionBusy(service, workspacePath) {
  return workspacePath && service?.isMutating?.(workspacePath)
    ? { ok: false, error: "WORKSPACE_VERSION_BUSY" }
    : null;
}

async function captureWorkspaceVersionBaseline(service, workspacePath, log) {
  if (!workspacePath || !service?.captureBaseline) return null;
  try {
    return await service.captureBaseline(workspacePath);
  } catch (error) {
    log.warn("workspace version baseline failed: %s", error?.message || error);
    return null;
  }
}

module.exports = { rejectIfWorkspaceVersionBusy, captureWorkspaceVersionBaseline };
