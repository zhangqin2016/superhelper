"use strict";

/**
 * Session-scoped broker registry for Lily extension tools.
 *
 * This module is deliberately pure: given a resolved session context it returns
 * exactly the Lily tools that are visible to that session. OpenCode native tools
 * are not represented here.
 */

const fs = require("node:fs");
const path = require("node:path");
const { z } = require("zod");
const { buildSystemTools } = require("./web-system-mcp");

const SKILLS = {
  mail: "lily-mail-assistant",
  browser: "lily-browser-qa",
  runtimePacks: "lily-runtime-packs",
};

function asTextJson(value) {
  return {
    content: [{
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value),
    }],
  };
}

function activeSkillSet(context) {
  return new Set((Array.isArray(context?.activeSkillIds) ? context.activeSkillIds : [])
    .map((id) => String(id || "").trim())
    .filter(Boolean));
}

function hasAllSkills(context, skillIds) {
  const active = activeSkillSet(context);
  return (skillIds || []).every((id) => active.has(id));
}

function unavailableHandler(code) {
  return async () => ({ ok: false, error: code });
}

function mailAvailable(context) {
  return context?.connectorStatus?.mailConnected === true;
}

function browserAvailable(context) {
  return context?.runtime?.browserAvailable === true;
}

function isPlatformTool(tool) {
  return (
    Array.isArray(tool?.requiredSkillIds) &&
    tool.requiredSkillIds.length === 0 &&
    (tool.group === "capabilities" || tool.group === "runtime-packs")
  );
}

