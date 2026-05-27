/**
 * Bottom status bar — assistant status and about info.
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
      showToast("智能助手 V1.0", "info");
    });
  });
}
