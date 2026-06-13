"use client";

import { useActionState, useMemo, useState } from "react";
import { createConfigProfileAction } from "../app/admin/actions";
import { CheckboxField, SubmitButton } from "./admin-forms";
import { useI18n } from "../lib/use-i18n";

const initialState = { ok: null, message: "" };

const providerTemplates = [
  {
    id: "deepseek-gateway",
    label: { zh: "DeepSeek", en: "DeepSeek", ar: "DeepSeek" },
    provider: "deepseek",
    route: "/llm/deepseek",
    description: {
      zh: "通过 Lily 服务端网关调用 DeepSeek，客户端只拿短期 token。",
      en: "Route DeepSeek through the Lily server gateway. Clients only receive short-lived tokens.",
      ar: "توجيه DeepSeek عبر بوابة Lily. يحصل العميل على رموز قصيرة فقط.",
    },
    model: "deepseek-v4-pro[1m]",
    fastModel: "deepseek-v4-flash",
    strongModel: "deepseek-v4-pro[1m]",
  },
  {
    id: "qwen-gateway",
    label: { zh: "Qwen / 阿里", en: "Qwen / Alibaba", ar: "Qwen / Alibaba" },
    provider: "dashscope",
    route: "/llm/dashscope",
    description: {
      zh: "通过 Lily 服务端网关调用阿里 DashScope 兼容接口。",
      en: "Route Alibaba DashScope-compatible models through the Lily server gateway.",
      ar: "توجيه نماذج DashScope المتوافقة عبر بوابة Lily.",
    },
    model: "qwen3-coder-plus",
    fastModel: "qwen3-coder-plus",
    strongModel: "qwen3-coder-plus",
  },
  {
    id: "kimi-gateway",
    label: { zh: "Kimi", en: "Kimi", ar: "Kimi" },
    provider: "kimi",
    route: "/llm/kimi",
    description: {
      zh: "通过 Lily 服务端网关调用 Moonshot/Kimi 兼容接口。",
      en: "Route Moonshot/Kimi-compatible models through the Lily server gateway.",
      ar: "توجيه نماذج Moonshot/Kimi المتوافقة عبر بوابة Lily.",
    },
    model: "kimi-k2.5",
    fastModel: "kimi-k2.5",
    strongModel: "kimi-k2.5",
  },
  {
    id: "glm-gateway",
    label: { zh: "GLM / 智谱", en: "GLM / Z.AI", ar: "GLM / Z.AI" },
    provider: "glm",
    route: "/llm/glm",
    description: {
      zh: "通过 Lily 服务端网关调用 Z.AI/GLM 兼容接口。",
      en: "Route Z.AI/GLM-compatible models through the Lily server gateway.",
      ar: "توجيه نماذج Z.AI/GLM المتوافقة عبر بوابة Lily.",
    },
    model: "glm-4.7",
    fastModel: "glm-4.5-air",
    strongModel: "glm-4.7",
  },
  {
    id: "litellm-gateway",
    label: { zh: "LiteLLM", en: "LiteLLM", ar: "LiteLLM" },
    provider: "litellm",
    route: "/llm/litellm",
    description: {
      zh: "由服务端 LiteLLM 继续路由到自建或 OpenAI-compatible 模型。",
      en: "Let server-side LiteLLM route to self-hosted or OpenAI-compatible models.",
      ar: "استخدم LiteLLM على الخادم للتوجيه إلى نماذج ذاتية أو متوافقة مع OpenAI.",
    },
    model: "local-qwen",
    fastModel: "local-qwen-fast",
    strongModel: "local-qwen-strong",
  },
  {
    id: "local-anthropic-gateway",
    label: { zh: "自建网关", en: "Self-hosted gateway", ar: "بوابة ذاتية" },
    provider: "local",
    route: "/llm/local",
    description: {
      zh: "通过 Lily 服务端连接客户自建 Anthropic-compatible 网关。",
      en: "Connect to a customer-hosted Anthropic-compatible gateway through Lily.",
      ar: "الاتصال ببوابة متوافقة مع Anthropic مستضافة لدى العميل عبر Lily.",
    },
    model: "local-qwen",
    fastModel: "local-qwen",
    strongModel: "local-qwen",
  },
  {
    id: "custom-direct",
    label: { zh: "客户端直连", en: "Client direct", ar: "اتصال مباشر" },
    provider: "",
    route: "https://api.example.com/v1/messages",
    description: {
      zh: "不走 Lily 服务端，客户端使用本地或下发的直连接口配置。",
      en: "Bypass Lily. The client uses local or delivered direct endpoint settings.",
      ar: "تجاوز Lily. يستخدم العميل إعدادات اتصال مباشر محلية أو مرسلة.",
    },
    model: "custom-model",
    fastModel: "custom-model-fast",
    strongModel: "custom-model",
    direct: true,
  },
];

