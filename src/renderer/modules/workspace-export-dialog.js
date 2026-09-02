import { t } from "../i18n/index.js";
import { formatBytes } from "./format-bytes.js";

function workspaceSkillRiskLabel(warning) {
  const value = warning?.value ? `: ${warning.value}` : "";
  if (warning?.kind === "domain") return `${t("pack.skillRiskDomain")}${value}`;
  if (warning?.kind === "credential-term") return `${t("pack.skillRiskCredential")}${value}`;
  if (warning?.kind === "secret") return `${t("pack.skillRiskSecret")}${value}`;
  if (warning?.kind === "workspace-identity") return `${t("pack.skillRiskIdentity")}${value}`;
  return warning?.label || t("pack.skillRiskUnknown");
}

function exportCategoryLabel(category) {
  const key = `pack.exportCategory.${category}`;
  const label = t(key);
  return label === key ? category : label;
}

function appendScheduledTasks(body, scheduledTasks) {
  const section = document.createElement("section");
  section.className = "workspace-export-skills";
  const title = document.createElement("h3");
  title.textContent = t("pack.scheduledTasksTitle");
  const intro = document.createElement("p");
  intro.textContent = scheduledTasks.length
    ? t("pack.scheduledTasksIntro")
    : t("pack.noScheduledTasks");
  section.append(title, intro);
  const inputs = [];
  for (const task of scheduledTasks) {
    const row = document.createElement("label");
    row.className = "workspace-export-include";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = false;
    input.value = task.id;
    const text = document.createElement("span");
    text.textContent = `${task.title} · ${task.scheduleText}`;
    row.append(input, text);
    section.appendChild(row);
    inputs.push(input);
  }
  body.appendChild(section);
  return inputs;
}

