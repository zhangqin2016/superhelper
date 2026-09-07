"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const JSZip = require("jszip");
const share = require("../workspace-share");
const {manifestMap} = require("./task-apply-plan");
const {DEFAULT_LIMITS,inspectCollaborationWorkspacePackage,extractCollaborationWorkspacePackage} = require("./workspace-package");
const fail = (code) => Object.assign(new Error(`COLLAB_TASK_BUNDLE_${code}`), {code:`COLLAB_TASK_BUNDLE_${code}`});
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const signature = (stat) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
const contains = (a,b) => a === b || b.startsWith(`${a}${path.sep}`);
// Task files are data, not a grant to replace the receiving agent's hooks,
// instructions, MCP connections or workspace authority configuration.
const controlPath = relative => relative.toLowerCase().split("/").some(part =>
  [".git",".claude",".codex",".agents",".opencode",".lily-work","agents.md","claude.md","gemini.md",".mcp.json","mcp.json","opencode.json","opencode.jsonc"].includes(part));

function directory(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value
    || fs.realpathSync(value) !== value || !fs.lstatSync(value).isDirectory()) throw fail("UNSAFE_PATH");
  return value;
}
function checkedFile(root, relative, maxBytes = DEFAULT_LIMITS.maxFileBytes) {
  directory(root);
  let current = root;
  for (const [index,piece] of relative.split("/").entries()) {
    current = path.join(current,piece);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (index < relative.split("/").length - 1 && !stat.isDirectory())) throw fail("UNSAFE_PATH");
  }
  const stat = fs.lstatSync(current);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) throw fail("UNSAFE_PATH");
  const fd = fs.openSync(current,fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (signature(fs.fstatSync(fd)) !== signature(stat)) throw fail("SOURCE_CHANGED");
    const bytes = fs.readFileSync(fd);
    if (signature(fs.fstatSync(fd)) !== signature(stat) || signature(fs.lstatSync(current)) !== signature(stat)
      || bytes.length !== stat.size) throw fail("SOURCE_CHANGED");
    return {bytes,signature:signature(stat)};
  } finally { fs.closeSync(fd); }
}
function prepareDestination(value, source) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value) throw fail("DESTINATION_INVALID");
  directory(path.dirname(value));
  if (source && (contains(source,value) || contains(value,source))) throw fail("ROOT_OVERLAP");
  if (fs.existsSync(value)) {
    directory(value);
    if (fs.readdirSync(value).length) throw fail("DESTINATION_EXISTS");
  } else fs.mkdirSync(value,{mode:0o700});
  return directory(value);
}
function writePrivate(file, bytes) {
  const fd = fs.openSync(file,fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,0o600);
  try { fs.writeFileSync(fd,bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function snapshotManifest(root) {
  const files = [];
  let total = 0;
  function walk(relative) {
    for (const name of fs.readdirSync(path.join(root,relative)).sort()) {
      const rel = relative ? `${relative}/${name}` : name;
      const stat = fs.lstatSync(path.join(root,rel));
      if (stat.isSymbolicLink()) throw fail("UNSAFE_PATH");
      if (stat.isDirectory()) walk(rel);
      else {
        const {bytes} = checkedFile(root,rel);
        total += bytes.length;
        if (files.length >= 10000 || total > DEFAULT_LIMITS.maxTotalBytes) throw fail("LIMIT_EXCEEDED");
        files.push({path:rel,sha256:hash(bytes),sizeBytes:bytes.length});
      }
    }
  }
  walk("");
  manifestMap(files);
  return files.sort((a,b)=>a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
async function unpackBytes(bytes,destinationRoot) {
  await inspectCollaborationWorkspacePackage({zipBuffer:bytes});
  const snapshotRoot = path.join(destinationRoot,"snapshot");
  await extractCollaborationWorkspacePackage({zipBuffer:bytes,targetDir:snapshotRoot});
  const manifest = snapshotManifest(snapshotRoot);
  if (manifest.some(file=>controlPath(file.path))) throw fail("CONTROL_FILE");
  // This baseline is never a working directory. Read-only files discourage
  // accidental edits; the bound hashes remain the authoritative integrity guard.
  for (const file of manifest) fs.chmodSync(path.join(snapshotRoot,file.path),0o400);
  return {snapshotRoot:directory(snapshotRoot),manifest};
}
async function unpackTaskBundle({packagePath,destinationRoot} = {}) {
  if (typeof packagePath !== "string" || !path.isAbsolute(packagePath)) throw fail("UNSAFE_PATH");
  const bytes = checkedFile(directory(path.dirname(packagePath)),path.basename(packagePath),DEFAULT_LIMITS.maxPackageBytes).bytes;
  const destination = prepareDestination(destinationRoot);
  return unpackBytes(bytes,destination);
}
async function freezeTaskBundle({sourceRoot,destinationRoot,name} = {}) {
  const source = directory(sourceRoot);
  const destination = prepareDestination(destinationRoot,source);
  const appManifest = path.join(source,"lily-app.json");
  if (fs.existsSync(appManifest) && fs.lstatSync(appManifest).isSymbolicLink()) throw fail("UNSAFE_PATH");
  const collected = share.collectShareableFiles(source);
  if (collected.truncated) throw fail("TRUNCATED");
  if (collected.files.length > 10000 || collected.totalBytes > DEFAULT_LIMITS.maxTotalBytes) throw fail("LIMIT_EXCEEDED");
  // Validate original names before normalized planner paths can mask aliases.
  for (const file of collected.files) {
    if (path.relative(source,file.fullPath).split(path.sep).join("/") !== file.relPath) throw fail("UNSAFE_PATH");
  }
  manifestMap(collected.files.map(file=>({path:file.relPath,sha256:"0".repeat(64),sizeBytes:file.size})));
  const captureRoot = fs.mkdtempSync(path.join(destination,".capture-"));
  const captureIdentity = fs.lstatSync(captureRoot);
  const captures = [];
  try {
    let total = 0;
    for (const file of collected.files) {
      const captured = checkedFile(source,file.relPath);
      total += captured.bytes.length;
      if (total > DEFAULT_LIMITS.maxTotalBytes || captured.bytes.length !== file.size) throw fail("SOURCE_CHANGED");
      const fullPath = path.join(captureRoot,String(captures.length));
      captures.push({...file,fullPath,size:captured.bytes.length,sha256:hash(captured.bytes),signature:captured.signature});
      writePrivate(fullPath,captured.bytes);
    }
    for (const file of captures) {
      // Do not reread live bytes. Verify all captured file identities/times at
      // the end of capture before turning the frozen data into a package.
      const sourceFile = path.join(source,file.relPath);
      if (fs.realpathSync(sourceFile) !== sourceFile || signature(fs.lstatSync(sourceFile)) !== file.signature) throw fail("SOURCE_CHANGED");
    }
    const secrets = share.scanForSecrets(captures);
    const controls = captures.filter(file=>controlPath(file.relPath));
    const excluded = new Set([...secrets,...controls].map(item=>item.relPath));
    const selected = captures.filter(file=>!excluded.has(file.relPath));
    if (!selected.length) throw fail("EMPTY");
    const zip = new JSZip();
    const expected = [];
    for (const file of selected) {
      const captured = checkedFile(captureRoot,path.basename(file.fullPath));
      if (hash(captured.bytes) !== file.sha256) throw fail("CAPTURE_CHANGED");
      zip.file(`files/${file.relPath}`,captured.bytes,{createFolders:false});
      expected.push({path:file.relPath,sha256:file.sha256,sizeBytes:file.size});
    }
    zip.file("lily-workspace.json",JSON.stringify({schemaVersion:1,kind:"lily-workspace-pack",name:String(name || "Task materials").slice(0,200),fileCount:selected.length,hasConventions:false,requiredSkills:[],workspaceSkills:[],automationCount:0}));
    // STORE avoids turning legitimate highly repetitive documents into an
    // archive rejected by the strict compression-ratio guard on import.
    const bytes = await zip.generateAsync({type:"nodebuffer",compression:"STORE"});
    if (bytes.length > DEFAULT_LIMITS.maxPackageBytes) throw fail("LIMIT_EXCEEDED");
    const unpacked = await unpackBytes(bytes,destination);
    expected.sort((a,b)=>a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    if (JSON.stringify(expected) !== JSON.stringify(unpacked.manifest)) throw fail("SNAPSHOT_MISMATCH");
    const packagePath = path.join(destination,"task.lilyspace.zip");
    writePrivate(packagePath,bytes);
    fs.chmodSync(packagePath,0o400);
    return {packagePath,...unpacked,files:unpacked.manifest.map(({path,sizeBytes})=>({path,sizeBytes})),warnings:[
      ...secrets.map(item=>`Sensitive content omitted: ${item.relPath} (${item.kinds.join(", ")})`),
      ...controls.map(item=>`Agent configuration omitted: ${item.relPath}`),
      ...(collected.skippedFiles || []).map(item=>`File omitted: ${item.relPath} (${item.reason})`),
      ...(collected.skippedDirs || []).map(item=>`Directory omitted: ${item.relPath} (${item.reason})`),
    ],omitted:(collected.skippedFileCount || 0)+(collected.skippedDirCount || 0)+excluded.size};
  } finally {
    // These private numeric capture files are the only cleanup targets; source
    // work and a successfully verified snapshot are never cleanup candidates.
    if (fs.existsSync(captureRoot) && fs.realpathSync(captureRoot) === captureRoot
      && fs.lstatSync(captureRoot).ino === captureIdentity.ino && fs.lstatSync(captureRoot).dev === captureIdentity.dev) {
      for (const file of captures) if (fs.existsSync(file.fullPath)) fs.unlinkSync(file.fullPath);
      fs.rmdirSync(captureRoot);
    }
  }
}
module.exports = {freezeTaskBundle,unpackTaskBundle};
