/**
 * Diff panel — shows file changes at the bottom of the center panel.
 */
import { $ } from "./dom.js";
import store from "./state.js";
import { t } from "../i18n/index.js";

const sessionDiffs = new Map(); // sessionId -> Map<filePath, entry>

function isBypassMode() {
  const select = document.getElementById("permissionModeSelect");
  return select?.value === "bypassPermissions";
}

function isActiveSession(sessionId) {
  return store.get("activeSessionId") === sessionId;
}

export function addDiffEntry(sessionId, entry) {
  if (!sessionDiffs.has(sessionId)) {
    sessionDiffs.set(sessionId, new Map());
  }
  const fileMap = sessionDiffs.get(sessionId);
  fileMap.set(entry.filePath, entry);
  renderInlineDiffForFile(sessionId, entry.filePath, entry);

  // In bypass mode, auto-accept immediately — no panel flash needed
  if (isBypassMode()) {
    acceptFileChange(sessionId, entry.filePath);
    return;
  }

  // Only show diff panel for the active session
  if (isActiveSession(sessionId)) {
    renderDiffPanel(sessionId);
    showDiffPanel();
  }
}

function renderInlineDiffForFile(sessionId, filePath, entry) {
  // Find the matching Write/Edit tool card in DOM
  const panel = document.querySelector(
    `.session-messages[data-session-id="${sessionId}"]`
  );
  if (!panel) return;
  const card = panel.querySelector(`.tool-card[data-tool-file-path="${CSS.escape(filePath)}"]`);
  if (!card) return;

  // Remove existing inline diff
  const existing = card.querySelector(".tool-card-diff");
  if (existing) existing.remove();

  const diffDiv = document.createElement("div");
  diffDiv.className = "tool-card-diff";

  if (entry.diff && entry.diff.length > 0) {
    const lines = entry.diff.slice(0, 40); // inline: limit to first 40 hunks
    for (const hunk of lines) {
      const line = document.createElement("div");
      line.className = `diff-hunk-${hunk.type}`;
      line.textContent = (hunk.type === "add" ? "+" : hunk.type === "del" ? "-" : " ") + hunk.content;
      diffDiv.appendChild(line);
    }
    if (entry.diff.length > 40) {
      const more = document.createElement("div");
      more.className = "tool-card-result-toggle";
      more.textContent = "... 查看更多";
      more.style.cssText = "color: var(--text-dim); font-size: 11px; cursor: pointer;";
      diffDiv.appendChild(more);
    }
  } else {
    diffDiv.textContent = entry.fileName;
  }

  card.appendChild(diffDiv);
}

export function clearDiffEntries(sessionId) {
  if (!sessionId || !sessionDiffs.has(sessionId)) return;
  sessionDiffs.delete(sessionId);
  renderDiffPanel(sessionId);
  hideDiffPanel();
}

function showDiffPanel() {
  const sid = store.get("activeSessionId");
  const fileMap = sid ? sessionDiffs.get(sid) : null;
  if (fileMap && fileMap.size > 0) {
    const panel = $("diffPanel");
    if (panel) panel.hidden = false;
  }
}

function hideDiffPanel() {
  const sid = store.get("activeSessionId");
  const fileMap = sid ? sessionDiffs.get(sid) : null;
  if (!fileMap || fileMap.size === 0) {
    const panel = $("diffPanel");
    if (panel) panel.hidden = true;
  }
}

function renderDiffPanel(sessionId) {
  const sid = sessionId || store.get("activeSessionId");
  if (!sid) return;
  const listEl = $("diffList");
  if (!listEl) return;

  listEl.textContent = "";
  const fileMap = sessionDiffs.get(sid);
  if (!fileMap || fileMap.size === 0) {
    hideDiffPanel();
    return;
  }

  for (const [filePath, entry] of fileMap) {
    listEl.appendChild(renderDiffFileCard(sid, entry));
  }
}