export function confirmWorkspacePackExport(info, sizeMb) {
  return new Promise((resolve) => {
    const workspaceSkills = Array.isArray(info.workspaceSkills) ? info.workspaceSkills : [];
    const scheduledTasks = Array.isArray(info.scheduledTasks) ? info.scheduledTasks : [];
    const riskySkills = workspaceSkills.filter((skill) => Array.isArray(skill.riskWarnings) && skill.riskWarnings.length);
    const overlay = document.createElement("section");
    overlay.className = "modal-panel workspace-export-panel";

    const card = document.createElement("div");
    card.className = "modal-card workspace-export-card";
    overlay.appendChild(card);

    const header = document.createElement("header");
    header.className = "modal-header";
    const titleWrap = document.createElement("div");
    const title = document.createElement("h2");
    title.textContent = t("pack.exportConfirmTitle");
    const lead = document.createElement("p");
    lead.textContent = t("pack.exportConfirmBody", { count: info.preview.fileCount, size: sizeMb });
    titleWrap.append(title, lead);
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "topbar-btn";
    closeBtn.textContent = t("prompt.cancel");
    header.append(titleWrap, closeBtn);
    card.appendChild(header);

    const body = document.createElement("div");
    body.className = "workspace-export-body";
    card.appendChild(body);

    if (info.requiredSkills?.length) {
      const required = document.createElement("p");
      required.className = "workspace-export-note";
      required.textContent = t("pack.requiredSkills", { count: info.requiredSkills.length });
      body.appendChild(required);
    }

    const categorySummary = Array.isArray(info.preview?.categorySummary) ? info.preview.categorySummary : [];
    if (categorySummary.length) {
      const planSection = document.createElement("section");
      planSection.className = "workspace-export-data workspace-export-plan";
      const planTitle = document.createElement("h3");
      planTitle.textContent = t("pack.exportPlanTitle");
      const planIntro = document.createElement("p");
      planIntro.textContent = t("pack.exportPlanIntro");
      const planList = document.createElement("div");
      planList.className = "workspace-export-data-list";
      for (const item of categorySummary.slice(0, 8)) {
        const chip = document.createElement("span");
        chip.textContent = t("pack.exportPlanItem", {
          category: exportCategoryLabel(item.category),
          count: item.fileCount || 0,
          size: formatBytes(item.totalBytes || 0),
        });
        planList.appendChild(chip);
      }
      planSection.append(planTitle, planIntro, planList);
      body.appendChild(planSection);
    }

    const skippedFileCount = Number(info.preview?.skippedFileCount || 0);
    if (skippedFileCount > 0) {
      const skipped = document.createElement("div");
      skipped.className = "workspace-export-warning";
      const examples = (info.preview?.skippedFiles || [])
        .slice(0, 5)
        .map((file) => file.relPath)
        .join(", ");
      skipped.textContent = t("pack.skippedFilesWarning", {
        count: skippedFileCount,
        size: formatBytes(info.preview?.limits?.maxFileBytes || 0),
        files: examples || "-",
      });
      body.appendChild(skipped);
    }

    if (info.preview?.truncated) {
      const truncated = document.createElement("div");
      truncated.className = "workspace-export-warning";
      truncated.textContent = t("pack.truncatedWarning", {
        count: info.preview?.limits?.maxTotalFiles || 0,
      });
      body.appendChild(truncated);
    }

    const appDataPaths = Array.isArray(info.preview?.appDataPaths) ? info.preview.appDataPaths : [];
    if (appDataPaths.length) {
      const dataSection = document.createElement("section");
      dataSection.className = "workspace-export-data";
      const dataTitle = document.createElement("h3");
      dataTitle.textContent = t("pack.appDataTitle");
      const dataIntro = document.createElement("p");
      dataIntro.textContent = t("pack.appDataIntro");
      const dataList = document.createElement("div");
      dataList.className = "workspace-export-data-list";
      for (const dataPath of appDataPaths) {
        const item = document.createElement("span");
        item.textContent = t("pack.appDataItem", {
          path: dataPath.path,
          count: dataPath.fileCount || 0,
          size: formatBytes(dataPath.totalBytes || 0),
        });
        dataList.appendChild(item);
      }
      dataSection.append(dataTitle, dataIntro, dataList);
      body.appendChild(dataSection);
    }

    const fileWarnings = info.preview.secretWarnings || [];
    if (fileWarnings.length) {
      const warn = document.createElement("div");
      warn.className = "workspace-export-warning";
      warn.textContent = t("pack.secretWarning", {
        count: fileWarnings.length,
        files: fileWarnings.slice(0, 5).map((item) => item.relPath).join(", "),
      });
      body.appendChild(warn);
    }

    const skillSection = document.createElement("section");
    skillSection.className = "workspace-export-skills";
    const skillTitle = document.createElement("h3");
    skillTitle.textContent = t("pack.workspaceSkillsTitle");
    const skillIntro = document.createElement("p");
    skillIntro.textContent = workspaceSkills.length
      ? t("pack.workspaceSkillsIntro")
      : t("pack.noWorkspaceSkills");
    skillSection.append(skillTitle, skillIntro);

    if (workspaceSkills.length) {
      const list = document.createElement("div");
      list.className = "workspace-export-skill-list";
      for (const skill of workspaceSkills) {
        const item = document.createElement("article");
        item.className = `workspace-export-skill${skill.riskWarnings?.length ? " has-risk" : ""}`;
        const itemHead = document.createElement("div");
        itemHead.className = "workspace-export-skill-head";
        const name = document.createElement("strong");
        name.textContent = skill.name || skill.id;
        const meta = document.createElement("span");
        meta.textContent = `${skill.id} · v${skill.version || "0.1.0"} · ${t("pack.skillFiles", { count: skill.fileCount || 0, size: formatBytes(skill.totalBytes) })}`;
        itemHead.append(name, meta);
        item.appendChild(itemHead);

        if (skill.riskWarnings?.length) {
          const riskTitle = document.createElement("div");
          riskTitle.className = "workspace-export-risk-title";
          riskTitle.textContent = t("pack.skillWarningTitle");
          item.appendChild(riskTitle);
          const risks = document.createElement("ul");
          risks.className = "workspace-export-risk-list";
          for (const warning of skill.riskWarnings.slice(0, 8)) {
            const li = document.createElement("li");
            const sourcePath = warning.relPath ? ` (${warning.relPath})` : "";
            li.textContent = `${workspaceSkillRiskLabel(warning)}${sourcePath}`;
            risks.appendChild(li);
          }
          item.appendChild(risks);
        }
        list.appendChild(item);
      }
      skillSection.appendChild(list);
    }
    body.appendChild(skillSection);

    const includeRow = document.createElement("label");
    includeRow.className = "workspace-export-include";
    const workspaceSkillCheckbox = document.createElement("input");
    workspaceSkillCheckbox.type = "checkbox";
    workspaceSkillCheckbox.checked = false;
    workspaceSkillCheckbox.disabled = workspaceSkills.length === 0;
    const includeText = document.createElement("span");
    includeText.textContent = workspaceSkills.length
      ? t("pack.workspaceSkillsInclude")
      : t("pack.workspaceSkillsDefaultOff");
    includeRow.append(workspaceSkillCheckbox, includeText);
    body.appendChild(includeRow);

    if (riskySkills.length) {
      const risk = document.createElement("div");
      risk.className = "workspace-export-danger";
      risk.textContent = t("pack.workspaceSkillRiskSummary", { count: riskySkills.length });
      body.appendChild(risk);
    }

    const scheduledTaskInputs = appendScheduledTasks(body, scheduledTasks);
    const actions = document.createElement("div");
    actions.className = "workspace-export-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "dialog-btn";
    cancel.textContent = t("prompt.cancel");
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "dialog-btn dialog-btn--primary";
    const updateConfirmText = () => {
      confirm.textContent = workspaceSkillCheckbox.checked
        ? t("pack.exportWithWorkspaceSkills")
        : t("pack.exportWithoutWorkspaceSkills");
    };
    updateConfirmText();
    actions.append(cancel, confirm);
    card.appendChild(actions);

    const finish = (value) => {
      overlay.remove();
      document.removeEventListener("keydown", onKeyDown);
      resolve(value);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") finish(null);
    };

    workspaceSkillCheckbox.addEventListener("change", updateConfirmText);
    closeBtn.addEventListener("click", () => finish(null));
    cancel.addEventListener("click", () => finish(null));
    confirm.addEventListener("click", () => finish({
      includeWorkspaceSkills: workspaceSkillCheckbox.checked,
      selectedScheduledTaskIds: scheduledTaskInputs
        .filter((input) => input.checked)
        .map((input) => input.value),
    }));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) finish(null);
    });

    document.body.appendChild(overlay);
    document.addEventListener("keydown", onKeyDown);
    requestAnimationFrame(() => confirm.focus());
  });
}
