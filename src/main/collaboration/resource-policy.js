"use strict";
const fs=require("node:fs");
const path=require("node:path");
const {DEFAULT_LIMITS}=require("./workspace-package");
const fail=code=>Object.assign(Error(`COLLAB_RESOURCE_${code}`),{code:`COLLAB_RESOURCE_${code}`});
const CEILINGS=Object.freeze({maxTotalBytes:64*1024*1024*1024,maxFiles:1000000,maxFileBytes:4*1024*1024*1024,reserveBytes:64*1024*1024*1024});
const DEFAULT_RESERVE=256*1024*1024;
function fromEnv(name,fallback,ceiling,env){
  const raw=env[name];if(raw===undefined||raw==="")return fallback;
  const value=Number(raw);
  if(!Number.isSafeInteger(value)||value<1||value>ceiling)throw fail("LIMIT_INVALID");
  return value;
}
/** Capacity is a policy, not a constant: operators raise the fixed defaults
 * through environment limits (bounded by hard ceilings), and every large
 * materialization checks the destination volume's free space first. */
function collaborationLimits(env=process.env){
  return Object.freeze({
    maxTotalBytes:fromEnv("LILY_COLLAB_MAX_TOTAL_BYTES",DEFAULT_LIMITS.maxTotalBytes,CEILINGS.maxTotalBytes,env),
    maxFiles:fromEnv("LILY_COLLAB_MAX_FILES",DEFAULT_LIMITS.maxFiles,CEILINGS.maxFiles,env),
    maxFileBytes:fromEnv("LILY_COLLAB_MAX_FILE_BYTES",DEFAULT_LIMITS.maxFileBytes,CEILINGS.maxFileBytes,env),
    reserveBytes:fromEnv("LILY_COLLAB_RESERVE_BYTES",DEFAULT_RESERVE,CEILINGS.reserveBytes,env),
  });
}
function freeBytes(root,probe=fs.statfsSync){
  let target=root;
  while(!fs.existsSync(target)){const parent=path.dirname(target);if(parent===target)break;target=parent;}
  const stats=probe(target);
  return Number(stats.bavail)*Number(stats.bsize);
}
/** Refuse a materialization the volume cannot hold with the configured reserve
 * left over, before the first byte is written. */
function assertCapacity({root,bytes,limits=collaborationLimits(),probe=fs.statfsSync}){
  if(!Number.isSafeInteger(bytes)||bytes<0)throw fail("LIMIT_INVALID");
  const available=freeBytes(root,probe);
  if(!Number.isFinite(available))return {available:null,required:bytes+limits.reserveBytes};
  if(available<bytes+limits.reserveBytes)throw Object.assign(fail("DISK_QUOTA"),{available,required:bytes+limits.reserveBytes});
  return {available,required:bytes+limits.reserveBytes};
}
module.exports={collaborationLimits,assertCapacity,freeBytes,RESOURCE_CEILINGS:CEILINGS};
