import { t } from "../i18n/index.js";
import { showToast } from "./toast.js";
import { classifyToolCategory } from "./turn-tool-model.js";
import {
  appendToolPayloadDetail,
  normalizeToolResult,
  parseGeneratedMedia,
  parseToolResult,
  toolInputHasRenderableDetail,
} from "./tool-payload-renderer.js";

export function appendToolResultBlock(row, tool, sealed = false, ctx = {}, {
  translate = t,
  toast = showToast,
  writeClipboard = (text) => navigator.clipboard.writeText(text),
  classifyTool = classifyToolCategory,
  inputHasDetail = toolInputHasRenderableDetail,
  appendPayloadDetail = appendToolPayloadDetail,
  parseResult = parseToolResult,
  parseMedia = parseGeneratedMedia,
  normalizeResult = normalizeToolResult,
} = {}) {
  const compactFileContent = sealed && classifyTool(tool.name) === "write";
  if (inputHasDetail(tool)) {
    appendPayloadDetail(row, tool, { role: "input", compactFileContent, sessionId: ctx.sessionId || "" });
  }
  if (!tool.result) return;

  const parsed = parseResult(tool.result);
  const generatedMediaText = typeof parsed?.content === "string" ? parsed.content : "";
  if (generatedMediaText && parseMedia(generatedMediaText).length) {
    appendPayloadDetail(row, tool, { role: "result", sessionId: ctx.sessionId || "" });
    return;
  }
  const resultKeys = parsed && typeof parsed === "object"
    ? Object.keys(parsed).filter((k) => k !== "truncated" && k !== "fullText")
    : [];
  const hasStructuredResult = resultKeys.length > 1 ||
    (resultKeys.length === 1 && resultKeys[0] !== "content");
  if (hasStructuredResult && parsed) {
    appendPayloadDetail(row, tool, { role: "result", sessionId: ctx.sessionId || "" });
    return;
  }

  const result = normalizeResult(tool.result);
  if (!result?.content) return;

  const pre = document.createElement("pre");
  pre.className = "assistant-tool-detail assistant-tool-result";
  pre.textContent = result.content;
  row.appendChild(pre);

  if (!result.truncated || !result.fullText) return;
  const actions = document.createElement("div");
  actions.className = "assistant-tool-detail-actions";

  const expandBtn = document.createElement("button");
  expandBtn.type = "button";
  expandBtn.className = "assistant-action-btn";
  expandBtn.textContent = translate("tool.expand");
  expandBtn.addEventListener("click", () => {
    const expanded = pre.dataset.expanded === "true";
    pre.textContent = expanded ? result.content : result.fullText;
    pre.dataset.expanded = expanded ? "false" : "true";
    expandBtn.textContent = expanded ? translate("tool.expand") : translate("tool.collapse");
  });

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "assistant-action-btn";
  copyBtn.textContent = translate("common.copy");
  copyBtn.addEventListener("click", async () => {
    const text = pre.dataset.expanded === "true" ? result.fullText : result.content;
    try {
      await writeClipboard(text);
      toast(translate("common.copied"), "success");
    } catch {
      toast(translate("common.copyFailed"), "warning");
    }
  });

  actions.append(expandBtn, copyBtn);
  row.appendChild(actions);
}
