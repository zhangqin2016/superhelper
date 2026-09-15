"use client";

import { useActionState, useMemo, useState } from "react";
import { saveAgentPackageAction } from "../app/admin/actions";
import { CheckboxField, SubmitButton } from "./admin-forms";
import { useI18n } from "../lib/use-i18n";

const initialState = { ok: null, message: "", field: null, issues: [] };

// 傻瓜式 copy: say what each field does for the operator, not what it is called
// in the schema. zh-CN primary, en fallback.
const COPY = {
  zh: {
    title: "发布智能体",
    editTitle: "编辑智能体发布",
    desc: "把一份智能体定义（JSON）发布给客户端。定义会按客户端同一套规则校验；不通过会按字段指出问题。",
    agentId: "智能体 ID",
    agentIdHelp: "客户端识别用的稳定 ID，例如 legal-counsel。同一 ID 的新版本会自动覆盖旧版本在注册表里的位置。",
    version: "版本号",
    channel: "渠道",
    channelHelp: "客户端按渠道拉取；stable 是所有人默认看到的。",
    scope: "发布范围",
    scopeGlobal: "全局：所有客户端",
    scopeOrg: "组织：只有该企业成员能收到",
    organizationId: "组织 ID",
    organizationIdHelp: "在「企业」页面可以查到组织 ID（org_ 开头）。",
    publisher: "发布方",
    minAppVersion: "最低客户端版本",
    minAppVersionHelp: "留空＝不限制。",
    definition: "智能体定义（JSON）",
    definitionHelp: "至少填 name、description 和一个维度（role / skills / knowledge / autonomy / model / tools / automations）。角色只能用 role.officialCharacterId，或在下方嵌入角色卡。",
    roleCard: "嵌入角色卡（可选，JSON）",
    roleCardHelp: "形如 {\"canonical\": {...}}。填了它就不要再填 role.officialCharacterId。",
    featured: "精选（客户端置顶）",
    hideFromCatalog: "不在目录展示（只允许被配置引用）",
    disabled: "先停用（发布但不下发）",
    submit: "保存并发布",
    saving: "保存中…",
    jsonOk: "JSON 语法正确",
    jsonBad: "JSON 语法有误：",
    issuesTitle: "服务器校验未通过，请修正以下字段：",
    fieldPrefix: "字段",
    template: "填入示例",
  },
  en: {
    title: "Publish an agent",
    editTitle: "Edit agent publication",
    desc: "Publish an agent definition (JSON) to clients. It is validated with the same rules the desktop client uses; failures are reported by field.",
    agentId: "Agent ID",
    agentIdHelp: "Stable id clients key on, e.g. legal-counsel. A newer version of the same id replaces the older one in the registry.",
    version: "Version",
    channel: "Channel",
    channelHelp: "Clients pull by channel; stable is what everyone sees by default.",
    scope: "Scope",
    scopeGlobal: "Global: every client",
    scopeOrg: "Organization: only that organization's members",
    organizationId: "Organization ID",
    organizationIdHelp: "Find it on the Enterprise page (starts with org_).",
    publisher: "Publisher",
    minAppVersion: "Minimum app version",
    minAppVersionHelp: "Empty = no restriction.",
    definition: "Agent definition (JSON)",
    definitionHelp: "At least name, description and one dimension (role / skills / knowledge / autonomy / model / tools / automations). Roles may only use role.officialCharacterId, or embed a role card below.",
    roleCard: "Embedded role card (optional, JSON)",
    roleCardHelp: "Shape: {\"canonical\": {...}}. When set, leave role.officialCharacterId empty.",
    featured: "Featured (pinned in the client)",
    hideFromCatalog: "Hide from catalog (only reachable via config)",
    disabled: "Start disabled (publish without delivering)",
    submit: "Save and publish",
    saving: "Saving…",
    jsonOk: "Valid JSON",
    jsonBad: "Invalid JSON: ",
    issuesTitle: "Server validation failed — fix these fields:",
    fieldPrefix: "Field",
    template: "Insert example",
  },
};

