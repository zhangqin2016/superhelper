import { registerWorkspaceCollaborationController } from "./workspace-collaboration-entry.js";
import { initRemoteTasks } from "./collaboration-remote-tasks.js";

export function initCenterRemoteTasks({ workspace, ...options }) {
  const tasks = initRemoteTasks(options);
  const focusTask = () => { const surface = options.root?.querySelector('.remote-tasks:not([hidden])'); (surface?.querySelector('[name="assigneeUserId"]') || surface)?.focus({ preventScroll: true }); };
  const connection = connectWorkspaceCollaboration({ ...workspace, refreshPolicy: options.refreshContext, focusTask, tasks });
  return { ...tasks, invalidateService() { connection.invalidate(); tasks.invalidate(); }, destroy() { connection.destroy(); tasks.destroy(); } };
}

/** Keeps the workspace chooser independent of center DOM/navigation details. */
export function connectWorkspaceCollaboration({ getContext, getPolicy, refreshPolicy, focusTask, activate, load, open, tasks }) {
  const api = () => window.assistantClient?.collaboration;
  const stamp = () => { const context = getContext(); return { ...context, api: api() }; };
  const current = captured => { const value = stamp(); return !value.disposed && value.api === captured.api && value.view === captured.view && value.navigation === captured.navigation && (!captured.userId || !value.userId || value.userId === captured.userId); };
  async function read() {
    const captured = stamp();
    const [policy, directory, list, account] = await Promise.all([Promise.resolve(getPolicy()).catch(() => null), Promise.resolve(api()?.getDirectory?.()).catch(() => null), Promise.resolve(api()?.list?.()).catch(() => null), Promise.resolve(window.assistantClient?.getAccountStatus?.()).catch(() => null)]);
    if (!current(captured)) return { ok: false, reason: "changed" };
    if (window.assistantClient?.getAccountStatus && account?.loggedIn !== true) return { ok: false, reason: account ? "login" : "unavailable" };
    if (account?.user?.id && directory?.profile?.userId && account.user.id !== directory.profile.userId) return { ok: false, reason: "changed" };
    if (!directory?.profile?.userId) return { ok: false, reason: directory?.ok === true || /LOGIN|ACCOUNT|AUTH/.test(directory?.code || "") ? "login" : "unavailable" };
    if (policy?.collaboration?.enabled !== true || policy.collaboration.tasks !== true) return { ok: false, reason: "disabled" };
    if (!directory.ok || !list?.ok || !api()?.taskWorkflow) return { ok: false, reason: "unavailable" };
    return { ok: true, directory, conversations: list.conversations || [], captured: { ...captured, userId: directory.profile.userId } };
  }
  return registerWorkspaceCollaborationController({ read, async continue({ snapshot, target, projectId, isCurrent }) {
    const valid = () => isCurrent() && current(snapshot.captured);
    if (!valid()) return { reason: "changed" };
    await refreshPolicy?.();
    if (!valid()) return { reason: "changed" };
    const fresh = await read();
    if (!valid()) return { reason: "changed" };
    if (!fresh.ok || fresh.directory.profile.userId !== snapshot.directory.profile.userId) return { reason: fresh.reason || "changed" };
    let conversationId = target.conversationId;
    if (conversationId && !fresh.conversations.some(row => row.id === conversationId)) return { reason: "changed" };
    if (!conversationId) {
      const person = target.organizationId ? fresh.directory.teams?.find(team => team.id === target.organizationId)?.members?.find(member => member.userId === target.userId)
        : fresh.directory.contacts?.find(member => member.userId === target.userId && member.relationship === "friend" && !member.ownBlocked);
      if (!person) return { reason: "changed" };
      let result;
      if (!target.organizationId) {
        // Friendship acceptance provisions the canonical direct conversation.
        // The existing conversation-create API does not admit personal directs.
        result = await api().openFriend(target.userId);
        if (!valid()) return { reason: "changed" };
        if (!result?.ok || !result.conversationId) return { reason: "unavailable" };
      } else result = await api().conversation({ action: "create", scopeType: "organization", organizationId: target.organizationId, kind: "direct", memberUserIds: [target.userId], clientCommandId: target.clientCommandId });
      if (!valid()) return { reason: "changed" };
      if (result?.state === "failed") return { reason: "rejected", terminal: true };
      if (!result?.ok || !result.conversationId || ["confirming", "queued", "submitting"].includes(result.state)) return { reason: "confirming" };
      conversationId = result.conversationId;
    }
    await load();
    if (!valid()) return { reason: "changed" };
    activate();
    const opening = open(conversationId), own = stamp();
    await opening;
    if (!isCurrent() || !current(own) || getContext().conversationId !== conversationId) return { reason: "changed" };
    await tasks.create({ projectId, isCurrent: () => isCurrent() && current(own), ...(target.userId ? { assigneeUserId: target.userId } : {}) });
    return { ok: true, focus: () => { if (current(own)) focusTask?.(); } };
  } });
}
