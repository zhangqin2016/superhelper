/**
 * Voice input button — placeholder for future implementation.
 */

import { showToast } from "./toast.js";
import { $ } from "./dom.js";

export function initVoice() {
  const btn = $("voiceButton");
  if (!btn) return;

  btn.addEventListener("click", () => {
    showToast("语音输入功能即将上线", "info", 3000);
  });
}
