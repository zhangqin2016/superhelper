/**
 * Diff panel — shows file changes at the bottom of the center panel.
 */
import { $ } from "./dom.js";
import store from "./state.js";
import { t } from "../i18n/index.js";
import { getTurnId } from "./session-runtime-store.js";

/** sessionId -> turnId -> Map<filePath, entry> */
const sessionDiffs = new Map();
/** sessionId -> Map<filePath, turnId> */
const fileTurnIndex = new Map();

function isBypassMode() {
  const select = document.getElementById("permissionModeSelect");
  return select?.value === "full";
}

function isActiveSession(sessionId) {
  return store.get("activeSessionId") === sessionId;
}

function ensureTurnMap(sessionId, turnId) {
  if (!sessionDiffs.has(sessionId)) {
    sessionDiffs.set(sessionId, new Map());
  }
  const sessionTurns = sessionDiffs.get(sessionId);
  const key = turnId || "_orphan";
  if (!sessionTurns.has(key)) {
    sessionTurns.set(key, new Map());
  }
  return sessionTurns.get(key);
}

function rememberFileTurn(sessionId, turnId, filePath) {
  if (!fileTurnIndex.has(sessionId)) {
    fileTurnIndex.set(sessionId, new Map());
  }
  fileTurnIndex.get(sessionId).set(filePath, turnId || "_orphan");
}

function forgetFileTurn(sessionId, filePath) {
  fileTurnIndex.get(sessionId)?.delete(filePath);
}

export function addDiffEntry(sessionId, entry) {
  const turnId = entry.turnId || "_orphan";
  const fileMap = ensureTurnMap(sessionId, turnId);
  fileMap.set(entry.filePath, entry);
  rememberFileTurn(sessionId, turnId, entry.filePath);
  renderInlineDiffForFile(sessionId, entry.filePath, entry);

  if (isBypassMode()) {
    acceptFileChange(sessionId, entry.filePath);
    return;
  }

  if (isActiveSession(sessionId)) {
    renderDiffPanel(sessionId);
    showDiffPanel();
  }
}

export function getSessionDiffEntries(sessionId, turnId = null) {
  const sessionTurns = sessionDiffs.get(sessionId);
  if (!sessionTurns) return [];
  if (turnId) {
    const turnMap = sessionTurns.get(turnId);
    return turnMap ? [...turnMap.values()] : [];
  }
  const all = [];
  for (const turnMap of sessionTurns.values()) {
    all.push(...turnMap.values());
  }
  return all;
}

export function getActiveTurnDiffEntries(sessionId) {
  const liveTurnId = getTurnId(sessionId);
  if (liveTurnId) return getSessionDiffEntries(sessionId, liveTurnId);
  return getSessionDiffEntries(sessionId);
}

export function reapplySessionInlineDiffs(sessionId, turnId = null) {
  const entries = turnId
    ? getSessionDiffEntries(sessionId, turnId)
    : getActiveTurnDiffEntries(sessionId);
  for (const entry of entries) {
    renderInlineDiffForFile(sessionId, entry.filePath, entry);
  }
}

function renderInlineDiffForFile(sessionId, filePath, entry) {
  const panel = document.querySelector(
    `.session-messages[data-session-id="${sessionId}"]`,
  );
  if (!panel) return;

  const turnId = entry.turnId;
  const turnScope = turnId
    ? `.assistant-turn-article[data-turn-id="${CSS.escape(turnId)}"] `
    : "";
  const toolRow = panel.querySelector(
    `${turnScope}.assistant-tool-row[data-tool-file-path="${CSS.escape(filePath)}"]`,
  );
  if (!toolRow) return;

  const existing = toolRow.querySelector(".assistant-tool-diff");
  if (existing) existing.remove();

  const diffDiv = document.createElement("div");
  diffDiv.className = "assistant-tool-diff";

  if (entry.diff && entry.diff.length > 0) {
    const lines = entry.diff.slice(0, 40);
    for (const hunk of lines) {
      const line = document.createElement("div");
      line.className = `diff-hunk-${hunk.type}`;
      line.textContent = (hunk.type === "add" ? "+" : hunk.type === "del" ? "-" : " ") + hunk.content;
      diffDiv.appendChild(line);
    }
    if (entry.diff.length > 40) {
      const more = document.createElement("div");
      more.className = "assistant-tool-diff-more";
      more.textContent = t("diff.viewMore");
      diffDiv.appendChild(more);
    }
  } else {
    diffDiv.textContent = entry.fileName;
  }

  toolRow.appendChild(diffDiv);
}