function renderDiffFileCard(sessionId, entry) {
  const card = document.createElement("div");
  card.className = "diff-file";
  card.dataset.filePath = entry.filePath;

  const header = document.createElement("div");
  header.className = "diff-file-header";

  const nameSpan = document.createElement("span");
  nameSpan.className = "diff-file-name";
  nameSpan.textContent = entry.fileName;
  nameSpan.title = entry.filePath;

  const statusSpan = document.createElement("span");
  statusSpan.className = `diff-file-status ${entry.status}`;
  statusSpan.textContent = entry.status === "added"
    ? t("diff.fileAdded")
    : t("diff.fileModified");

  const fileActions = document.createElement("div");
  fileActions.className = "diff-file-actions";

  if (!isBypassMode()) {
    const acceptBtn = document.createElement("button");
    acceptBtn.className = "diff-accept-btn";
    acceptBtn.textContent = t("diff.accept");
    acceptBtn.addEventListener("click", () => acceptFileChange(sessionId, entry.filePath));

    const rejectBtn = document.createElement("button");
    rejectBtn.className = "diff-reject-btn";
    rejectBtn.textContent = t("diff.reject");
    rejectBtn.addEventListener("click", () => rejectFileChange(sessionId, entry.filePath));

    fileActions.append(acceptBtn, rejectBtn);
  }
  header.append(nameSpan, statusSpan, fileActions);
  card.appendChild(header);

  const content = document.createElement("div");
  content.className = "diff-file-content";

  if (entry.diff && entry.diff.length > 0) {
    for (const hunk of entry.diff) {
      const line = document.createElement("div");
      line.className = `diff-hunk-${hunk.type}`;
      const prefix = hunk.type === "add" ? "+" : hunk.type === "del" ? "-" : " ";
      line.textContent = `${prefix}${hunk.content}`;
      content.appendChild(line);
    }
  } else {
    content.textContent = t("diff.noChanges");
  }

  card.appendChild(content);
  return card;
}

async function acceptFileChange(sessionId, filePath) {
  const fileMap = sessionDiffs.get(sessionId);
  if (!fileMap) return;
  await window.assistantClient.acceptChange(sessionId, filePath);
  fileMap.delete(filePath);
  // Always render for active session to avoid cross-session DOM contamination
  renderDiffPanel();
}

async function rejectFileChange(sessionId, filePath) {
  const fileMap = sessionDiffs.get(sessionId);
  if (!fileMap) return;
  const entry = fileMap.get(filePath);
  if (!entry) return;
  if (entry.originalContent != null) {
    await window.assistantClient.rejectChange(sessionId, filePath, entry.originalContent);
  }
  fileMap.delete(filePath);
  renderDiffPanel();
}

async function acceptAllChanges(sessionId) {
  const fileMap = sessionDiffs.get(sessionId);
  if (!fileMap) return;
  const paths = [...fileMap.keys()];
  for (const fp of paths) {
    await acceptFileChange(sessionId, fp);
  }
}

async function rejectAllChanges(sessionId) {
  const fileMap = sessionDiffs.get(sessionId);
  if (!fileMap) return;
  const entries = [...fileMap.values()];
  for (const entry of entries) {
    if (entry.originalContent != null) {
      await window.assistantClient.rejectChange(sessionId, entry.filePath, entry.originalContent);
    }
    fileMap.delete(entry.filePath);
  }
  renderDiffPanel(sessionId);
}

function toggleDiffCollapse() {
  const panel = $("diffPanel");
  const btn = $("diffToggleBtn");
  if (!panel) return;
  const collapsed = panel.dataset.collapsed === "1";
  panel.dataset.collapsed = collapsed ? "0" : "1";
  if (!collapsed) {
    panel.style.maxHeight = "40px";
    panel.style.overflow = "hidden";
    if (btn) btn.textContent = t("diff.expand");
  } else {
    panel.style.maxHeight = "";
    panel.style.overflow = "";
    if (btn) btn.textContent = t("diff.collapse");
  }
}

export function initDiffPanel() {
  $("diffAcceptAllBtn")?.addEventListener("click", () => {
    const sid = store.get("activeSessionId");
    if (sid) acceptAllChanges(sid);
  });
  $("diffRejectAllBtn")?.addEventListener("click", () => {
    const sid = store.get("activeSessionId");
    if (sid) rejectAllChanges(sid);
  });
  $("diffToggleBtn")?.addEventListener("click", toggleDiffCollapse);

  // Re-render diff panel on session switch
  store.on("activeSessionId", (newId) => {
    if (newId) {
      renderDiffPanel(newId);
      // Refresh bypass-mode button visibility
      const bypass = isBypassMode();
      const acceptAll = $("diffAcceptAllBtn");
      const rejectAll = $("diffRejectAllBtn");
      if (acceptAll) acceptAll.hidden = bypass;
      if (rejectAll) rejectAll.hidden = bypass;
    } else {
      hideDiffPanel();
    }
  });

  // Initial bypass check
  if (isBypassMode()) {
    const acceptAll = $("diffAcceptAllBtn");
    const rejectAll = $("diffRejectAllBtn");
    if (acceptAll) acceptAll.hidden = true;
    if (rejectAll) rejectAll.hidden = true;
  }
}