const EXAMPLE_DEFINITION = {
  schemaVersion: 1,
  name: "合同审查助手",
  description: "审查合同风险条款，输出修改建议。",
  icon: "📄",
  tags: ["legal"],
  role: { officialCharacterId: "legal-counsel" },
  starters: ["帮我审这份合同", "列出高风险条款"],
  skills: { required: ["lily-office-docs"], enabled: [] },
  knowledge: { packs: [], guidance: "" },
  model: { presetId: "inherit" },
  tools: { mcpAllow: [], connectors: [], disallow: [] },
  autonomy: { permissionModeId: "ask" },
  automations: [],
};

function jsonStatus(text) {
  if (!text.trim()) return { state: "empty" };
  try {
    const parsed = JSON.parse(text);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return { state: "bad", message: "must be an object" };
    return { state: "ok" };
  } catch (error) {
    return { state: "bad", message: error instanceof Error ? error.message : "invalid" };
  }
}

function fieldClass(highlight) {
  return `w-full rounded-lg border px-3 py-2 text-sm ${highlight ? "border-red-400 bg-red-50" : "border-slate-200 bg-white"}`;
}

function Label({ children, help }) {
  return (
    <span className="mb-1 block">
      <span className="text-sm font-medium text-slate-700">{children}</span>
      {help ? <span className="mt-0.5 block text-xs text-slate-500">{help}</span> : null}
    </span>
  );
}

