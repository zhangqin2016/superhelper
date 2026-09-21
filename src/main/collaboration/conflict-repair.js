"use strict";
const {createHash}=require("node:crypto");
const {parseJsonObject}=require("../scheduled-task-ai-draft");
const POLICY="model-repair-v1";
const LIMITS=Object.freeze({maxFiles:16,maxFileBytes:128*1024,maxTotalBytes:1024*1024,maxQuestions:8,maxQuestionChars:500,maxOutputRatio:3});
const MARKER=/^(?:<{7}|={7}|>{7}|\|{7})(?: |$)/m;
const hash=value=>createHash("sha256").update(typeof value==="string"?value:JSON.stringify(value)).digest("hex");
const fail=code=>Object.assign(Error(`COLLAB_REPAIR_${code}`),{code:`COLLAB_REPAIR_${code}`});
function text(bytes){
  if(bytes===null||bytes===undefined)return null;
  if(bytes.includes(0))return undefined;
  try{return new TextDecoder("utf-8",{fatal:true}).decode(bytes);}catch{return undefined;}
}
const SYSTEM=[
  "You resolve merge conflicts and check failures for a collaborative task. You never decide business rules yourself.",
  "Rules:",
  "1. Return ONLY a JSON object: {\"files\":{\"<path>\":\"<complete new file content>\"},\"questions\":[{\"path\":\"<path>\",\"question\":\"<one concrete question>\"}]}.",
  "2. Keep the intent of BOTH sides wherever the goal and evidence make the correct result clear. Do not average numbers, prefer recency, or invent policy.",
  "3. When a file needs a business decision you cannot derive from the goal, acceptance criteria or answers, put that file in `questions` with ONE precise question and leave it out of `files`.",
  "4. Never emit conflict markers, placeholders or partial files. Each entry in `files` is the full final content.",
  "5. Never weaken, delete or skip existing checks or tests. Fix the code under test, not the test.",
  "6. Only paths listed in the request may appear in `files` or `questions`.",
].join("\n");
function section(title,value){return value?`\n## ${title}\n${value}\n`:"";}
function describe(file){
  const parts=[`### ${file.path}`];
  for(const [label,key] of [["Base (common ancestor)","base"],["Ours (shared history H)","ours"],["Theirs (delivered contribution D)","theirs"],["Current candidate","current"],["Three-way merge with conflict markers","merged"]])
    if(typeof file[key]==="string")parts.push(`<${key}>\n${file[key]}\n</${key}> ${label}`);
  return parts.join("\n");
}

/** Bounded, evidence-recording model repair. Input bytes are supplied by the
 * caller from authenticated snapshots; output is only accepted for requested
 * paths, as complete marker-free text within size bounds. Everything else is a
 * question for a person or an unresolved path. Verification (syntax, pinned
 * checks) always happens afterwards in the existing validation gate. */
