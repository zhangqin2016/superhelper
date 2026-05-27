/**
 * Diff viewer panel — displays file changes from Claude CLI.
 */

import store from "./state.js";
import { $ } from "./dom.js";

export function renderDiffView() {
  const list = $("diffList");
  if (!list) return;

  const diffs = store.get("diffs") || [];
  list.textContent = "";

  for (const d of diffs) {
    const file = document.createElement("div");
    file.className = "diff-file";

    const header = document.createElement("div");
    header.className = "diff-file-header";

    const name = document.createElement("span");
    name.className = "diff-file-name";
    name.textContent = d.file;
    header.appendChild(name);

    const status = document.createElement("span");
    status.className = `diff-file-status ${d.status}`;
    status.textContent = d.status === "added" ? "新增" : d.status === "deleted" ? "删除" : "修改";
    header.appendChild(status);

    const actions = document.createElement("div");
    actions.className = "diff-file-actions";
    const acceptBtn = document.createElement("button");
    acceptBtn.className = "diff-accept-btn";
    acceptBtn.textContent = "保存";
    acceptBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      window.assistantClient.acceptDiff([d.file]);
      removeDiffFile(d.file);
    });
    const rejectBtn = document.createElement("button");
    rejectBtn.className = "diff-reject-btn";
    rejectBtn.textContent = "撤销";
    rejectBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      window.assistantClient.rejectDiff([d.file]);
      removeDiffFile(d.file);
    });
    actions.append(acceptBtn, rejectBtn);
    header.appendChild(actions);

    header.addEventListener("click", () => {
      const content = file.querySelector(".diff-file-content");
      if (content) content.hidden = !content.hidden;
    });

    file.appendChild(header);

    const content = document.createElement("div");
    content.className = "diff-file-content";
    content.textContent = d.hunks;
    file.appendChild(content);

    list.appendChild(file);
  }

  updateChangesSummary();
}

function removeDiffFile(filePath) {
  const diffs = (store.get("diffs") || []).filter((d) => d.file !== filePath);
  store.set("diffs", diffs);
  if (diffs.length === 0) {
    const panel = $("diffPanel");
    if (panel) panel.hidden = true;
  }
  renderDiffView();
}

function updateChangesSummary() {
  const summary = $("changesSummary");
  if (!summary) return;

  const diffs = store.get("diffs") || [];
  if (diffs.length === 0) {
    summary.innerHTML = '<div class="changes-empty">暂无变更</div>';
    return;
  }

  let added = 0, deleted = 0;
  for (const d of diffs) {
    const lines = d.hunks.split("\n");
    for (const line of lines) {
      if (line.startsWith("+") && !line.startsWith("+++")) added++;
      else if (line.startsWith("-") && !line.startsWith("---")) deleted++;
    }
  }

  summary.innerHTML = `
    <div class="change-stat">
      <span class="added">+${added}</span>
      <span class="deleted">-${deleted}</span>
      <span>${diffs.length} 个文件</span>
    </div>
    ${diffs.map((d) => `<div class="change-item">${d.status === "added" ? "+" : d.status === "deleted" ? "-" : "~"} ${d.file}</div>`).join("")}
  `;
}

// Wire accept/reject all buttons
export function initDiffButtons() {
  $("diffAcceptAllBtn")?.addEventListener("click", async () => {
    const diffs = store.get("diffs") || [];
    const paths = diffs.map((d) => d.file);
    await window.assistantClient.acceptDiff(paths);
    store.set("diffs", []);
    const panel = $("diffPanel");
    if (panel) panel.hidden = true;
    updateChangesSummary();
  });

  $("diffRejectAllBtn")?.addEventListener("click", async () => {
    const diffs = store.get("diffs") || [];
    const paths = diffs.map((d) => d.file);
    await window.assistantClient.rejectDiff(paths);
    store.set("diffs", []);
    const panel = $("diffPanel");
    if (panel) panel.hidden = true;
    updateChangesSummary();
  });
}