function pretty(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

// `initial` = an agent_packages row when editing; the upsert keys on
// (agentId, version, channel, scope) so re-saving updates in place.
export function AgentPackageForm({ initial = null }) {
  const [state, action, pending] = useActionState(saveAgentPackageAction, initialState);
  const { locale } = useI18n();
  const copy = COPY[locale] || COPY.en;
  const [scopeType, setScopeType] = useState(initial?.scope_type || "global");
  const [definitionText, setDefinitionText] = useState(() => pretty(initial?.definition));
  const [roleCardText, setRoleCardText] = useState(() => pretty(initial?.role_card));
  const definitionStatus = useMemo(() => jsonStatus(definitionText), [definitionText]);
  const roleCardStatus = useMemo(() => jsonStatus(roleCardText), [roleCardText]);
  const issues = state?.issues || [];
  const issueFields = new Set([...(state?.field ? [state.field] : []), ...issues.map((issue) => issue.field)]);
  const touches = (prefix) => [...issueFields].some((field) => field === prefix || String(field).startsWith(`${prefix}.`) || String(field).startsWith(`${prefix}[`));
  const definitionTouched = state?.ok === false && (issueFields.size === 0 || [...issueFields].some((field) => !["agentId", "version", "channel", "scopeType", "organizationId", "publisher", "minAppVersion", "roleCard"].includes(field) && !String(field).startsWith("roleCard")));

  return (
    <div className="table-card mb-6 p-6">
      <h2 className="mb-2 text-xl font-semibold">{initial ? copy.editTitle : copy.title}</h2>
      <p className="mb-5 text-sm text-slate-500">{copy.desc}</p>
      <form action={action} className="grid gap-4 lg:grid-cols-6">
        <label className="lg:col-span-2">
          <Label help={copy.agentIdHelp}>{copy.agentId}</Label>
          <input className={fieldClass(touches("agentId"))} name="agentId" defaultValue={initial?.agent_id || ""} placeholder="legal-counsel" required readOnly={Boolean(initial)} />
        </label>
        <label>
          <Label>{copy.version}</Label>
          <input className={fieldClass(touches("version"))} name="version" defaultValue={initial?.version || "1.0.0"} required />
        </label>
        <label>
          <Label help={copy.channelHelp}>{copy.channel}</Label>
          <select className={fieldClass(touches("channel"))} name="channel" defaultValue={initial?.channel || "stable"}>
            <option value="stable">stable</option>
            <option value="beta">beta</option>
            <option value="experimental">experimental</option>
          </select>
        </label>
        <label className="lg:col-span-2">
          <Label>{copy.scope}</Label>
          <select className={fieldClass(touches("scopeType"))} name="scopeType" value={scopeType} onChange={(event) => setScopeType(event.target.value)}>
            <option value="global">{copy.scopeGlobal}</option>
            <option value="organization">{copy.scopeOrg}</option>
          </select>
        </label>
        {scopeType === "organization" ? (
          <label className="lg:col-span-2">
            <Label help={copy.organizationIdHelp}>{copy.organizationId}</Label>
            <input className={fieldClass(touches("organizationId"))} name="organizationId" defaultValue={initial?.organization_id || ""} placeholder="org_xxxxxxxxxxxxxx" required />
          </label>
        ) : null}
        <label className="lg:col-span-2">
          <Label>{copy.publisher}</Label>
          <input className={fieldClass(touches("publisher"))} name="publisher" defaultValue={initial?.publisher || "Lily Workbench"} />
        </label>
        <label className="lg:col-span-2">
          <Label help={copy.minAppVersionHelp}>{copy.minAppVersion}</Label>
          <input className={fieldClass(touches("minAppVersion"))} name="minAppVersion" defaultValue={initial?.min_app_version || ""} placeholder="0.1.180" />
        </label>

        <label className="lg:col-span-6">
          <div className="flex items-start justify-between gap-3">
            <Label help={copy.definitionHelp}>{copy.definition}</Label>
            <button type="button" className="shrink-0 text-xs font-semibold text-brand" onClick={() => setDefinitionText(JSON.stringify(EXAMPLE_DEFINITION, null, 2))}>
              {copy.template}
            </button>
          </div>
          <textarea
            className={`${fieldClass(definitionTouched || definitionStatus.state === "bad")} font-mono text-xs`}
            name="definition"
            rows={18}
            spellCheck={false}
            value={definitionText}
            onChange={(event) => setDefinitionText(event.target.value)}
            required
          />
          <span className={`mt-1 block text-xs ${definitionStatus.state === "bad" ? "text-red-700" : "text-emerald-700"}`}>
            {definitionStatus.state === "bad" ? `${copy.jsonBad}${definitionStatus.message}` : definitionStatus.state === "ok" ? copy.jsonOk : ""}
          </span>
        </label>

        <label className="lg:col-span-6">
          <Label help={copy.roleCardHelp}>{copy.roleCard}</Label>
          <textarea
            className={`${fieldClass(touches("roleCard") || roleCardStatus.state === "bad")} font-mono text-xs`}
            name="roleCard"
            rows={6}
            spellCheck={false}
            value={roleCardText}
            onChange={(event) => setRoleCardText(event.target.value)}
          />
          {roleCardStatus.state === "bad" ? <span className="mt-1 block text-xs text-red-700">{copy.jsonBad}{roleCardStatus.message}</span> : null}
        </label>

        <div className="flex items-end lg:col-span-2">
          <CheckboxField label={copy.featured} name="featured" />
        </div>
        <div className="flex items-end lg:col-span-2">
          <CheckboxField label={copy.hideFromCatalog} name="hideFromCatalog" />
        </div>
        <div className="flex items-end">
          <CheckboxField label={copy.disabled} name="disabled" />
        </div>
        <div className="flex items-end">
          <SubmitButton disabled={pending || definitionStatus.state !== "ok" || roleCardStatus.state === "bad"}>{pending ? copy.saving : copy.submit}</SubmitButton>
        </div>
      </form>

      {state?.message ? (
        <div className={`mt-4 rounded-lg px-4 py-3 text-sm ${state.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800"}`}>
          <div>{state.message}{state.field ? ` (${copy.fieldPrefix}: ${state.field})` : ""}{state.code && !state.ok ? <span className="ml-2 font-mono text-xs opacity-70">{state.code}</span> : null}</div>
          {issues.length ? (
            <div className="mt-2">
              <div className="font-semibold">{copy.issuesTitle}</div>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {issues.map((issue, index) => (
                  <li key={`${issue.field}-${index}`}>
                    <span className="font-mono text-xs">{issue.field}</span> — {issue.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