function createConflictRepair({complete,limits=LIMITS}={}){
  if(typeof complete!=="function")throw fail("CONFIG_INVALID");
  async function repair({kind="merge",goal={},files=[],answers=[],failures=null}){
    if(!["merge","check_failure"].includes(kind)||!Array.isArray(files))throw fail("INVALID");
    const requested=[],skipped=[];let total=0;
    for(const file of files){
      if(typeof file?.path!=="string"||requested.length>=limits.maxFiles){skipped.push({path:file?.path||null,reason:"limit"});continue;}
      const decoded={path:file.path};let size=0,bad=false;
      for(const key of ["base","ours","theirs","current","merged"]){
        if(file[key]===undefined||file[key]===null)continue;
        const value=text(file[key]);if(value===undefined){bad=true;break;}
        if(file[key].length>limits.maxFileBytes){bad=true;break;}
        decoded[key]=value;size+=file[key].length;
      }
      if(bad||total+size>limits.maxTotalBytes){skipped.push({path:file.path,reason:bad?"binary_or_large":"limit"});continue;}
      total+=size;requested.push(decoded);
    }
    const evidence={policy:POLICY,kind,requestedPaths:requested.map(file=>file.path),skippedPaths:skipped,resolvedPaths:[],questionPaths:[],model:null,promptHash:null,responseHash:null,error:null};
    if(!requested.length)return {state:"unavailable",resolutions:new Map(),questions:[],evidence:{...evidence,error:"NO_ELIGIBLE_FILES"}};
    const user=[
      `# Task goal\nTitle: ${String(goal.title||"").slice(0,200)}\nObjective: ${String(goal.objective||"").slice(0,4000)}\nAcceptance criteria: ${String(goal.acceptanceCriteria||"").slice(0,4000)}`,
      section("Answers already given by the requester",answers.filter(a=>a&&typeof a.answer==="string").map(a=>`- [${a.path||"general"}] Q: ${String(a.question||"").slice(0,500)} A: ${String(a.answer).slice(0,2000)}`).join("\n")),
      section("Failing checks",failures?JSON.stringify(failures).slice(0,8000):""),
      kind==="merge"?"\n# Conflicted files\nProduce the complete resolved content for every file you can resolve without inventing business rules.\n":"\n# Candidate files to fix\nThe pinned original checks failed on this candidate. Fix only these files so the original checks pass; never touch the checks.\n",
      ...requested.map(describe),
    ].join("\n");
    evidence.promptHash=hash({system:SYSTEM,user});
    const response=await complete({system:SYSTEM,user,maxTokens:Math.min(16000,Math.max(2000,Math.ceil(total/2)))});
    if(response?.ok!==true)return {state:"unavailable",resolutions:new Map(),questions:[],evidence:{...evidence,error:response?.error||"MODEL_UNAVAILABLE"}};
    evidence.model=`${response.provider||""}/${response.model||""}`;evidence.responseHash=response.responseHash||hash(response.text);
    const parsed=parseJsonObject(response.text);
    if(!parsed||typeof parsed!=="object")return {state:"invalid",resolutions:new Map(),questions:[],evidence:{...evidence,error:"RESPONSE_NOT_JSON"}};
    const allowed=new Set(requested.map(file=>file.path)),resolutions=new Map(),questions=[];
    for(const [name,content] of Object.entries(parsed.files||{})){
      if(!allowed.has(name)||typeof content!=="string"||MARKER.test(content))return {state:"invalid",resolutions:new Map(),questions:[],evidence:{...evidence,error:"RESOLUTION_INVALID",path:name}};
      const bytes=Buffer.from(content,"utf8"),reference=requested.find(file=>file.path===name);
      const inputSize=Math.max(1,...["base","ours","theirs","current"].map(key=>reference[key]?Buffer.byteLength(reference[key]):0));
      if(bytes.length>Math.max(limits.maxFileBytes,inputSize*limits.maxOutputRatio))return {state:"invalid",resolutions:new Map(),questions:[],evidence:{...evidence,error:"RESOLUTION_TOO_LARGE",path:name}};
      resolutions.set(name,bytes);
    }
    for(const item of Array.isArray(parsed.questions)?parsed.questions:[]){
      if(questions.length>=limits.maxQuestions)break;
      if(!item||!allowed.has(item.path)||typeof item.question!=="string"||!item.question.trim()||resolutions.has(item.path))continue;
      questions.push({path:item.path,question:item.question.trim().slice(0,limits.maxQuestionChars)});
    }
    evidence.resolvedPaths=[...resolutions.keys()].sort();evidence.questionPaths=questions.map(q=>q.path).sort();
    const state=resolutions.size===requested.length?"resolved":questions.length?"decision_required":resolutions.size?"partial":"invalid";
    return {state,resolutions,questions,evidence:{...evidence,...(state==="invalid"?{error:"NO_RESOLUTION"}:{})}};
  }
  return Object.freeze({repair});
}
module.exports={createConflictRepair,REPAIR_POLICY:POLICY,REPAIR_LIMITS:LIMITS};