const STATIC_TOOL_DEFINITIONS = [
  {
    id: "lily_capability_list",
    name: "lily_capability_list",
    group: "capabilities",
    requiredSkillIds: [],
    description: "List Lily platform capabilities available to this session, including skills, tools, runtime packs, and fail-open routes.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
    handler: async (_args, context) => {
      const { listCapabilities } = require("../capability-broker");
      const tools = STATIC_TOOL_DEFINITIONS
        .filter((tool) => tool.name !== "lily_capability_list" && tool.name !== "lily_capability_status")
        .filter((tool) => toolAllowed(context, tool))
        .map((tool) => ({
          name: tool.name,
          group: tool.group,
          requiredSkillIds: tool.requiredSkillIds || [],
          readOnly: Boolean(tool.annotations?.readOnlyHint),
          destructive: Boolean(tool.annotations?.destructiveHint),
        }));
      return {
        ok: true,
        sessionId: context?.sessionId || "",
        activeSkillIds: Array.isArray(context?.activeSkillIds) ? context.activeSkillIds : [],
        capabilities: listCapabilities(),
        tools,
      };
    },
  },
  {
    id: "lily_capability_status",
    name: "lily_capability_status",
    group: "capabilities",
    requiredSkillIds: [],
    description: "Report session-scoped Lily capability status and explain which platform tools are available right now.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
    handler: async (_args, context) => {
      const { installedRuntimePackIds } = require("../runtime-pack-installer");
      const installedPacks = [...installedRuntimePackIds()].sort();
      const tools = STATIC_TOOL_DEFINITIONS
        .filter((tool) => tool.name !== "lily_capability_status")
        .filter((tool) => toolAllowed(context, tool))
        .map((tool) => tool.name)
        .sort();
      return {
        ok: true,
        sessionId: context?.sessionId || "",
        permissionMode: context?.permissionMode || "",
        activeSkillIds: Array.isArray(context?.activeSkillIds) ? context.activeSkillIds : [],
        connectorStatus: context?.connectorStatus || {},
        runtime: context?.runtime || {},
        runtimePacks: {
          installed: installedPacks,
          installToolAvailable: tools.includes("runtime_pack_install"),
        },
        tools,
        policy: {
          dependencyInstall: "session_auto_with_confirmation",
          failOpen: true,
          nativeOpenCodeSkills: "not_user_facing",
        },
      };
    },
  },
  {
    id: "mail_list_accounts",
    name: "mail_list_accounts",
    group: "mail",
    requiredSkillIds: [SKILLS.mail],
    description: "List connected mail accounts available in this session.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
    isAvailable: mailAvailable,
    handler: unavailableHandler("MAIL_BRIDGE_UNAVAILABLE"),
  },
  {
    id: "mail_search",
    name: "mail_search",
    group: "mail",
    requiredSkillIds: [SKILLS.mail],
    description: "Search a connected mailbox and return recent message envelopes.",
    inputSchema: {
      accountId: z.string().describe("account id from mail_list_accounts"),
      subject: z.string().optional().describe("filter: subject contains"),
      from: z.string().optional().describe("filter: sender contains"),
      unread: z.boolean().optional().describe("only unread messages"),
      limit: z.number().int().min(1).max(50).optional().describe("max results"),
      mailbox: z.string().optional().describe("mailbox/folder, default INBOX"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    isAvailable: mailAvailable,
    handler: unavailableHandler("MAIL_BRIDGE_UNAVAILABLE"),
  },
  {
    id: "mail_read",
    name: "mail_read",
    group: "mail",
    requiredSkillIds: [SKILLS.mail],
    description: "Read a single message by uid from a connected mailbox.",
    inputSchema: {
      accountId: z.string().describe("account id from mail_list_accounts"),
      uid: z.number().int().describe("message uid from mail_search"),
      mailbox: z.string().optional().describe("mailbox/folder, default INBOX"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    isAvailable: mailAvailable,
    handler: unavailableHandler("MAIL_BRIDGE_UNAVAILABLE"),
  },
  {
    id: "mail_send",
    name: "mail_send",
    group: "mail",
    requiredSkillIds: [SKILLS.mail],
    description: "Send an email from a connected account after host confirmation.",
    inputSchema: {
      accountId: z.string().describe("account id from mail_list_accounts"),
      to: z.string().describe("recipient(s), comma-separated"),
      cc: z.string().optional().describe("cc recipient(s), comma-separated"),
      bcc: z.string().optional().describe("bcc recipient(s), comma-separated"),
      subject: z.string(),
      text: z.string().describe("plain-text body"),
      html: z.string().optional().describe("optional HTML body"),
      attachments: z
        .array(z.object({
          path: z.string().describe("absolute local file path to attach"),
          filename: z.string().optional().describe("display name"),
        }))
        .optional(),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    isAvailable: mailAvailable,
    handler: unavailableHandler("MAIL_BRIDGE_UNAVAILABLE"),
  },
  {
    id: "runtime_pack_list",
    name: "runtime_pack_list",
    group: "runtime-packs",
    requiredSkillIds: [],
    description: "List optional Lily dependency packs and their installed status.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
    handler: async () => {
      const { PACK_SPECS } = require("../runtime-pack-specs");
      const { installedRuntimePackIds } = require("../runtime-pack-installer");
      const installed = installedRuntimePackIds();
      return {
        ok: true,
        packs: Object.values(PACK_SPECS).map((pack) => ({
          id: pack.id,
          label: pack.label,
          description: pack.description,
          sizeEstimate: pack.sizeEstimate,
          installed: installed.has(pack.id),
        })),
      };
    },
  },
  {
    id: "runtime_pack_install",
    name: "runtime_pack_install",
    group: "runtime-packs",
    requiredSkillIds: [],
    description: "Install an optional Lily dependency pack from the server-resolved artifact URL.",
    inputSchema: {
      packId: z.string().describe("dependency pack id, for example pro-pdf"),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    handler: async ({ packId }) => require("../runtime-pack-installer").installRuntimePack(packId),
  },
  {
    id: "browser_open",
    name: "browser_open",
    group: "browser",
    requiredSkillIds: [SKILLS.browser],
    description: "Open a URL in the broker-managed browser runtime.",
    inputSchema: {
      url: z.string().describe("URL to open"),
    },
    annotations: { openWorldHint: true },
    isAvailable: browserAvailable,
    handler: unavailableHandler("BROWSER_RUNTIME_UNAVAILABLE"),
  },
];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function learnedWebSystemTools(context, deps = {}) {
  const dirs = typeof deps.learnedWebSystemDirs === "function"
    ? deps.learnedWebSystemDirs(context.activeSkillIds)
    : require("../mcp-config").learnedWebSystemDirs(context.activeSkillIds);
  const tools = [];
  for (const draftDir of Array.isArray(dirs) ? dirs : []) {
    const capabilityMap = readJson(path.join(draftDir, "capability-map.json"));
    if (!capabilityMap || !Array.isArray(capabilityMap.capabilities)) continue;
    const systemId = capabilityMap.systemId || path.basename(draftDir);
    const systemName = capabilityMap.systemName || systemId;
    for (const tool of buildSystemTools(systemId, systemName, capabilityMap.capabilities)) {
      if (!tool.name || !tool.capabilityId) continue;
      tools.push({
        id: tool.name,
        name: tool.name,
        group: "learned-web-system",
        learnedSystemDir: draftDir,
        capabilityId: tool.capabilityId,
        requiredSkillIds: [path.basename(draftDir)],
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
        handler: unavailableHandler("LEARNED_WEB_SYSTEM_BROKER_HANDLER_NOT_WIRED"),
      });
    }
  }
  return tools;
}

function toolAllowed(context, tool) {
  if (!context?.sessionId && !(context?.platformOnly && isPlatformTool(tool))) return false;
  if (!hasAllSkills(context, tool.requiredSkillIds)) return false;
  if (typeof tool.isAvailable === "function" && !tool.isAvailable(context)) return false;
  return true;
}

function buildBrokerTools(context, deps = {}) {
  if (!context || context.ok === false) return [];
  return [...STATIC_TOOL_DEFINITIONS, ...learnedWebSystemTools(context, deps)]
    .filter((tool) => toolAllowed(context, tool));
}

function findBrokerTool(context, toolName, deps = {}) {
  return buildBrokerTools(context, deps).find((tool) => tool.name === toolName || tool.id === toolName) || null;
}

module.exports = {
  SKILLS,
  STATIC_TOOL_DEFINITIONS,
  asTextJson,
  buildBrokerTools,
  findBrokerTool,
  toolAllowed,
};
