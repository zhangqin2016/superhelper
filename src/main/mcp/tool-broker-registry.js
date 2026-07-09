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

const EXECUTION_SURFACES = {
  toolBroker: "tool_broker",
  mailMcp: "mail_mcp",
  learnedWebSystemMcp: "learned_web_system_mcp",
  browserRuntime: "browser_runtime",
  external: "external",
};

const MCP_SERVER_NAMES = {
  toolBroker: "lily_tool_broker",
  mail: "mail",
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

function missingSkillIds(context, skillIds) {
  const active = activeSkillSet(context);
  return (skillIds || []).filter((id) => !active.has(id));
}

function unavailableHandler(code) {
  const handler = async () => ({ ok: false, error: code });
  handler.unavailableCode = code;
  return handler;
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

function availabilityReason(context, tool) {
  if (!context?.sessionId && !(context?.platformOnly && isPlatformTool(tool))) return "SESSION_REQUIRED";
  if (!hasAllSkills(context, tool.requiredSkillIds)) return "SKILL_NOT_ACTIVE";
  if (typeof tool.isAvailable === "function" && !tool.isAvailable(context)) {
    if (tool.group === "mail") return "MAIL_BRIDGE_UNAVAILABLE";
    if (tool.group === "browser") return "BROWSER_RUNTIME_UNAVAILABLE";
    return "RUNTIME_UNAVAILABLE";
  }
  return "";
}

function executionSurfaceForTool(tool) {
  if (tool?.executionSurface) return tool.executionSurface;
  if (!tool?.handler?.unavailableCode) return EXECUTION_SURFACES.toolBroker;
  return EXECUTION_SURFACES.external;
}

function mcpServerNameForTool(tool) {
  if (tool?.mcpServerName) return tool.mcpServerName;
  const surface = executionSurfaceForTool(tool);
  if (surface === EXECUTION_SURFACES.toolBroker) return MCP_SERVER_NAMES.toolBroker;
  return "";
}

function serverNameForLearnedSystemDir(draftDir) {
  const base = path.basename(String(draftDir || "")).replace(/[^a-z0-9]+/gi, "_").toLowerCase();
  return `web_${base || "system"}`.slice(0, 64);
}

function describeToolAvailability(context, tool) {
  const reason = availabilityReason(context, tool);
  const requiresSession = !isPlatformTool(tool);
  const detail = {
    name: tool.name,
    group: tool.group,
    description: tool.description || "",
    requiredSkillIds: tool.requiredSkillIds || [],
    missingSkillIds: missingSkillIds(context, tool.requiredSkillIds),
    requiresSession,
    sessionAvailable: Boolean(context?.sessionId),
    readOnly: Boolean(tool.annotations?.readOnlyHint),
    destructive: Boolean(tool.annotations?.destructiveHint),
    brokerHandlerAvailable: !tool.handler?.unavailableCode,
    brokerHandlerError: tool.handler?.unavailableCode || "",
    executionSurface: executionSurfaceForTool(tool),
    mcpServerName: mcpServerNameForTool(tool),
    available: reason === "",
    reason,
  };
  if (tool.group === "mail") {
    detail.connectorStatusKey = "mailConnected";
    detail.connectorStatusValue = context?.connectorStatus?.mailConnected === true;
  }
  if (tool.group === "browser") {
    detail.runtimeStatusKey = "browserAvailable";
    detail.runtimeStatusValue = context?.runtime?.browserAvailable === true;
  }
  return detail;
}

function runtimePackStatusForSkills(skillGraph, installedPacks) {
  const { PACK_SPECS } = require("../runtime-pack-specs");
  const installed = new Set(installedPacks || []);
  const requiredByActiveSkills = [];
  const missing = [];
  for (const skill of Array.isArray(skillGraph) ? skillGraph : []) {
    const required = Array.isArray(skill?.requiredRuntimePacks)
      ? skill.requiredRuntimePacks.map(String).filter(Boolean)
      : [];
    if (!required.length) continue;
    const itemMissing = required.filter((id) => !installed.has(id));
    for (const id of itemMissing) {
      if (!missing.includes(id)) missing.push(id);
    }
    requiredByActiveSkills.push({
      skillId: skill.id,
      required,
      missing: itemMissing,
    });
  }
  return {
    requiredByActiveSkills,
    missing,
    missingDetails: missing.map((id) => {
      const spec = PACK_SPECS[id] || {};
      return {
        id,
        category: spec.category || "",
        label: spec.label || { en: id, "zh-CN": id, ar: id },
        description: spec.description || {},
        sizeEstimate: spec.sizeEstimate || "",
        installAction: {
          tool: "runtime_pack_install",
          args: { packId: id },
          destructive: true,
          requiresConfirmation: true,
        },
      };
    }),
  };
}

function resolveInstalledRuntimePackIds(deps = {}) {
  if (typeof deps.installedRuntimePackIds === "function") return deps.installedRuntimePackIds;
  return require("../runtime-pack-installer").installedRuntimePackIds;
}

const STATIC_TOOL_DEFINITIONS = [
  {
    id: "lily_capability_list",
    name: "lily_capability_list",
    group: "capabilities",
    requiredSkillIds: [],
    executionSurface: EXECUTION_SURFACES.toolBroker,
    mcpServerName: MCP_SERVER_NAMES.toolBroker,
    description: "List Lily platform capabilities available to this session, including skills, tools, runtime packs, and fail-open routes.",
    inputSchema: {
      query: z.string().optional().describe("optional user task/query to rank relevant capability skills"),
      files: z
        .array(z.object({
          name: z.string().optional(),
          path: z.string().optional(),
        }))
        .optional()
        .describe("optional referenced files for file-type-aware routing"),
    },
    annotations: { readOnlyHint: true },
    handler: async (args, context, deps = {}) => {
      const { listCapabilities, listSkillCapabilityGraph, recommendSkillCapabilityGraph } = require("../capability-broker");
      const focused = Boolean(args?.query || Array.isArray(args?.files));
      const skillGraph = focused
        ? recommendSkillCapabilityGraph({
          text: args?.query || "",
          files: args?.files || [],
          activeSkillIds: context?.activeSkillIds || [],
        })
        : listSkillCapabilityGraph();
      const installedPacks = focused ? [...resolveInstalledRuntimePackIds(deps)()].sort() : [];
      const recommendationRuntimePacks = focused
        ? runtimePackStatusForSkills(skillGraph, installedPacks)
        : { requiredByActiveSkills: [], missing: [], missingDetails: [] };
      const tools = allToolDefinitions(context, deps)
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
        skillGraph,
        runtimePacks: {
          evaluated: focused,
          installed: installedPacks,
          missing: recommendationRuntimePacks.missing,
          missingDetails: recommendationRuntimePacks.missingDetails,
          requiredByRecommendedSkills: recommendationRuntimePacks.requiredByActiveSkills,
          installToolAvailable: tools.some((tool) => tool.name === "runtime_pack_install"),
        },
        tools,
      };
    },
  },
  {
    id: "lily_capability_status",
    name: "lily_capability_status",
    group: "capabilities",
    requiredSkillIds: [],
    executionSurface: EXECUTION_SURFACES.toolBroker,
    mcpServerName: MCP_SERVER_NAMES.toolBroker,
    description: "Report session-scoped Lily capability status and explain which platform tools are available right now.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
    handler: async (_args, context, deps = {}) => {
      const { listSkillCapabilityGraph } = require("../capability-broker");
      const installedPacks = [...resolveInstalledRuntimePackIds(deps)()].sort();
      const active = activeSkillSet(context);
      const activeSkillGraph = listSkillCapabilityGraph().filter((skill) => active.has(skill.id));
      const runtimePackStatus = runtimePackStatusForSkills(activeSkillGraph, installedPacks);
      const toolDetails = allToolDefinitions(context, deps)
        .filter((tool) => tool.name !== "lily_capability_status")
        .map((tool) => describeToolAvailability(context, tool));
      const tools = toolDetails
        .filter((tool) => tool.available)
        .map((tool) => tool.name)
        .sort();
      return {
        ok: true,
        sessionId: context?.sessionId || "",
        permissionMode: context?.permissionMode || "",
        activeSkillIds: Array.isArray(context?.activeSkillIds) ? context.activeSkillIds : [],
        activeSkillGraph,
        connectorStatus: context?.connectorStatus || {},
        runtime: context?.runtime || {},
        runtimePacks: {
          evaluated: true,
          installed: installedPacks,
          missing: runtimePackStatus.missing,
          missingDetails: runtimePackStatus.missingDetails,
          requiredByActiveSkills: runtimePackStatus.requiredByActiveSkills,
          installToolAvailable: tools.includes("runtime_pack_install"),
        },
        tools,
        toolDetails,
        unavailableTools: toolDetails.filter((tool) => !tool.available),
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
    executionSurface: EXECUTION_SURFACES.mailMcp,
    mcpServerName: MCP_SERVER_NAMES.mail,
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
    executionSurface: EXECUTION_SURFACES.mailMcp,
    mcpServerName: MCP_SERVER_NAMES.mail,
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
    executionSurface: EXECUTION_SURFACES.mailMcp,
    mcpServerName: MCP_SERVER_NAMES.mail,
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
    executionSurface: EXECUTION_SURFACES.mailMcp,
    mcpServerName: MCP_SERVER_NAMES.mail,
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
    executionSurface: EXECUTION_SURFACES.toolBroker,
    mcpServerName: MCP_SERVER_NAMES.toolBroker,
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
    executionSurface: EXECUTION_SURFACES.toolBroker,
    mcpServerName: MCP_SERVER_NAMES.toolBroker,
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
    executionSurface: EXECUTION_SURFACES.browserRuntime,
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
        executionSurface: EXECUTION_SURFACES.learnedWebSystemMcp,
        mcpServerName: serverNameForLearnedSystemDir(draftDir),
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

function allToolDefinitions(context, deps = {}) {
  return [...STATIC_TOOL_DEFINITIONS, ...learnedWebSystemTools(context || {}, deps)];
}

function toolAllowed(context, tool) {
  return availabilityReason(context, tool) === "";
}

function buildBrokerTools(context, deps = {}) {
  if (!context || context.ok === false) return [];
  return allToolDefinitions(context, deps)
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
