import { t } from "../i18n/index.js";

const KINDS = new Set(["character", "persona", "worldBook"]);

function label(key, fallback) {
  const value = t(key);
  return value === key ? fallback : value;
}

function valid(block) {
  return block?.schemaVersion === 1
    && KINDS.has(block.kind)
    && typeof block.receiptId === "string"
    && typeof block.displayName === "string"
    && block.displayName.length > 0
    && Number.isSafeInteger(block.revisionNumber)
    && block.revisionNumber > 0
    && block.provenance === "agent_draft";
}

function button(action, text) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = "character-result-action";
  node.dataset.action = action;
  node.textContent = text;
  return node;
}

export function renderCharacterResultCard(block, {
  sessionId = "",
  api = window.assistantClient?.characterWorlds,
  onPreviewChanged = (detail) => window.dispatchEvent(new CustomEvent("character-worlds:preview-changed", { detail })),
  onAdjust = (detail) => window.dispatchEvent(new CustomEvent("character-worlds:adjust", { detail })),
  onView = (detail) => window.dispatchEvent(new CustomEvent("character-worlds:view", { detail })),
} = {}) {
  const root = document.createElement("section");
  root.className = "assistant-renderer-block character-result-card";
  if (!valid(block)) {
    root.classList.add("is-unavailable");
    root.textContent = label("character.receipt.unavailable", "Character draft unavailable");
    return root;
  }
  const kindLabel = {
    character: label("character.receipt.character", "Character"),
    persona: label("character.receipt.persona", "Persona"),
    worldBook: label("character.receipt.worldBook", "World book"),
  }[block.kind];
  const heading = document.createElement("div");
  heading.className = "character-result-heading";
  const copy = document.createElement("div");
  copy.className = "character-result-copy";
  const title = document.createElement("h4");
  title.textContent = block.displayName;
  title.title = block.displayName;
  const meta = document.createElement("p");
  meta.textContent = `${kindLabel} · v${block.revisionNumber} · ${label("character.receipt.draft", "Draft")}`;
  copy.append(title, meta);
  heading.append(copy);
  const actions = document.createElement("div");
  actions.className = "character-result-actions";
  const preview = button("preview", label("character.receipt.preview", "Try"));
  const adjust = button("adjust", label("character.receipt.adjust", "Adjust"));
  const view = button("view", label("character.receipt.view", "View"));
  actions.append(preview, adjust, view);
  root.append(heading, actions);

  async function run(action, fn) {
    if (!api || root.dataset.busy) return;
    root.dataset.busy = action;
    for (const item of actions.querySelectorAll("button")) item.disabled = true;
    try {
      const offered = await api.getReceiptActions(sessionId, block.receiptId);
      if (!offered?.ok || !offered.actions?.[action]) throw new Error("actions unavailable");
      await fn(offered.actions[action]);
    } catch {
      root.classList.add("has-error");
    } finally {
      delete root.dataset.busy;
      for (const item of actions.querySelectorAll("button")) item.disabled = false;
    }
  }
  preview.addEventListener("click", () => run("preview", async (token) => {
    const current = await api.getPreview(sessionId);
    const result = await api.startPreview({
      sessionId, receiptId: block.receiptId, actionToken: token,
      expectedPreviewVersion: current?.preview?.previewVersion || 0,
    });
    if (!result?.ok) throw new Error(result?.error || "preview failed");
    onPreviewChanged?.(result);
  }));
  adjust.addEventListener("click", () => run("adjust", async (token) => {
    const result = await api.adjustTarget({
      sessionId, receiptId: block.receiptId, actionToken: token,
    });
    if (!result?.ok) throw new Error(result?.error || "adjust failed");
    onAdjust?.({ kind: "characterWorldsAdjustment", handle: result.authoringContextHandle });
  }));
  view.addEventListener("click", () => run("view", async (token) => {
    if (typeof api.getReceiptView !== "function") throw new Error("view unavailable");
    const result = await api.getReceiptView(sessionId, block.receiptId, token);
    if (!result?.ok) throw new Error(result?.error || "view failed");
    onView?.(result);
  }));
  return root;
}
