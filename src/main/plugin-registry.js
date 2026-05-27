"use strict";

/**
 * Static registry of all MCP plugins available in the marketplace.
 *
 * Each entry declares:
 *   - id / name / description / packageName   — display metadata
 *   - scopes         — where the plugin can be installed ("global", "workspace")
 *   - permissions    — human-readable permission list shown in the UI
 *   - server(workspace) — returns { command, args, env? } for the MCP process
 */
const PLUGIN_REGISTRY = [
  {
    id: "filesystem",
    name: "Filesystem",
    description: "允许 AI 读取当前工作区文件，用于代码理解和文件检查。",
    packageName: "@modelcontextprotocol/server-filesystem",
    scopes: ["workspace"],
    permissions: ["读取当前工作区目录"],
    server(workspace) {
      return {
        command: "npx",
        args: ["-y", this.packageName, workspace.path],
      };
    },
  },
  {
    id: "memory",
    name: "Memory",
    description: "给 AI 增加知识图谱记忆能力，适合跨对话保存事实。",
    packageName: "@modelcontextprotocol/server-memory",
    scopes: ["global", "workspace"],
    permissions: ["在本机保存和读取记忆数据"],
    server() {
      return { command: "npx", args: ["-y", this.packageName] };
    },
  },
  {
    id: "sequential-thinking",
    name: "Sequential Thinking",
    description: "提供分步推理工具，适合复杂分析、排查和规划。",
    packageName: "@modelcontextprotocol/server-sequential-thinking",
    scopes: ["global", "workspace"],
    permissions: ["本地推理工具，无外部账号要求"],
    server() {
      return { command: "npx", args: ["-y", this.packageName] };
    },
  },
  {
    id: "github",
    name: "GitHub",
    description: "通过 GitHub API 查询仓库、Issue、PR 和 CI 信息。",
    packageName: "@modelcontextprotocol/server-github",
    scopes: ["global", "workspace"],
    permissions: ["访问 GitHub API", "需要 GITHUB_PERSONAL_ACCESS_TOKEN 环境变量"],
    server() {
      return {
        command: "npx",
        args: ["-y", this.packageName],
        env: {
          GITHUB_PERSONAL_ACCESS_TOKEN:
            process.env.GITHUB_PERSONAL_ACCESS_TOKEN || "",
        },
      };
    },
  },
  {
    id: "brave-search",
    name: "Brave Search",
    description: "通过 Brave Search API 搜索公开互联网信息。",
    packageName: "@modelcontextprotocol/server-brave-search",
    scopes: ["global", "workspace"],
    permissions: ["访问 Brave Search API", "需要 BRAVE_API_KEY 环境变量"],
    server() {
      return {
        command: "npx",
        args: ["-y", this.packageName],
        env: { BRAVE_API_KEY: process.env.BRAVE_API_KEY || "" },
      };
    },
  },
  {
    id: "weather",
    name: "Weather",
    description:
      "通过 Open-Meteo 查询实时天气和天气预报，适合验证无密钥 MCP 插件流程。",
    packageName: "@rehmatalisayany/weather-mcp-server",
    scopes: ["global", "workspace"],
    permissions: ["访问 Open-Meteo 天气 API"],
    server() {
      return { command: "npx", args: ["-y", this.packageName] };
    },
  },
  {
    id: "everything",
    name: "Everything MCP",
    description: "MCP 协议测试服务，用来验证工具调用链路是否跑通。",
    packageName: "@modelcontextprotocol/server-everything",
    scopes: ["workspace"],
    permissions: ["本地测试工具"],
    server() {
      return { command: "npx", args: ["-y", this.packageName] };
    },
  },
];

function findById(pluginId) {
  return PLUGIN_REGISTRY.find((plugin) => plugin.id === pluginId) || null;
}

function listAll() {
  return PLUGIN_REGISTRY;
}

module.exports = { PLUGIN_REGISTRY, findById, listAll };