export function clearDiffEntries(sessionId) {
  if (!sessionId) return;
  sessionDiffs.delete(sessionId);
  fileTurnIndex.delete(sessionId);
  renderDiffPanel(sessionId);
  hideDiffPanel();
}

function showDiffPanel() {
  const sid = store.get("activeSessionId");
  const entries = sid ? getActiveTurnDiffEntries(sid) : [];
  if (entries.length > 0) {
    const panel = $("diffPanel");
    if (panel) panel.hidden = false;
  }
}

function hideDiffPanel() {
  const sid = store.get("activeSessionId");
  const entries = sid ? getActiveTurnDiffEntries(sid) : [];
  if (!entries.length) {
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
  const entries = getActiveTurnDiffEntries(sid);
  if (!entries.length) {
    hideDiffPanel();
    return;
  }

  for (const entry of entries) {
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

function removeLocalDiff(sessionId, filePath) {
  const turnId = fileTurnIndex.get(sessionId)?.get(filePath);
  if (!turnId) return false;
  const turnMap = sessionDiffs.get(sessionId)?.get(turnId);
  if (!turnMap) return false;
  const removed = turnMap.delete(filePath);
  forgetFileTurn(sessionId, filePath);
  if (turnMap.size === 0) {
    sessionDiffs.get(sessionId)?.delete(turnId);
  }
  return removed;
}

async function acceptFileChange(sessionId, filePath) {
  if (!removeLocalDiff(sessionId, filePath)) return;
  await window.assistantClient.acceptChange(sessionId, filePath);
  renderDiffPanel(sessionId);
}

async function rejectFileChange(sessionId, filePath) {
  const turnId = fileTurnIndex.get(sessionId)?.get(filePath);
  const entry = turnId
    ? sessionDiffs.get(sessionId)?.get(turnId)?.get(filePath)
    : null;
  if (!entry) return;
  // Added files have no original content — rejecting them deletes the file.
  await window.assistantClient.rejectChange(sessionId, filePath, entry.originalContent, entry.status);
  removeLocalDiff(sessionId, filePath);
  renderDiffPanel(sessionId);
}

async function acceptAllChanges(sessionId) {
  const paths = getActiveTurnDiffEntries(sessionId).map((e) => e.filePath);
  for (const fp of paths) {
    await acceptFileChange(sessionId, fp);
  }
}

async function rejectAllChanges(sessionId) {
  const entries = [...getActiveTurnDiffEntries(sessionId)];
  for (const entry of entries) {
    if (entry.originalContent != null) {
      await window.assistantClient.rejectChange(sessionId, entry.filePath, entry.originalContent);
    }
    removeLocalDiff(sessionId, entry.filePath);
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

  store.on("activeSessionId", (newId) => {
    if (newId) {
      renderDiffPanel(newId);
      const bypass = isBypassMode();
      const acceptAll = $("diffAcceptAllBtn");
      const rejectAll = $("diffRejectAllBtn");
      if (acceptAll) acceptAll.hidden = bypass;
      if (rejectAll) rejectAll.hidden = bypass;
    } else {
      hideDiffPanel();
    }
  });

  if (isBypassMode()) {
    const acceptAll = $("diffAcceptAllBtn");
    const rejectAll = $("diffRejectAllBtn");
    if (acceptAll) acceptAll.hidden = true;
    if (rejectAll) rejectAll.hidden = true;
  }
}
