"use strict";
const fail = () => {throw Object.assign(new Error("COLLAB_TASK_INVALID"),{code:"COLLAB_TASK_INVALID"});};
const oid = value => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
function gitDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key=>!["version","format","ref","commit","prerequisites","sha256","sizeBytes"].includes(key))
    || value.version !== 1 || value.format !== "git-bundle-v2" || !oid(value.commit)
    || typeof value.ref !== "string" || !/^refs\/tasks\/[0-9a-f]{64}\/(baseline|deliveries\/[0-9a-f]{64})$/.test(value.ref)
    || typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256)
    || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > 256*1024*1024
    || !Array.isArray(value.prerequisites) || value.prerequisites.length > 256
    || value.prerequisites.some(commit=>!oid(commit)) || new Set(value.prerequisites).size !== value.prerequisites.length) fail();
  return {version:1,format:"git-bundle-v2",ref:value.ref,commit:value.commit,
    prerequisites:[...value.prerequisites].sort(),sha256:value.sha256,sizeBytes:value.sizeBytes};
}
module.exports = {gitDescriptor};
