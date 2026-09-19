/**
 * Which writing system a piece of text is in — the ONE definition.
 *
 * Seventeen sites in sixteen modules each spelled their own Han character
 * class, seven different ways (basic block only; with Extension A; with the
 * compatibility block; with kana; as literal characters), and two modules kept
 * identical copies of answerLanguage(). The same text was Chinese to one module
 * and not to the next, so the answer language, the scope notes, the search
 * bigrams and the token estimates could all disagree about one sentence.
 *
 * Ranges: CJK Unified Ideographs Extension A (3400–4DBF), CJK Unified
 * Ideographs (4E00–9FFF), CJK Compatibility Ideographs (F900–FAFF).
 * Shared by both processes (the renderer imports it, the main process
 * requires it).
 */

export const HAN_RANGES = "\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff";
export const KANA_RANGES = "\u3040-\u30ff";
export const ARABIC_RANGES = "\u0600-\u06ff";

/** One Han character. Use `hasHan` / `hanCount` unless you are composing a larger class. */
export const HAN_CHAR_RE = new RegExp(`[${HAN_RANGES}]`);
export const HAN_CHARS_RE = new RegExp(`[${HAN_RANGES}]`, "g");
/** Han or kana — "East Asian text" for containment heuristics. */
export const EAST_ASIAN_CHAR_RE = new RegExp(`[${HAN_RANGES}${KANA_RANGES}]`);
export const ARABIC_CHAR_RE = new RegExp(`[${ARABIC_RANGES}]`);

export function hasHan(text = "") {
  return HAN_CHAR_RE.test(String(text || ""));
}

export function hanCount(text = "") {
  return (String(text || "").match(HAN_CHARS_RE) || []).length;
}

/** Han characters of a text, in order — for bigram tokenizers. */
export function hanChars(text = "") {
  return String(text || "").match(HAN_CHARS_RE) || [];
}

/** The language an answer to `text` should be written in: "zh" | "ar" | "en". */
export function answerLanguage(text = "") {
  const value = String(text || "");
  if (HAN_CHAR_RE.test(value)) return "zh";
  if (ARABIC_CHAR_RE.test(value)) return "ar";
  return "en";
}

/** The language a model recipe wants its platform instructions in: "zh" | "en". */
export function instructionLanguage(recipes = null) {
  return recipes?.instructionLanguage === "zh" ? "zh" : "en";
}
