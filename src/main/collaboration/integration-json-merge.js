"use strict";
const {isDeepStrictEqual}=require("node:util");
const {decodeJsonBuffer}=require("../character-worlds/bounded-json");
const MAX_JSON_BYTES=256*1024;
const POLICY="json-object-v1";
const missing=Symbol("missing"),conflict=Symbol("conflict");
const object=value=>value!==null && typeof value==="object" && !Array.isArray(value);
function mergeValue(base,head,delivery){
  if(isDeepStrictEqual(head,delivery))return head;
  if(isDeepStrictEqual(base,head))return delivery;
  if(isDeepStrictEqual(base,delivery))return head;
  if(!object(base)||!object(head)||!object(delivery))return conflict;
  const result=Object.create(null);
  for(const key of [...new Set([...Object.keys(base),...Object.keys(head),...Object.keys(delivery)])].sort()){
    const value=mergeValue(...[base,head,delivery].map(item=>Object.hasOwn(item,key)?item[key]:missing));
    if(value===conflict)return conflict;
    if(value!==missing)result[key]=value;
  }
  return result;
}
/** Conservative object merge, not schema validation. Arrays stay atomic.
 * The existing bounded parser retains number lexemes; v1 only serializes safe
 * integer literals, so decimal/large-number precision can never be discarded. */
function mergeJson(base,head,delivery){
  let documents;
  try{
    documents=[base,head,delivery].map(bytes=>{
      if(!Buffer.isBuffer(bytes)||bytes.length>MAX_JSON_BYTES)throw Error("limit");
      const parsed=decodeJsonBuffer(bytes,{maxContainerBytes:MAX_JSON_BYTES,maxJsonBytes:MAX_JSON_BYTES,maxDepth:32});
      if(!object(parsed.data)||parsed.numberLexemes.some(({lexeme})=>! /^-?(0|[1-9][0-9]*)$/.test(lexeme)
        || !Number.isSafeInteger(Number(lexeme)) || Object.is(Number(lexeme),-0)))throw Error("unsupported");
      return parsed.data;
    });
  }catch{return {state:"unsupported"};}
  const value=mergeValue(...documents);
  if(value===conflict)return {state:"conflicts"};
  const text=JSON.stringify(value,null,2)+"\n";
  if(Buffer.byteLength(text)>MAX_JSON_BYTES)return {state:"unsupported"};
  return {state:"resolved",policy:POLICY,text};
}
module.exports={mergeJson,MAX_JSON_BYTES,POLICY};
