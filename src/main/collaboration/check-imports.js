"use strict";
const path=require("node:path");
const {builtinModules}=require("node:module");
const BUILTINS=new Set(builtinModules.flatMap(name=>[name,`node:${name}`]));
const PATTERN=/(?:\brequire\s*\(\s*|\bimport\s*\(\s*|\bfrom\s+|\bimport\s+)(["'])([^"'\n]{1,512})\1/g;
const PACKAGE=/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;
const CANDIDATES=["",".js",".cjs",".mjs",".json","/index.js","/index.cjs","/index.mjs","/index.json"];
const LIMITS=Object.freeze({maxHelpers:64,maxHelperBytes:256*1024,maxTotalBytes:4*1024*1024,maxUnresolved:32});
const fail=code=>Object.assign(Error(`COLLAB_CHECK_POLICY_${code}`),{code:`COLLAB_CHECK_POLICY_${code}`});
const INFRA=new Set(["test","tests","__tests__","spec","specs","fixture","fixtures","helpers","__mocks__","mocks","testing"]);
/** Test infrastructure lives beside the selected checks or under conventional
 * test directories. Everything else a check imports is the code under test:
 * the contribution may change it, and the pinned check judges that change. */
function isTestInfrastructure(file,roots){
  const segments=file.split("/");
  if(segments.slice(0,-1).some(segment=>INFRA.has(segment.toLowerCase())))return true;
  return roots.some(root=>{const dir=path.posix.dirname(root);return dir!=="."&&dir!==""&&file.startsWith(dir+"/");});
}
const packageName=spec=>{const parts=spec.split("/");return spec.startsWith("@")?parts.slice(0,2).join("/"):parts[0];};

/** Static import inventory of one source text. Relative specifiers become
 * pinned helper candidates; bare specifiers are third-party dependencies that
 * the isolated check cannot supply itself. Builtins and URLs are neither. */
function scanImports(text){
  const relative=new Set(),bare=new Set();
  for(const match of String(text).matchAll(PATTERN)){
    const spec=match[2];
    if(spec==="."||spec===".."||spec.startsWith("./")||spec.startsWith("../")){relative.add(spec);continue;}
    if(/^(?:node:|#|[a-z][a-z0-9+.-]*:)/i.test(spec)||BUILTINS.has(spec))continue;
    const name=packageName(spec);
    if(PACKAGE.test(name))bare.add(name);
  }
  return {relative:[...relative].sort(),bare:[...bare].sort()};
}

/** Transitively resolve relative imports of the selected checks against the
 * immutable baseline tree. Test infrastructure is pinned from the same origin
 * as the checks and traversed further; code under test is only recorded.
 * `read(entry)` returns the entry's verified bytes. */
async function resolveCheckImports({entries,roots,read,limits=LIMITS,isHelper=isTestInfrastructure}){
  if(!(entries instanceof Map)||!Array.isArray(roots)||typeof read!=="function")throw fail("INVALID");
  const queue=[...roots],seen=new Set(roots),helpers=[],sourceImports=[],dependencies=new Set(),unresolved=[];let total=0;
  while(queue.length){
    const current=queue.shift(),entry=entries.get(current);
    if(!entry||!/\.(?:js|cjs|mjs)$/.test(current))continue;
    const {relative,bare}=scanImports((await read(entry)).toString("utf8"));
    for(const name of bare)dependencies.add(name);
    for(const spec of relative){
      const target=path.posix.normalize(path.posix.join(path.posix.dirname(current),spec));
      const found=target.startsWith("../")||target===".."?null:CANDIDATES.map(suffix=>target+suffix).find(candidate=>entries.has(candidate));
      if(!found){if(unresolved.length<limits.maxUnresolved)unresolved.push({from:current,specifier:spec});continue;}
      if(seen.has(found))continue;
      seen.add(found);
      const file=entries.get(found);
      if(!isHelper(found,roots)){if(sourceImports.length<limits.maxHelpers)sourceImports.push(file);continue;}
      if(helpers.length>=limits.maxHelpers||file.sizeBytes>limits.maxHelperBytes||(total+=file.sizeBytes)>limits.maxTotalBytes)throw fail("LIMIT");
      helpers.push(file);
      queue.push(found);
    }
  }
  const byPath=(a,b)=>a.path<b.path?-1:a.path>b.path?1:0;
  return {helpers:helpers.sort(byPath),sourceImports:sourceImports.sort(byPath),dependencies:[...dependencies].sort(),unresolved};
}
module.exports={scanImports,resolveCheckImports,isTestInfrastructure,CHECK_IMPORT_LIMITS:LIMITS};
