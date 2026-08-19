import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import JSZip from "jszip";
import {
  LEGAL_KB_SCHEMA_VERSION,
  isIgnoredSourcePath,
  normalizeArchivePath,
  validateLegalPackManifest,
} from "../src/main/legal-kb/legal-kb-contract.js";

const MAX_ARTICLE_BYTES = 4 * 1024;
const ARTICLE_HEADER_RE = /^\s*[#>*\s]*(第[零〇一二三四五六七八九十百千万亿两0-9]+(?:\.[0-9]+)?条)/gm;

function sourceRelativePath(value) {
  const normalized = normalizeArchivePath(value);
  const marker = "legal_kb_package/";
  return normalized.startsWith(marker) ? normalized.slice(marker.length) : normalized;
}

function findEntry(zip, wantedPath) {
  const wanted = normalizeArchivePath(wantedPath).toLowerCase();
  return Object.values(zip.files).find((entry) => {
    try {
      return normalizeArchivePath(entry.name).toLowerCase() === wanted;
    } catch {
      return false;
    }
  }) || null;
}

function boundedText(value, max = MAX_ARTICLE_BYTES) {
  const text = String(value || "").replace(/\r\n?/g, "\n").trim();
  return text.length > max ? `${text.slice(0, max)}\n[内容已截断]` : text;
}

function articlesFromMarkdown(markdown) {
  const text = String(markdown || "").replace(/\r\n?/g, "\n");
  const matches = [...text.matchAll(ARTICLE_HEADER_RE)];
  if (!matches.length) {
    const fallback = boundedText(text);
    return fallback ? [{ article: "全文", text: fallback }] : [];
  }
  return matches.map((match, index) => {
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
    return { article: match[1], text: boundedText(text.slice(start, end)) };
  }).filter((item) => item.text);
}

function itemMetadata(manifest, relativePath) {
  return (Array.isArray(manifest.items) ? manifest.items : []).find((item) => {
    if (!item?.file) return false;
    try {
      return normalizeArchivePath(item.file).toLowerCase() === relativePath.toLowerCase();
    } catch {
      return false;
    }
  }) || {};
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function buildLegalKnowledgePack({ archiveBuffer, outputDir, packId = "legal-cn-enterprise" } = {}) {
  if (!Buffer.isBuffer(archiveBuffer) || archiveBuffer.length < 4) {
    return { ok: false, error: "LEGAL_KB_ARCHIVE_INVALID" };
  }
  if (!outputDir) return { ok: false, error: "LEGAL_KB_OUTPUT_REQUIRED" };

  let zip;
  try {
    zip = await JSZip.loadAsync(archiveBuffer);
  } catch {
    return { ok: false, error: "LEGAL_KB_ARCHIVE_CORRUPT" };
  }
  const sourceManifestEntry = findEntry(zip, "legal_kb_package/laws_manifest.json");
  if (!sourceManifestEntry) return { ok: false, error: "LEGAL_KB_SOURCE_MANIFEST_MISSING" };
  let sourceManifest;
  try {
    sourceManifest = JSON.parse(await sourceManifestEntry.async("string"));
  } catch {
    return { ok: false, error: "LEGAL_KB_SOURCE_MANIFEST_CORRUPT" };
  }
  const contentVersion = String(sourceManifest.content_version || sourceManifest.version || "").trim();
  const entries = Object.values(zip.files);
  const sourceFiles = entries.filter((entry) => {
    if (entry.dir) return false;
    let normalized;
    try { normalized = normalizeArchivePath(entry.name); } catch { return false; }
    return normalized.toLowerCase().startsWith("legal_kb_package/")
      && normalized.toLowerCase().endsWith(".md")
      && !normalized.includes("_归档_")
      && !isIgnoredSourcePath(normalized);
  });
  if (!sourceFiles.length) return { ok: false, error: "LEGAL_KB_SOURCE_DOCUMENTS_MISSING" };

  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
  const catalog = [];
  const articlesPath = path.join(outputDir, "articles.jsonl");
  const articleStream = fs.createWriteStream(articlesPath, { encoding: "utf8" });
  let articleCount = 0;
  for (const entry of sourceFiles) {
    const normalized = normalizeArchivePath(entry.name);
    const relativePath = sourceRelativePath(normalized);
    const metadata = itemMetadata(sourceManifest, relativePath);
    const markdown = await entry.async("string");
    const chunks = articlesFromMarkdown(markdown);
    if (!chunks.length) continue;
    const document = {
      title: String(metadata.title || path.basename(relativePath, ".md")),
      sourcePath: relativePath,
      category: String(metadata.category || ""),
      verified: String(metadata.verified || "UNVERIFIED"),
      verifiedNote: String(metadata.verified_note || ""),
      authority: String(metadata.zdjg || ""),
      promulgatedAt: String(metadata.gbrq || ""),
      effectiveAt: String(metadata.sxrq || ""),
      articles: chunks.length,
    };
    catalog.push(document);
    for (const [chunkIndex, chunk] of chunks.entries()) {
      articleCount += 1;
      articleStream.write(`${JSON.stringify({
        id: `${relativePath}#${chunk.article}@${chunkIndex + 1}`,
        title: document.title,
        article: chunk.article,
        text: chunk.text,
        sourcePath: document.sourcePath,
        category: document.category,
        verified: document.verified,
        verifiedNote: document.verifiedNote,
        authority: document.authority,
        promulgatedAt: document.promulgatedAt,
        effectiveAt: document.effectiveAt,
      })}\n`);
    }
  }
  articleStream.end();
  await new Promise((resolve, reject) => {
    articleStream.once("finish", resolve);
    articleStream.once("error", reject);
  });
  if (!articleCount || !catalog.length) return { ok: false, error: "LEGAL_KB_ARTICLES_MISSING" };

  const lineageEntry = findEntry(zip, "legal_kb_package/output/version_lineage.json");
  let lineage = { generated: "", chains: 0, lineage: [] };
  if (lineageEntry) {
    try { lineage = JSON.parse(await lineageEntry.async("string")); } catch { /* optional lineage */ }
  }
  const manifestResult = validateLegalPackManifest({
    schemaVersion: LEGAL_KB_SCHEMA_VERSION,
    packId,
    contentVersion,
    sourceVersion: contentVersion,
    articleCount,
    documentCount: catalog.length,
  });
  if (!manifestResult.ok) return { ok: false, error: manifestResult.errors.join(",") };
  writeJson(path.join(outputDir, "catalog.json"), catalog);
  writeJson(path.join(outputDir, "lineage.json"), lineage);
  writeJson(path.join(outputDir, "manifest.json"), {
    ...manifestResult.manifest,
    sourceGenerated: String(sourceManifest.generated || ""),
    sourceArticleCount: Number(sourceManifest.total_articles || 0),
    sourceDocumentCount: Number(sourceManifest.total || sourceManifest.items?.length || 0),
    createdBy: "lily-legal-kb-builder",
  });
  return { ok: true, manifest: manifestResult.manifest, outputDir };
}

export async function packageLegalKnowledgePack({ packDir, outputFile } = {}) {
  if (!packDir || !outputFile) return { ok: false, error: "LEGAL_KB_PACKAGE_PATH_REQUIRED" };
  const files = ["manifest.json", "catalog.json", "articles.jsonl", "lineage.json"];
  const zip = new JSZip();
  for (const file of files) {
    const filePath = path.join(packDir, file);
    if (!fs.existsSync(filePath)) return { ok: false, error: `LEGAL_KB_FILE_MISSING:${file}` };
    zip.file(file, fs.readFileSync(filePath), { date: new Date(0), createFolders: false });
  }
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, bytes);
  return {
    ok: true,
    outputFile,
    sizeBytes: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
}

async function main() {
  const args = new Map();
  for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
  const input = args.get("--input");
  const output = args.get("--output");
  const artifact = args.get("--artifact");
  if (!input || !output) throw new Error("Usage: node scripts/build-legal-kb-pack.mjs --input source.zip --output pack-dir");
  const result = await buildLegalKnowledgePack({ archiveBuffer: fs.readFileSync(input), outputDir: output });
  if (!result.ok) throw new Error(result.error);
  const packaged = artifact ? await packageLegalKnowledgePack({ packDir: output, outputFile: artifact }) : null;
  if (packaged && !packaged.ok) throw new Error(packaged.error);
  process.stdout.write(`${JSON.stringify({ ...result, artifact: packaged })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
