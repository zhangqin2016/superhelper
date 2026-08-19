import { t } from "../i18n/index.js";
import { confirmDialog } from "./confirm-dialog.js";
import { showToast } from "./toast.js";

let activeDialog = null;

function formatTime(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return "";
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return new Date(value).toLocaleString();
  }
}

function createButton(label, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `workspace-version-button ${className}`.trim();
  button.textContent = label;
  return button;
}

export async function showWorkspaceVersionDialog(project) {
  if (!project?.id || !window.assistantClient?.getProjectVersionStatus) return;
  activeDialog?.remove();

  const overlay = document.createElement("section");
  overlay.className = "modal-panel workspace-version-panel";
  overlay.dataset.projectId = project.id;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.innerHTML = `
    <div class="modal-card workspace-version-card">
      <header class="modal-header workspace-version-header">
        <div>
          <h2 class="workspace-version-title"></h2>
          <p class="workspace-version-subtitle"></p>
        </div>
        <button type="button" class="modal-close-btn workspace-version-close" aria-label=""></button>
      </header>
      <div class="workspace-version-body">
        <section class="workspace-version-summary" aria-live="polite">
          <div class="workspace-version-summary-main">
            <span class="workspace-version-status-dot"></span>
            <div>
              <strong class="workspace-version-status-title"></strong>
              <p class="workspace-version-status-detail"></p>
            </div>
          </div>
          <div class="workspace-version-summary-count"></div>
        </section>
        <p class="workspace-version-guide"></p>
        <section class="workspace-version-warning" hidden></section>
        <section class="workspace-version-history-section">
          <div class="workspace-version-section-heading">
            <h3></h3>
            <button type="button" class="workspace-version-refresh" aria-label=""></button>
          </div>
          <div class="workspace-version-history" aria-live="polite"></div>
        </section>
      </div>
      <footer class="workspace-version-footer">
        <button type="button" class="workspace-version-button workspace-version-save"></button>
        <button type="button" class="workspace-version-button workspace-version-done"></button>
      </footer>
    </div>
  `;
  document.body.appendChild(overlay);
  activeDialog = overlay;

  const title = overlay.querySelector(".workspace-version-title");
  const subtitle = overlay.querySelector(".workspace-version-subtitle");
  const close = overlay.querySelector(".workspace-version-close");
  const refresh = overlay.querySelector(".workspace-version-refresh");
  const save = overlay.querySelector(".workspace-version-save");
  const done = overlay.querySelector(".workspace-version-done");
  const statusTitle = overlay.querySelector(".workspace-version-status-title");
  const statusDetail = overlay.querySelector(".workspace-version-status-detail");
  const statusDot = overlay.querySelector(".workspace-version-status-dot");
  const summaryCount = overlay.querySelector(".workspace-version-summary-count");
  const warning = overlay.querySelector(".workspace-version-warning");
  const history = overlay.querySelector(".workspace-version-history");

  title.textContent = t("workspaceVersion.title");
  subtitle.textContent = project.name;
  close.textContent = "×";
  close.title = t("common.close");
  refresh.textContent = "↻";
  refresh.title = t("workspaceVersion.refresh");
  refresh.setAttribute("aria-label", t("workspaceVersion.refresh"));
  overlay.querySelector(".workspace-version-section-heading h3").textContent = t("workspaceVersion.history");
  save.textContent = t("workspaceVersion.save");
  done.textContent = t("common.close");
  overlay.querySelector(".workspace-version-guide").textContent = t("workspaceVersion.guide");

  const finish = () => {
    overlay.remove();
    if (activeDialog === overlay) activeDialog = null;
    document.removeEventListener("keydown", onKeyDown);
  };
  const onKeyDown = (event) => {
    if (event.key === "Escape") finish();
  };
  close.addEventListener("click", finish);
  done.addEventListener("click", finish);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) finish();
  });
  document.addEventListener("keydown", onKeyDown);

  async function load() {
    history.textContent = t("workspaceVersion.loading");
    refresh.disabled = true;
    try {
      const [statusResult, historyResult] = await Promise.all([
        window.assistantClient.getProjectVersionStatus(project.id),
        window.assistantClient.getProjectVersionHistory(project.id),
      ]);
      if (!statusResult?.ok || !historyResult?.ok) throw new Error("VERSION_CONTROL_FAILED");
      statusTitle.textContent = statusResult.hasVersion
        ? t("workspaceVersion.protected")
        : t("workspaceVersion.ready");
      statusDetail.textContent = statusResult.latest
        ? t("workspaceVersion.latest", { time: formatTime(statusResult.latest.timestamp) })
        : t("workspaceVersion.noVersion");
      statusDot.classList.toggle("is-local", statusResult.mode !== "git");
      summaryCount.textContent = t("workspaceVersion.fileCount", { count: statusResult.protectedFileCount || 0 });
      warning.hidden = !(statusResult.unprotectedCount > 0);
      if (!warning.hidden) {
        const paths = (statusResult.unprotectedFiles || []).slice(0, 3).map((entry) => entry.path).join("、");
        warning.textContent = t("workspaceVersion.unprotected", {
          count: statusResult.unprotectedCount,
          paths: paths || t("workspaceVersion.moreFiles"),
        });
      }
      renderHistory(history, historyResult.versions || [], load, project.id);
    } catch {
      statusTitle.textContent = t("workspaceVersion.unavailable");
      statusDetail.textContent = t("workspaceVersion.tryAgain");
      summaryCount.textContent = "";
      warning.hidden = true;
      history.textContent = t("workspaceVersion.loadFailed");
    } finally {
      refresh.disabled = false;
    }
  }

  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      const result = await window.assistantClient.saveProjectVersion(project.id);
      if (!result?.ok) {
        showToast(result.error === "WORKSPACE_BUSY" || result.error === "WORKSPACE_VERSION_BUSY"
          ? t("workspaceVersion.busy")
          : t("workspaceVersion.saveFailed"), "error");
        return;
      }
      showToast(t("workspaceVersion.saved"), "success");
      window.dispatchEvent(new CustomEvent("workspace-version-changed", { detail: { projectId: project.id } }));
      await load();
    } catch {
      showToast(t("workspaceVersion.saveFailed"), "error");
    } finally {
      save.disabled = false;
    }
  });
  refresh.addEventListener("click", load);
  await load();
  requestAnimationFrame(() => close.focus());
}

