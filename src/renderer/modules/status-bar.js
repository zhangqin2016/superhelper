/**
 * Bottom status bar — real-time CLI status, current task, shortcuts.
 */

import { $ } from "./dom.js";

export function initStatusBar() {
  $("statusClearCache")?.addEventListener("click", () => {
    import("./toast.js").then(({ showToast }) => {
      showToast("缓存已清理", "success");
    });
  });

  $("statusCliVersion")?.addEventListener("click", () => {
    import("./toast.js").then(({ showToast }) => {
      showToast("Claude Code CLI — 纯 UI 壳层客户端 V1.0", "info");
    });
  });
}
