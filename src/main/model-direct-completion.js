"use strict";
const {createHash}=require("node:crypto");
const DEFAULT_TIMEOUT_MS=90_000;

/** One bounded, non-streaming completion against the user's configured model
 * endpoint. Used for isolated main-process work (conflict repair) that must
 * not retarget a session's foreground engine. Returns text plus request/response
 * hashes for evidence; never throws on transport failure. */
// Absolute endpoints resolve without the desktop service settings so the
// module also works in plain Node; relative ones defer to the shared resolver.
function resolveRequest(baseUrl,protocol,draft){
  const raw=String(baseUrl||"").trim(),kind=String(protocol||"").toLowerCase()==="openai"?"openai":"anthropic";
  if(!/^https?:\/\//i.test(raw))return draft.resolveModelRequest({baseUrl:raw,protocol:kind});
  const clean=raw.replace(/\/+$/,"");
  if(kind==="openai")return {protocol:kind,url:/\/chat\/completions$/i.test(clean)?clean:`${clean}/chat/completions`};
  return {protocol:kind,url:/\/v1\/messages$/i.test(clean)?clean:/\/v1$/i.test(clean)?`${clean}/messages`:`${clean}/v1/messages`};
}
function createDirectCompletion({env=null,fetchImpl=globalThis.fetch,now=()=>new Date().toISOString()}={}){
  const draft=require("./scheduled-task-ai-draft");
  const resolved=env||draft.buildLilyEnv();
  const baseUrl=resolved.LILY_OPENCODE_BASE_URL||resolved.LILY_API_BASE_URL;
  const {detectProtocol}=require("./runtime/opencode-model-config");
  const protocol=detectProtocol(baseUrl,resolved);
  const request=resolveRequest(baseUrl,protocol,draft);
  const apiKey=String(resolved.LILY_API_KEY||"").trim();
  const model=draft.modelIdFromEnv(resolved,protocol);
  const available=Boolean(request.url&&apiKey&&model&&!apiKey.startsWith("$"));
  let host="";try{host=new URL(request.url).host;}catch{}
  async function complete({system,user,maxTokens=4000,timeoutMs=DEFAULT_TIMEOUT_MS}){
    if(!available)return {ok:false,error:"MODEL_NOT_CONFIGURED"};
    if(typeof system!=="string"||typeof user!=="string"||!user)return {ok:false,error:"MODEL_REQUEST_INVALID"};
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    const requestHash=createHash("sha256").update(JSON.stringify({model,system,user})).digest("hex");
    try{
      let json;
      if(request.protocol==="openai"){
        const shapes=require("./openai-request-shape");
        const sent=await shapes.sendChatCompletion({url:request.url,headers:{authorization:`Bearer ${apiKey}`},
          body:{model,messages:[{role:"system",content:system},{role:"user",content:user}]},maxTokens,temperature:0,
          shape:shapes.recallShape(request.url,model,shapes.shapeFromEnv(resolved)),signal:controller.signal,fetchFn:fetchImpl,
          onAdapt:shape=>shapes.rememberShape(request.url,model,shape)});
        if(!sent.ok)return {ok:false,error:"MODEL_REQUEST_FAILED",status:sent.status,detail:String(sent.error?.message||"").slice(0,500),requestHash};
        json=sent.json;
      }else{
        const response=await fetchImpl(request.url,{method:"POST",signal:controller.signal,
          headers:{"Content-Type":"application/json","x-api-key":apiKey,authorization:`Bearer ${apiKey}`,"anthropic-version":"2023-06-01"},
          body:JSON.stringify({model,max_tokens:maxTokens,temperature:0,system,messages:[{role:"user",content:user}]})});
        json=await response.json().catch(()=>({}));
        if(!response.ok)return {ok:false,error:"MODEL_REQUEST_FAILED",status:response.status,detail:String(json?.error?.message||json?.message||"").slice(0,500),requestHash};
      }
      const text=draft.extractText(json);
      if(typeof text!=="string"||!text)return {ok:false,error:"MODEL_RESPONSE_EMPTY",requestHash};
      return {ok:true,text,model,provider:host,protocol:request.protocol,requestHash,responseHash:createHash("sha256").update(text).digest("hex"),at:now()};
    }catch(error){
      return {ok:false,error:controller.signal.aborted?"MODEL_TIMEOUT":"MODEL_REQUEST_FAILED",detail:String(error?.message||error).slice(0,500),requestHash};
    }finally{clearTimeout(timer);}
  }
  return Object.freeze({available,model,protocol:request.protocol,provider:host,complete});
}
module.exports={createDirectCompletion};
