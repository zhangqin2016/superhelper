/**
 * Import-preview pane for the conversation character control (Character
 * Worlds Phase 1): name, decorative monogram swatch, detected format,
 * compatibility level, supported/inert field counts, duplicate note, security
 * warnings, and the explicit commit/cancel commands. Flat content inside the
 * existing popover — no nested cards.
 */

import { el } from "./dom.js";
import { t } from "../i18n/index.js";

const LEVELS = new Set(["lossless_data", "preserved_inert", "safe_behavior"]);

/** First-grapheme monogram for the decorative avatar swatch. */
export function monogram(name) {
  return Array.from(String(name || "").trim())[0] || "?";
}

function metaRow(previewEl, text, dataKey) {
  const row = el("div", "character-preview-meta-row", { textContent: text });
  if (dataKey) row.setAttribute(dataKey, "");
  previewEl.appendChild(row);
}

export function renderCharacterImportPreview(previewEl, preview, { committing = false } = {}) {
  previewEl.textContent = "";
  const header = el("div", "character-preview-header");
  const swatch = el("span", "character-preview-swatch", { textContent: monogram(preview.name) });
  swatch.setAttribute("aria-hidden", "true");
  header.appendChild(swatch);
  const name = preview.name || t("character.unnamed");
  header.appendChild(el("span", "character-preview-name", { textContent: name, title: name }));
  previewEl.appendChild(header);

  metaRow(previewEl, t("character.import.format", { format: preview.format }), "data-preview-format");
  const levelText = LEVELS.has(preview.level) ? t(`character.import.level.${preview.level}`) : preview.level;
  metaRow(previewEl, levelText, "data-preview-level");
  metaRow(previewEl, t("character.import.supportedFields", { count: preview.supportedCount }), "data-preview-supported");
  metaRow(previewEl, t("character.import.inertFields", { count: preview.inertCount }), "data-preview-inert");
  if (preview.duplicateKind) {
    metaRow(previewEl, t(preview.duplicateKind === "exact"
      ? "character.import.duplicateExact"
      : "character.import.duplicateCanonical"), "data-preview-duplicate");
  }
  for (const warning of preview.warnings) {
    const text = warning.code === "EXECUTABLE_REJECTED"
      ? t("character.import.warningExecutable")
      : warning.code === "COMPATIBILITY_REPORT_TRUNCATED"
        ? t("character.import.warningTruncated")
        : warning.code;
    const row = el("div", "character-preview-warning", { textContent: text, role: "note" });
    row.setAttribute("data-preview-warning", "");
    previewEl.appendChild(row);
  }

  const footer = el("div", "character-preview-actions");
  footer.appendChild(el("button", "character-preview-commit", {
    id: "characterImportCommitBtn",
    type: "button",
    textContent: committing ? t("character.import.committing") : t("character.import.commit"),
    ...(committing ? { disabled: "" } : {}),
  }));
  footer.appendChild(el("button", "character-preview-cancel", {
    id: "characterImportCancelBtn",
    type: "button",
    textContent: t("character.import.cancel"),
  }));
  previewEl.appendChild(footer);
}