const labels = {
  zh: {
    quickTitle: "配置要下发给谁",
    quickDesc: "全局默认适合所有设备；授权和设备配置会覆盖全局配置。",
    scopeGlobal: "所有客户端",
    scopeGroup: "某个档位组",
    scopeLicense: "某个授权",
    scopeDevice: "某台设备",
    targetHelp: "全局配置不需要目标 ID；授权/设备配置必须填写对应 ID。",
    modelTitle: "选择模型路线",
    modelDesc: "推荐使用服务端网关。客户端拿短期 token，不暴露长期模型密钥。",
    managed: "服务端托管",
    direct: "客户端直连",
    recommended: "推荐",
    activeModel: "默认模型",
    fastModel: "快速模型",
    strongModel: "强模型",
    subagentModel: "子任务模型",
    baseUrl: "接口地址",
    apiKey: "直连密钥",
    apiKeyHelp: "只有客户端直连时才需要。服务端网关会自动签发短期 token。",
    toolsTitle: "插件和客户端策略",
    toolsDesc: "这里控制插件市场入口、默认权限和最低客户端版本。",
    registry: "插件市场地址",
    pluginIds: "默认启用插件",
    pluginIdsHelp: "多个插件用英文逗号分隔。",
    permissionMode: "权限模式",
    minVersion: "最低客户端版本",
    timeout: "请求超时",
    visionModel: "图片识别模型",
    previewTitle: "即将下发",
    previewDesc: "保存后，客户端启动或刷新授权时会拉取这份签名配置。",
    preset: "模型 preset",
    route: "请求路线",
    securityOk: "短期 token",
    securityWarn: "会暴露直连 key",
    advanced: "高级：查看/编辑 JSON",
    advancedDesc: "正常不用改。只有需要下发自定义字段时才编辑。",
    jsonInvalid: "JSON 格式不正确，保存前需要修复。",
    defaultName: "团队默认配置",
    directName: "客户端直连模型配置",
    gatewayName: "服务端网关配置",
  },
  en: {
    quickTitle: "Who receives this config",
    quickDesc: "Global applies to every client. License and device configs override it.",
    scopeGlobal: "All clients",
    scopeGroup: "A tier group",
    scopeLicense: "A license",
    scopeDevice: "A device",
    targetHelp: "Global config does not need a target ID. License/device configs require one.",
    modelTitle: "Choose the model route",
    modelDesc: "Server gateway is recommended. Clients get short-lived tokens instead of long-lived model keys.",
    managed: "Server managed",
    direct: "Client direct",
    recommended: "Recommended",
    activeModel: "Default model",
    fastModel: "Fast model",
    strongModel: "Strong model",
    subagentModel: "Subtask model",
    baseUrl: "Endpoint",
    apiKey: "Direct API key",
    apiKeyHelp: "Only needed for client direct mode. Server gateway signs short-lived tokens automatically.",
    toolsTitle: "Plugins and client policy",
    toolsDesc: "Control plugin registry, default permissions, and minimum client version.",
    registry: "Plugin registry",
    pluginIds: "Default enabled plugins",
    pluginIdsHelp: "Separate multiple plugin IDs with commas.",
    permissionMode: "Permission mode",
    minVersion: "Minimum app version",
    timeout: "Request timeout",
    visionModel: "Vision model",
    previewTitle: "Delivery preview",
    previewDesc: "After saving, clients fetch this signed config on startup or license refresh.",
    preset: "Model preset",
    route: "Route",
    securityOk: "Short-lived token",
    securityWarn: "Direct key exposed",
    advanced: "Advanced: view/edit JSON",
    advancedDesc: "Normally leave this alone. Edit only when custom fields must be delivered.",
    jsonInvalid: "Invalid JSON. Fix it before saving.",
    defaultName: "Team default config",
    directName: "Client direct model config",
    gatewayName: "Server gateway config",
  },
  ar: {
    quickTitle: "من يستلم هذا الإعداد",
    quickDesc: "الإعداد العام لكل العملاء. إعداد الترخيص أو الجهاز يغطيه.",
    scopeGlobal: "كل العملاء",
    scopeGroup: "مجموعة فئة",
    scopeLicense: "ترخيص محدد",
    scopeDevice: "جهاز محدد",
    targetHelp: "الإعداد العام لا يحتاج هدفاً. الترخيص/الجهاز يحتاج معرفاً.",
    modelTitle: "اختر مسار النموذج",
    modelDesc: "بوابة الخادم هي الأفضل. يحصل العميل على رمز قصير بدلاً من مفتاح طويل.",
    managed: "مدار بالخادم",
    direct: "اتصال مباشر",
    recommended: "مفضل",
    activeModel: "النموذج الافتراضي",
    fastModel: "النموذج السريع",
    strongModel: "النموذج القوي",
    subagentModel: "نموذج المهام الفرعية",
    baseUrl: "عنوان الواجهة",
    apiKey: "مفتاح مباشر",
    apiKeyHelp: "مطلوب فقط في الاتصال المباشر. بوابة الخادم تصدر رموزاً قصيرة تلقائياً.",
    toolsTitle: "الإضافات وسياسة العميل",
    toolsDesc: "تحكم بسجل الإضافات والصلاحيات الافتراضية والحد الأدنى للإصدار.",
    registry: "سجل الإضافات",
    pluginIds: "الإضافات المفعلة افتراضياً",
    pluginIdsHelp: "افصل المعرفات بفواصل إنجليزية.",
    permissionMode: "وضع الصلاحيات",
    minVersion: "أقل إصدار للتطبيق",
    timeout: "مهلة الطلب",
    visionModel: "نموذج الصور",
    previewTitle: "معاينة الإرسال",
    previewDesc: "بعد الحفظ يجلب العميل هذا الإعداد الموقع عند التشغيل أو تحديث الترخيص.",
    preset: "إعداد النموذج",
    route: "المسار",
    securityOk: "رمز قصير",
    securityWarn: "مفتاح مباشر مكشوف",
    advanced: "متقدم: عرض/تحرير JSON",
    advancedDesc: "اتركه كما هو غالباً. حرره فقط لإرسال حقول مخصصة.",
    jsonInvalid: "JSON غير صالح. أصلحه قبل الحفظ.",
    defaultName: "إعداد الفريق الافتراضي",
    directName: "إعداد اتصال مباشر",
    gatewayName: "إعداد بوابة الخادم",
  },
};

