"use strict";
const {createHash} = require("node:crypto");
const {manifestMap} = require("./task-apply-plan");
const fail = code => Object.assign(new Error(`COLLAB_TASK_GIT_${code}`),{code:`COLLAB_TASK_GIT_${code}`});
const ordered = files => [...manifestMap(files).values()].map(({path,sha256,sizeBytes})=>({path,sha256,sizeBytes}))
  .sort((a,b)=>a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const manifestHash = files => createHash("sha256").update(JSON.stringify(ordered(files))).digest("hex");
function identityMap(records,manifest) {
  if (!Array.isArray(records) || records.length > manifest.size) throw fail("INVENTORY_INVALID");
  const result = new Map(), identities = new Set();
  for (const record of records) {
    if (!record || Object.keys(record).some(key=>!["path","identity"].includes(key))
      || typeof record.path !== "string" || manifest.get(record.path.toLowerCase())?.path !== record.path
      || typeof record.identity !== "string" || !/^[0-9]{1,24}:[1-9][0-9]{0,23}:[1-9][0-9]{0,23}$/.test(record.identity)
      || result.has(record.path) || identities.has(record.identity)) throw fail("INVENTORY_INVALID");
    result.set(record.path,record.identity); identities.add(record.identity);
  }
  return result;
}
function taskChangeset({baseManifest,manifest,materializedPaths,baseFileIdentities=[],fileIdentities=[]}) {
  const base = manifestMap(ordered(baseManifest)), after = manifestMap(ordered(manifest));
  const originalIds = identityMap(baseFileIdentities,base), currentIds = identityMap(fileIdentities,after);
  if (!Array.isArray(materializedPaths)) throw fail("INVENTORY_INVALID");
  manifestMap(materializedPaths.map(path=>({path,sha256:"0".repeat(64),sizeBytes:0})));
  const downloaded = new Set(materializedPaths);
  if (materializedPaths.some(name=>base.get(name.toLowerCase())?.path !== name)) throw fail("INVENTORY_INVALID");
  let operations = [];
  for (const key of new Set([...base.keys(),...after.keys()])) {
    const before = base.get(key), next = after.get(key);
    if (before && next && before.path === next.path && before.sha256 === next.sha256 && before.sizeBytes === next.sizeBytes) continue;
    if (before && !downloaded.has(before.path)) {
      if (next) throw fail("NOT_MATERIALIZED");
      continue;
    }
    operations.push({kind:!before ? "add" : !next ? "delete" : before.path !== next.path ? "rename" : "modify",before:before || null,after:next || null});
  }
  const paired = new Set(), renames = [];
  const addedByIdentity = new Map(operations.filter(item=>item.kind === "add" && currentIds.has(item.after.path))
    .map(item=>[currentIds.get(item.after.path),item]));
  for (const removed of operations.filter(item=>item.kind === "delete")) {
    const added = addedByIdentity.get(originalIds.get(removed.before.path));
    if (!added) continue;
    paired.add(removed); paired.add(added);
    renames.push({kind:"rename",before:removed.before,after:added.after});
  }
  // Without file identity, only unique identical-content moves can be paired.
  const additions = new Map(), deletions = new Map();
  for (const operation of operations) {
    if (paired.has(operation)) continue;
    const map = operation.kind === "add" ? additions : operation.kind === "delete" ? deletions : null;
    if (!map) continue;
    const file = operation.after || operation.before, key = `${file.sha256}:${file.sizeBytes}`;
    map.set(key,[...(map.get(key) || []),operation]);
  }
  for (const [key,removed] of deletions) {
    const added = additions.get(key);
    if (removed.length !== 1 || added?.length !== 1) continue;
    paired.add(removed[0]); paired.add(added[0]);
    renames.push({kind:"rename",before:removed[0].before,after:added[0].after});
  }
  operations = [...operations.filter(item=>!paired.has(item)),...renames].sort((a,b)=>{
    const x = (a.before || a.after).path, y = (b.before || b.after).path;
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return {operations,files:operations.filter(item=>item.after).map(item=>item.after),removed:operations.filter(item=>item.before).map(item=>item.before.path)};
}
module.exports = {taskChangeset,manifestHash};
