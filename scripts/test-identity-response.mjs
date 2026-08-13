#!/usr/bin/env node
import assert from "node:assert/strict";
import { localIdentityAssistantResponse } from "../src/main/identity-response.js";

const answer = localIdentityAssistantResponse("你是 Kimi K3 吗？");
assert.match(answer, /Lily Workbench/);
assert.match(answer, /不以 Claude、Kimi 或其他底层模型名称对外自称/);
assert.equal(localIdentityAssistantResponse("你是谁？").includes("Lily Workbench"), true);
assert.equal(localIdentityAssistantResponse("你的底层模型是什么？").includes("设置 > 模型"), true);
assert.equal(localIdentityAssistantResponse("你是一个全栈工程师，帮我修复登录问题"), "");
assert.equal(localIdentityAssistantResponse("分析 Kimi K3 的 API 文档"), "");
assert.equal(localIdentityAssistantResponse("把 Claude 的登录方式写进说明"), "");

console.log("identity response: ok");