function localeLabels(locale) {
  return labels[locale] || labels.zh;
}

function fieldClass() {
  return "w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm outline-none transition focus:border-brand focus:ring-4 focus:ring-brand/10";
}

function templateDescription(template, locale) {
  return template.description?.[locale] || template.description?.zh || "";
}

function templateLabel(template, locale) {
  return template.label?.[locale] || template.label?.zh || String(template.id || "");
}

function defaultDraft(copy) {
  const template = providerTemplates[0];
  return {
    id: "global-default",
    name: copy.defaultName,
    scope: "global",
    targetId: "",
    priority: "0",
    rolloutPercent: "100",
    selectedTemplateId: template.id,
    baseUrl: template.route,
    apiKey: "",
    model: template.model,
    fastModel: template.fastModel,
    strongModel: template.strongModel,
    subagentModel: template.fastModel,
    pluginRegistryUrl: "/api/plugins/registry",
    enabledPluginIds: "",
    permissionMode: "default",
    minAppVersion: "",
    requestTimeoutMs: "300000",
    visionModel: "qwen3.7-plus",
    disabled: false,
  };
}

function selectedTemplate(draft) {
  return providerTemplates.find((template) => template.id === draft.selectedTemplateId) || providerTemplates[0];
}

function splitCsv(text) {
  return String(text || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildConfig(draft, locale = "zh") {
  const template = selectedTemplate(draft);
  const direct = Boolean(template.direct);
  const baseUrl = String(draft.baseUrl || template.route || "").trim();
  const apiKey = direct ? String(draft.apiKey || "").trim() : "$LILY_GATEWAY_TOKEN";
  const env = {
    LILY_API_BASE_URL: baseUrl,
    LILY_API_KEY: apiKey,
    LILY_MODEL: String(draft.model || "").trim(),
    LILY_MODEL_HAIKU: String(draft.fastModel || draft.model || "").trim(),
    LILY_MODEL_SONNET: String(draft.strongModel || draft.model || "").trim(),
    LILY_MODEL_OPUS: String(draft.strongModel || draft.model || "").trim(),
    LILY_SUBAGENT_MODEL: String(draft.subagentModel || draft.fastModel || draft.model || "").trim(),
  };
  if (!direct) env.LILY_GATEWAY_PROVIDER = template.provider;

  return {
    schemaVersion: 1,
    models: {
      source: direct ? "client-direct" : "service-managed",
      activePresetId: template.id,
      presets: [
        {
          id: template.id,
          label: templateLabel(template, locale),
          description: templateDescription(template, locale),
          env,
        },
      ],
    },
    tools: {
      pluginRegistryUrl: String(draft.pluginRegistryUrl || "/api/plugins/registry").trim(),
      enabledPluginIds: splitCsv(draft.enabledPluginIds),
    },
    policy: {
      permissionMode: String(draft.permissionMode || "default").trim(),
      minAppVersion: String(draft.minAppVersion || "").trim(),
    },
    runtime: {
      env: {
        API_TIMEOUT_MS: String(draft.requestTimeoutMs || "300000").trim(),
        VISION_MODEL: String(draft.visionModel || "qwen3.7-plus").trim(),
      },
    },
  };
}

function scopeLabel(scope, copy) {
  if (scope === "group") return copy.scopeGroup;
  if (scope === "license") return copy.scopeLicense;
  if (scope === "device") return copy.scopeDevice;
  return copy.scopeGlobal;
}

function ConfigField({ label, children, help }) {
  return (
    <label className="block">
      <span className="mb-2 block text-sm font-semibold text-slate-800">{label}</span>
      {children}
      {help ? <span className="mt-1 block text-xs text-slate-500">{help}</span> : null}
    </label>
  );
}

export function ConfigProfileForm() {
  const [state, action, pending] = useActionState(createConfigProfileAction, initialState);
  const { locale, t } = useI18n();
  const adminCopy = t.admin.configProfiles;
  const copy = localeLabels(locale);
  const [draft, setDraft] = useState(() => defaultDraft(copy));
  const [jsonOverride, setJsonOverride] = useState("");

  const config = useMemo(() => buildConfig(draft, locale), [draft, locale]);
  const generatedJson = useMemo(() => JSON.stringify(config, null, 2), [config]);
  const submittedJson = jsonOverride.trim() ? jsonOverride : generatedJson;
  const activeTemplate = selectedTemplate(draft);
  const jsonInvalid = useMemo(() => {
    if (!jsonOverride.trim()) return false;
    try {
      const parsed = JSON.parse(jsonOverride);
      return !parsed || Array.isArray(parsed) || typeof parsed !== "object";
    } catch {
      return true;
    }
  }, [jsonOverride]);

  function updateField(name, value) {
    setDraft((current) => ({ ...current, [name]: value }));
  }

  function chooseTemplate(template) {
    setJsonOverride("");
    setDraft((current) => ({
      ...current,
      id: current.scope === "global" ? `${template.id}-global` : current.id,
      name: template.direct ? copy.directName : `${templateLabel(template, locale)} ${copy.gatewayName}`,
      selectedTemplateId: template.id,
      baseUrl: template.route,
      apiKey: "",
      model: template.model,
      fastModel: template.fastModel,
      strongModel: template.strongModel,
      subagentModel: template.fastModel,
      priority: template.direct ? "10" : "20",
    }));
  }

  function chooseScope(scope) {
    setDraft((current) => ({
      ...current,
      scope,
      targetId: scope === "global" ? "" : current.targetId,
      id: scope === "global" ? `${current.selectedTemplateId}-global` : current.id,
    }));
  }

  return (
    <section className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
      <div className="flex flex-col gap-2 border-b border-slate-100 pb-5">
        <h2 className="text-2xl font-semibold text-slate-950">{adminCopy.formTitle}</h2>
        <p className="max-w-4xl text-sm text-slate-500">{adminCopy.formDesc}</p>
      </div>

      <form action={action} className="mt-6 grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <input name="config" type="hidden" value={submittedJson} />

        <div className="space-y-6">
          <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
            <div className="mb-4">
              <h3 className="text-lg font-semibold text-slate-950">{copy.quickTitle}</h3>
              <p className="mt-1 text-sm text-slate-500">{copy.quickDesc}</p>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {["global", "group", "license", "device"].map((scope) => (
                <button
                  key={scope}
                  type="button"
                  className={`rounded-xl border px-4 py-3 text-start text-sm font-semibold transition ${
                    draft.scope === scope
                      ? "border-brand bg-white text-brand shadow-sm ring-4 ring-brand/10"
                      : "border-slate-200 bg-white text-slate-700 hover:border-brand/50"
                  }`}
                  onClick={() => chooseScope(scope)}
                >
                  {scopeLabel(scope, copy)}
                </button>
              ))}
            </div>
            <div className="mt-4 grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
              <ConfigField label={adminCopy.id}>
                <input className={fieldClass()} name="id" required value={draft.id} onChange={(event) => updateField("id", event.target.value)} />
              </ConfigField>
              <ConfigField label={adminCopy.name}>
                <input className={fieldClass()} name="name" required value={draft.name} onChange={(event) => updateField("name", event.target.value)} placeholder={adminCopy.namePlaceholder} />
              </ConfigField>
              <ConfigField label={adminCopy.targetId} help={copy.targetHelp}>
                <input
                  className={fieldClass()}
                  disabled={draft.scope === "global"}
                  name="targetId"
                  placeholder="group / license / device id"
                  required={draft.scope !== "global"}
                  value={draft.targetId}
                  onChange={(event) => updateField("targetId", event.target.value)}
                />
              </ConfigField>
              <div className="grid grid-cols-2 gap-3">
                <ConfigField label={adminCopy.priority}>
                  <input className={fieldClass()} name="priority" type="number" value={draft.priority} onChange={(event) => updateField("priority", event.target.value)} />
                </ConfigField>
                <ConfigField label={adminCopy.rolloutPercent}>
                  <input className={fieldClass()} max="100" min="0" name="rolloutPercent" type="number" value={draft.rolloutPercent} onChange={(event) => updateField("rolloutPercent", event.target.value)} />
                </ConfigField>
              </div>
            </div>
            <input name="scope" type="hidden" value={draft.scope} />
          </div>

          <div className="rounded-2xl border border-slate-200 p-4">
            <div className="mb-4">
              <h3 className="text-lg font-semibold text-slate-950">{copy.modelTitle}</h3>
              <p className="mt-1 text-sm text-slate-500">{copy.modelDesc}</p>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {providerTemplates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  className={`rounded-2xl border p-4 text-start transition ${
                    draft.selectedTemplateId === template.id
                      ? "border-brand bg-brand/5 ring-4 ring-brand/10"
                      : "border-slate-200 bg-white hover:border-brand/50"
                  }`}
                  onClick={() => chooseTemplate(template)}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-semibold text-slate-950">{templateLabel(template, locale)}</span>
                    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${template.direct ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"}`}>
                      {template.direct ? copy.direct : copy.managed}
                    </span>
                  </div>
                  <p className="mt-2 min-h-10 text-sm text-slate-500">{templateDescription(template, locale)}</p>
                  <div className="mt-3 truncate font-mono text-xs text-slate-400">{template.route}</div>
                </button>
              ))}
            </div>

            <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <ConfigField label={copy.activeModel}>
                <input className={fieldClass()} value={draft.model} onChange={(event) => updateField("model", event.target.value)} />
              </ConfigField>
              <ConfigField label={copy.fastModel}>
                <input className={fieldClass()} value={draft.fastModel} onChange={(event) => updateField("fastModel", event.target.value)} />
              </ConfigField>
              <ConfigField label={copy.strongModel}>
                <input className={fieldClass()} value={draft.strongModel} onChange={(event) => updateField("strongModel", event.target.value)} />
              </ConfigField>
              <ConfigField label={copy.subagentModel}>
                <input className={fieldClass()} value={draft.subagentModel} onChange={(event) => updateField("subagentModel", event.target.value)} />
              </ConfigField>
              <div className="md:col-span-2">
                <ConfigField label={copy.baseUrl}>
                  <input className={fieldClass()} value={draft.baseUrl} onChange={(event) => updateField("baseUrl", event.target.value)} />
                </ConfigField>
              </div>
              <div className="md:col-span-2">
                <ConfigField label={copy.apiKey} help={copy.apiKeyHelp}>
                  <input className={fieldClass()} disabled={!activeTemplate.direct} type="password" value={draft.apiKey} onChange={(event) => updateField("apiKey", event.target.value)} placeholder={activeTemplate.direct ? "sk-..." : "$LILY_GATEWAY_TOKEN"} />
                </ConfigField>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 p-4">
            <div className="mb-4">
              <h3 className="text-lg font-semibold text-slate-950">{copy.toolsTitle}</h3>
              <p className="mt-1 text-sm text-slate-500">{copy.toolsDesc}</p>
            </div>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <div className="md:col-span-2">
                <ConfigField label={copy.registry}>
                  <input className={fieldClass()} value={draft.pluginRegistryUrl} onChange={(event) => updateField("pluginRegistryUrl", event.target.value)} />
                </ConfigField>
              </div>
              <div className="md:col-span-2">
                <ConfigField label={copy.pluginIds} help={copy.pluginIdsHelp}>
                  <input className={fieldClass()} value={draft.enabledPluginIds} onChange={(event) => updateField("enabledPluginIds", event.target.value)} placeholder="weather-mcp,filesystem" />
                </ConfigField>
              </div>
              <ConfigField label={copy.permissionMode}>
                <select className={fieldClass()} value={draft.permissionMode} onChange={(event) => updateField("permissionMode", event.target.value)}>
                  <option value="default">default</option>
                  <option value="acceptEdits">acceptEdits</option>
                  <option value="bypassPermissions">bypassPermissions</option>
                  <option value="plan">plan</option>
                  <option value="dontAsk">dontAsk</option>
                </select>
              </ConfigField>
              <ConfigField label={copy.minVersion}>
                <input className={fieldClass()} value={draft.minAppVersion} onChange={(event) => updateField("minAppVersion", event.target.value)} placeholder="0.1.23" />
              </ConfigField>
              <ConfigField label={copy.timeout}>
                <input className={fieldClass()} type="number" value={draft.requestTimeoutMs} onChange={(event) => updateField("requestTimeoutMs", event.target.value)} />
              </ConfigField>
              <ConfigField label={copy.visionModel}>
                <input className={fieldClass()} value={draft.visionModel} onChange={(event) => updateField("visionModel", event.target.value)} />
              </ConfigField>
            </div>
          </div>
        </div>

        <aside className="space-y-4">
          <div className="sticky top-6 rounded-2xl border border-slate-200 bg-slate-950 p-5 text-white shadow-lg">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold">{copy.previewTitle}</h3>
                <p className="mt-1 text-sm text-slate-400">{copy.previewDesc}</p>
              </div>
              <span className={`rounded-full px-3 py-1 text-xs font-semibold ${activeTemplate.direct ? "bg-amber-400/20 text-amber-200" : "bg-emerald-400/20 text-emerald-200"}`}>
                {activeTemplate.direct ? copy.securityWarn : copy.securityOk}
              </span>
            </div>
            <dl className="mt-5 space-y-3 text-sm">
              <div className="rounded-xl bg-white/5 p-3">
                <dt className="text-slate-400">{adminCopy.scope}</dt>
                <dd className="mt-1 font-semibold">{scopeLabel(draft.scope, copy)}</dd>
              </div>
              <div className="rounded-xl bg-white/5 p-3">
                <dt className="text-slate-400">{copy.preset}</dt>
                <dd className="mt-1 font-semibold">{templateLabel(activeTemplate, locale)}</dd>
                <dd className="mt-1 font-mono text-xs text-slate-400">{draft.model}</dd>
              </div>
              <div className="rounded-xl bg-white/5 p-3">
                <dt className="text-slate-400">{copy.route}</dt>
                <dd className="mt-1 break-all font-mono text-xs">{draft.baseUrl}</dd>
              </div>
              <div className="rounded-xl bg-white/5 p-3">
                <dt className="text-slate-400">{copy.registry}</dt>
                <dd className="mt-1 break-all font-mono text-xs">{draft.pluginRegistryUrl || "-"}</dd>
              </div>
              <div className="rounded-xl bg-white/5 p-3">
                <dt className="text-slate-400">{copy.permissionMode}</dt>
                <dd className="mt-1 font-mono text-xs">{draft.permissionMode}</dd>
              </div>
            </dl>

            <details className="mt-5 rounded-xl border border-white/10 bg-black/20 p-3">
              <summary className="cursor-pointer text-sm font-semibold">{copy.advanced}</summary>
              <p className="mt-3 text-xs text-slate-400">{copy.advancedDesc}</p>
              <textarea
                className={`mt-3 max-h-[420px] w-full rounded-lg border bg-black/40 p-3 font-mono text-xs leading-5 text-slate-100 outline-none ${jsonInvalid ? "border-red-400" : "border-white/10 focus:border-brand"}`}
                rows={18}
                value={jsonOverride || generatedJson}
                onChange={(event) => setJsonOverride(event.target.value)}
              />
              {jsonInvalid ? <p className="mt-2 text-xs text-red-200">{copy.jsonInvalid}</p> : null}
            </details>

            <div className="mt-5 flex flex-col gap-4 border-t border-white/10 pt-5">
              <CheckboxField label={adminCopy.disabled} name="disabled" />
              <SubmitButton disabled={pending || jsonInvalid}>{pending ? "..." : adminCopy.save}</SubmitButton>
            </div>
          </div>
        </aside>
      </form>

      {state?.message ? (
        <p className={`mt-4 rounded-lg px-4 py-3 text-sm ${state.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800"}`}>
          {state.message}
        </p>
      ) : null}
    </section>
  );
}
