/**
 * Simple in-app name input dialog (replaces window.prompt for naming).
 */

import { $ } from "./dom.js";

let activeDialog = null;

export function promptName({
  title = "输入名称",
  label = "名称",
  defaultValue = "",
  placeholder = "",
  confirmText = "确定",
  cancelText = "取消",
} = {}) {
  if (activeDialog) {
    activeDialog.remove();
    activeDialog = null;
  }

  return new Promise((resolve) => {
    const overlay = document.createElement("section");
    overlay.className = "modal-panel name-prompt-panel";
    overlay.innerHTML = `
      <div class="modal-card name-prompt-card">
        <header class="modal-header">
          <div>
            <h2 class="name-prompt-title"></h2>
            <p class="name-prompt-label"></p>
          </div>
        </header>
        <input class="name-prompt-input" type="text" maxlength="80" autocomplete="off" />
        <div class="name-prompt-actions">
          <button type="button" class="topbar-btn name-prompt-cancel"></button>
          <button type="button" class="send-btn name-prompt-confirm"></button>
        </div>
      </div>
    `;

    overlay.querySelector(".name-prompt-title").textContent = title;
    overlay.querySelector(".name-prompt-label").textContent = label;
    overlay.querySelector(".name-prompt-cancel").textContent = cancelText;
    overlay.querySelector(".name-prompt-confirm").textContent = confirmText;

    const input = overlay.querySelector(".name-prompt-input");
    input.placeholder = placeholder;
    input.value = defaultValue;

    const finish = (value) => {
      overlay.remove();
      activeDialog = null;
      document.removeEventListener("keydown", onKeyDown);
      resolve(value);
    };

    const onKeyDown = (e) => {
      if (e.key === "Escape") finish(null);
      if (e.key === "Enter") {
        e.preventDefault();
        finish(input.value.trim() || null);
      }
    };

    overlay.querySelector(".name-prompt-cancel").addEventListener("click", () => finish(null));
    overlay.querySelector(".name-prompt-confirm").addEventListener("click", () => {
      finish(input.value.trim() || null);
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(null);
    });

    document.body.appendChild(overlay);
    activeDialog = overlay;
    document.addEventListener("keydown", onKeyDown);
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  });
}

export async function promptSessionName(defaultValue = "新对话") {
  return promptName({
    title: "对话名称",
    label: "给这次对话起个名字，方便以后找到",
    defaultValue,
    placeholder: "例如：旅行计划、工作报告",
  });
}

export async function promptProjectName(defaultValue = "") {
  return promptName({
    title: "文件夹名称",
    label: "在列表里显示的名字（不影响电脑上的文件夹名）",
    defaultValue,
    placeholder: "例如：我的文档、工作资料",
  });
}
