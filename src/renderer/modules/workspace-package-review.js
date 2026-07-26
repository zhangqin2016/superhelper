import { t } from "../i18n/index.js";

export function reviewWorkspacePackage(inspection, { allowAttach = true } = {}) {
  return new Promise((resolve) => {
    const tasks = Array.isArray(inspection?.automationTemplates)
      ? inspection.automationTemplates
      : [];
    const overlay = document.createElement("section");
    overlay.className = "modal-panel workspace-export-panel";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");

    const card = document.createElement("div");
    card.className = "modal-card workspace-export-card";
    const header = document.createElement("header");
    header.className = "modal-header";
    const heading = document.createElement("div");
    const title = document.createElement("h2");
    title.textContent = t("pack.importReviewTitle", {
      name: inspection?.name || t("pack.importUnnamed"),
    });
    const intro = document.createElement("p");
    intro.textContent = inspection?.kind === "lily-workspace-app"
      ? t("pack.importAppIntro")
      : t("pack.importWorkspaceIntro");
    heading.append(title, intro);
    header.appendChild(heading);
    card.appendChild(header);

    const body = document.createElement("div");
    body.className = "workspace-export-body";
    if (inspection?.riskWarnings?.includes("UNSIGNED_LOCAL_APP")) {
      const warning = document.createElement("div");
      warning.className = "workspace-export-warning";
      warning.textContent = t("pack.importUnsignedWarning");
      body.appendChild(warning);
    }
    const dependencyCount =
      (inspection?.requiredSkills?.length || 0) +
      (inspection?.requiredRuntimePacks?.length || 0);
    if (dependencyCount) {
      const dependencies = document.createElement("p");
      dependencies.className = "workspace-export-note";
      dependencies.textContent = t("pack.importDependencies", { count: dependencyCount });
      body.appendChild(dependencies);
    }

    const taskSection = document.createElement("section");
    taskSection.className = "workspace-export-skills";
    const taskTitle = document.createElement("h3");
    taskTitle.textContent = t("pack.importTasksTitle");
    const taskIntro = document.createElement("p");
    taskIntro.textContent = tasks.length
      ? t("pack.importTasksIntro")
      : t("pack.noScheduledTasks");
    taskSection.append(taskTitle, taskIntro);
    const taskInputs = [];
    tasks.forEach((task, index) => {
      const row = document.createElement("label");
      row.className = "workspace-export-include";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = false;
      checkbox.value = String(index);
      const text = document.createElement("span");
      text.textContent = task.scheduleText
        ? `${task.title} · ${task.scheduleText}`
        : task.title;
      row.append(checkbox, text);
      taskSection.appendChild(row);
      taskInputs.push(checkbox);
    });
    body.appendChild(taskSection);
    card.appendChild(body);

    const actions = document.createElement("div");
    actions.className = "workspace-export-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "dialog-btn";
    cancel.textContent = t("prompt.cancel");
    actions.appendChild(cancel);
    if (allowAttach) {
      const attach = document.createElement("button");
      attach.type = "button";
      attach.className = "dialog-btn";
      attach.textContent = t("pack.importAttachAction");
      attach.addEventListener("click", () => finish({ action: "attach" }));
      actions.appendChild(attach);
    }
    const importButton = document.createElement("button");
    importButton.type = "button";
    importButton.className = "dialog-btn dialog-btn--primary";
    importButton.textContent = t("pack.importAction");
    actions.appendChild(importButton);
    card.appendChild(actions);
    overlay.appendChild(card);

    const finish = (decision) => {
      overlay.remove();
      document.removeEventListener("keydown", onKeyDown);
      resolve(decision);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") finish({ action: "cancel" });
    };
    cancel.addEventListener("click", () => finish({ action: "cancel" }));
    importButton.addEventListener("click", () => finish({
      action: "import",
      selectedAutomationIndexes: taskInputs
        .filter((input) => input.checked)
        .map((input) => Number(input.value)),
    }));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) finish({ action: "cancel" });
    });

    document.body.appendChild(overlay);
    document.addEventListener("keydown", onKeyDown);
    requestAnimationFrame(() => importButton.focus());
  });
}
