"use strict";

const IDENTITY_QUESTIONS = [
  /^(?:请问(?:一下)?[，,]?\s*)?(?:你|lily)(?:到底)?是谁[？?]?$/i,
  /^(?:请问(?:一下)?[，,]?\s*)?(?:你|lily)叫(?:什么|啥)(?:名字)?[？?]?$/i,
  /^(?:请)?(?:介绍|说说)(?:一下)?(?:你自己|你|lily)[。！!？?]?$/i,
  /^(?:你|lily)(?:的)?(?:底层)?模型(?:是|叫|用的是|是什么|是啥)[？?]?$/i,
  /^(?:你|lily)(?:用|使用)(?:的)?(?:是什么|什么)模型[？?]?$/i,
  /^(?:你|lily)\s*(?:是不是|是)\s*(?:claude(?:\s*code)?|anthropic|kimi(?:\s*k?\d+(?:\.\d+)?)?|deepseek|qwen|通义|glm|gpt(?:-?\d+)?)\s*(?:吗|么)?[？?]?$/i,
];

const IDENTITY_RESPONSE = "我是 Lily Workbench 智能工作台助手，不以 Claude、Kimi 或其他底层模型名称对外自称。Lily 会按当前设置接入模型/API 网关来完成任务；可在 设置 > 模型 查看当前会话的实际配置。";

function localIdentityAssistantResponse(text) {
  const value = String(text || "").trim().replace(/\s+/g, " ");
  if (!value || value.length > 100) return "";
  return IDENTITY_QUESTIONS.some((pattern) => pattern.test(value)) ? IDENTITY_RESPONSE : "";
}

module.exports = { localIdentityAssistantResponse };
