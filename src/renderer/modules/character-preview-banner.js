import { t } from "../i18n/index.js";

function tr(key, fallback) {
  const value = t(key);
  return value === key ? fallback : value;
}

export function renderCharacterPreviewBanner(state, { onActivate, onExit } = {}) {
  const root = document.createElement("div");
  root.className = "character-preview-banner";
  const active = Boolean(state?.character || state?.persona || state?.worldBookCount);
  root.hidden = !active;
  if (!active) return root;
  const text = document.createElement("span");
  text.textContent = tr("character.preview.active", "Preview active for future messages");
  const actions = document.createElement("div");
  actions.className = "character-preview-actions";
  const activate = document.createElement("button");
  activate.type = "button";
  activate.dataset.action = "activate";
  activate.textContent = tr("character.preview.activate", "Use");
  const exit = document.createElement("button");
  exit.type = "button";
  exit.dataset.action = "exit";
  exit.textContent = tr("character.preview.exit", "Exit preview");
  activate.addEventListener("click", () => onActivate?.(state));
  exit.addEventListener("click", () => onExit?.(state));
  actions.append(activate, exit);
  root.append(text, actions);
  return root;
}