function renderHistory(container, versions, reload, projectId) {
  container.textContent = "";
  if (versions.length === 0) {
    container.textContent = t("workspaceVersion.historyEmpty");
    return;
  }
  for (const version of versions) {
    const row = document.createElement("div");
    row.className = "workspace-version-row";
    const info = document.createElement("div");
    info.className = "workspace-version-row-info";
    const heading = document.createElement("strong");
    heading.textContent = t("workspaceVersion.version");
    const meta = document.createElement("span");
    meta.textContent = `${formatTime(version.timestamp)} · ${String(version.id || "").slice(0, 8)}`;
    const subject = document.createElement("p");
    subject.textContent = version.subject || t("workspaceVersion.snapshot");
    info.append(heading, meta, subject);
    const restore = createButton(t("workspaceVersion.restore"), "workspace-version-restore");
    restore.addEventListener("click", async () => {
      let preview = null;
      if (typeof window.assistantClient.getProjectVersionPreview === "function") {
        preview = await window.assistantClient.getProjectVersionPreview(projectId, version.id);
        if (!preview?.ok) {
          showToast(preview?.error === "WORKSPACE_BUSY" || preview?.error === "WORKSPACE_VERSION_BUSY"
            ? t("workspaceVersion.busy")
            : t("workspaceVersion.restoreFailed"), "error");
          return;
        }
      }
      const counts = preview?.counts || { added: 0, modified: 0, deleted: 0 };
      const impact = t("workspaceVersion.restoreImpact", counts);
      const truncated = preview?.truncated ? `\n${t("workspaceVersion.restoreImpactTruncated")}` : "";
      const confirmed = await confirmDialog({
        title: t("workspaceVersion.restoreTitle"),
        message: `${t("workspaceVersion.restoreMessage", { time: formatTime(version.timestamp) })}\n\n${impact}${truncated}`,
        confirmText: t("workspaceVersion.restore"),
        cancelText: t("prompt.cancel"),
        danger: true,
      });
      if (!confirmed) return;
      restore.disabled = true;
      try {
        const result = await window.assistantClient.restoreProjectVersion(projectId, version.id);
        if (!result?.ok) {
          showToast(result.error === "WORKSPACE_BUSY" || result.error === "WORKSPACE_VERSION_BUSY"
            ? t("workspaceVersion.busy")
            : result.error === "VERSION_RESTORE_ROLLBACK_FAILED"
              ? t("workspaceVersion.restoreRecoveryFailed")
              : t("workspaceVersion.restoreFailed"), "error");
          return;
        }
        showToast(t("workspaceVersion.restored"), "success");
        window.dispatchEvent(new CustomEvent("workspace-version-changed", { detail: { projectId } }));
        await reload();
      } catch {
        showToast(t("workspaceVersion.restoreFailed"), "error");
      } finally {
        restore.disabled = false;
      }
    });
    row.append(info, restore);
    container.appendChild(row);
  }
}
