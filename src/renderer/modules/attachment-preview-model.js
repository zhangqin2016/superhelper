const TEXT_EXTENSIONS = new Set([
  "md", "markdown", "txt", "csv", "json", "yaml", "yml", "toml", "xml",
  "js", "ts", "jsx", "tsx", "py", "java", "go", "rs", "c", "cpp", "h", "hpp",
  "html", "htm", "css", "scss", "less", "sql", "sh", "bash", "swift", "kt", "scala",
  "lua", "r", "m", "rb", "php", "vue", "svelte",
]);
const OFFICE_EXTENSIONS = new Set(["doc", "docx", "xls", "xlsx", "ppt", "pptx", "rtf"]);

function extensionFor(file = {}) {
  const explicit = String(file.extension || "").trim().replace(/^\./, "").toLowerCase();
  if (explicit) return explicit;
  const name = String(file.name || file.path || "").trim();
  return (name.match(/\.([a-z0-9]{1,12})$/i)?.[1] || "").toLowerCase();
}

export function attachmentPreviewKind(file = {}) {
  if (file?.isDirectory || file?.kind === "directory") return "folder";
  if (file?.isImage || file?.kind === "image") return "image";
  const ext = extensionFor(file);
  if (ext === "pdf") return "pdf";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  if (OFFICE_EXTENSIONS.has(ext)) return "office";
  return "file";
}

export function attachmentPreviewPath(file = {}) {
  return String(file.sourcePath || file.path || "").trim();
}

export function attachmentMediaPath(file = {}) {
  return String(file.path || file.sourcePath || "").trim();
}
