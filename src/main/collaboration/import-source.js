"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { MAX_PLAINTEXT_BYTES } = require("./encrypted-container-format");
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const invalid = () => Object.assign(new Error("COLLABORATION_INVALID_INPUT"), { code: "COLLABORATION_INVALID_INPUT" });
function validImportCommand(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(k => !["conversationId", "source"].includes(k)) || typeof value.conversationId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value.conversationId)) return false;
  const source = value.source;
  if (!source || Object.getPrototypeOf(source) !== Object.prototype) return false;
  if (source.kind === "file") return Object.keys(source).every(k => ["kind", "path"].includes(k)) && typeof source.path === "string" && source.path.length <= 32768 && !source.path.includes("\0") && path.isAbsolute(source.path);
  return source.kind === "image" && Object.keys(source).every(k => ["kind", "bytes"].includes(k)) && source.bytes instanceof Uint8Array && source.bytes.length > 0 && source.bytes.length <= MAX_IMAGE_BYTES;
}
function imageType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return ["png", "image/png"];
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return ["jpg", "image/jpeg"];
  if (bytes.length >= 12 && bytes.toString("ascii",0,4) === "RIFF" && bytes.toString("ascii",8,12) === "WEBP") return ["webp", "image/webp"];
  throw invalid();
}
/** Only the explicit drop/paste entry accepts a local source. Existing transfer
 * commands remain ID-only; scope, DEK and destination are always main-owned. */
async function withImportSource(source, rootPath, operation) {
  if (source.kind === "file") {
    const stat = await fs.lstat(source.path);
    if (!stat.isFile()) throw invalid();
    if (stat.size > MAX_PLAINTEXT_BYTES) throw Object.assign(new Error("COLLAB_OBJECT_SIZE_INVALID"), {code:"COLLAB_OBJECT_SIZE_INVALID"});
    const ext = path.extname(source.path).toLowerCase();
    const mimeType = ({".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".webp":"image/webp",".gif":"image/gif",".pdf":"application/pdf"})[ext] || "application/octet-stream";
    return operation({ inputPath: source.path, originalName: path.basename(source.path), mimeType });
  }
  const bytes = Buffer.from(source.bytes);
  const [ext, mimeType] = imageType(bytes);
  await fs.mkdir(rootPath, {recursive:true,mode:0o700});
  const directory = await fs.mkdtemp(path.join(rootPath,"clipboard-"));
  try {
    const originalName = `Screenshot-${Date.now()}.${ext}`;
    const inputPath = path.join(directory, originalName);
    await fs.writeFile(inputPath, bytes, {mode:0o600,flag:"wx"});
    return await operation({inputPath,originalName,mimeType});
  } finally { bytes.fill(0); await fs.rm(directory,{recursive:true,force:true}); }
}
module.exports = {validImportCommand,withImportSource,MAX_IMAGE_BYTES};
