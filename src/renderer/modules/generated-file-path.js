// Which strings in a tool payload name a file the turn actually produced.
// Extracted from tool-payload-renderer.js: the file-kind table decides which
// extensions count, and a placeholder path from a prompt template never does.
import { EXTENSIONS as FILE_EXTENSIONS, alternation } from "../../shared/file-kinds.mjs";

export function isPlaceholderGeneratedPath(filePath = "") {
  const raw = String(filePath || "").trim();
  if (!raw) return true;
  let normalized = raw.replace(/\\/g, "/");
  try { normalized = decodeURIComponent(normalized); } catch { /* keep raw */ }
  const lower = normalized.toLowerCase();
  return (
    /^\/(?:absolute\/path\/to|path\/to)\//.test(lower) ||
    /^[a-z]:\/(?:absolute\/path\/to|path\/to)\//.test(lower) ||
    lower.includes("/\u7edd\u5bf9\u8def\u5f84/") ||
    /^\/?\u7edd\u5bf9\u8def\u5f84\//.test(normalized) ||
    /(^|\/)(?:your|example|sample)-?path\//.test(lower)
  );
}

export // Skill scripts (template-fill, pdf-form, render_document, the office skills)
// run via Bash and print JSON like {ok:true, output:"…/x.docx"} or
// {ok:true, images:["…/page-1.png", …]}. Detect those output paths so the file
// gets a "reveal in folder" affordance — the model never edited it via Write,
// so it isn't in the changed-files group.
const GENERATED_FILE_EXTS = new RegExp(`\\.(${alternation(FILE_EXTENSIONS.ooxml)}|pdf|csv|md|txt|rtf|${alternation(FILE_EXTENSIONS.browserMedia)}|html?|json|zip)$`, "i");

export function looksLikeGeneratedFilePath(value) {
  if (typeof value !== "string") return false;
  const text = value.trim();
  return text.length > 3 && /[\\/]/.test(text) && GENERATED_FILE_EXTS.test(text) && !isPlaceholderGeneratedPath(text);
}
