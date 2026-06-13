"use client";

import { useActionState, useMemo, useState } from "react";
import { createConfigProfileAction } from "../app/admin/actions";
import { CheckboxField, SubmitButton } from "./admin-forms";
import { useI18n } from "../lib/use-i18n";

const initialState = { ok: null, message: "" };

// Model "templates" are derived from the live provider registry (managed in the
// Model providers panel), not hardcoded. Delivery is always via the gateway:
// the client gets baseUrl=/llm/<provider> + a short-lived $LILY_GATEWAY_TOKEN,
// and the server uses the provider's stored key to reach the model. No raw key
// is ever typed into or delivered by a profile.
const FALLBACK_TEMPLATE = {
  id: "",
  label: "",
  provider: "",
  route: "",
  model: "",
  fastModel: "",
  strongModel: "",
  models: [],
};

// Reserved gateway ids that are credentials for vision / web-search proxies,
// not chat models — never offer them in the chat model picker.
const RESERVED_PROVIDER_IDS = new Set(["vision", "search"]);

function providersToTemplates(providers) {
  // Accepts either the merged gateway summary (env + DB, has hasApiKey) or raw
  // DB rows (has enabled). Only providers that can actually serve are offered.
  return (providers || [])
    .filter((p) => p && p.enabled !== false && p.hasApiKey !== false && !RESERVED_PROVIDER_IDS.has(p.id))
    .map((p) => {
      const models = Array.isArray(p.models) ? p.models.filter(Boolean) : [];
      const def = p.default_model || p.model || models[0] || "";
      return {
        id: p.id,
        label: p.label || p.id,
        provider: p.id,
        route: `/llm/${p.id}`,
        model: def,
        fastModel: models[1] || def,
        strongModel: def,
        models,
      };
    });
}

const labels = {
  zh: {
    quickTitle: "配置要下发给谁",
    quickDesc: "全局默认适合所有设备；档位组/授权/设备配置会按优先级覆盖全局。",
    scopeGlobal: "所有客户端",
    scopeGroup: "某个档位组",
    scopeLicense: "某个授权",
    scopeDevice: "某台设备",
    targetHelp: "全局配置不需要目标 ID；档位组填组 ID，授权/设备填对应 ID。",
    modelTitle: "选择模型供应商",
    modelDesc: "选择上方已配置好的供应商。客户端只走网关 + 短期 token，不下发任何密钥。",
    providerEmpty: "请先在上方「模型供应商」里添加一个供应商。",
    activeModel: "默认模型",
    fastModel: "快速模型",
    strongModel: "强模型",
    subagentModel: "子任务模型",
    modelPick: "可直接选该供应商的模型，或手动输入。",
    visionNative: "模型原生支持图片识别",
    visionNativeHelp: "勾选后，带图片的消息直接发给该模型，跳过 Qwen 识图桥接。仅当该模型本身能看图时才勾。",
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
    preset: "供应商",
    route: "网关路线",
    securityOk: "短期 token",
    advanced: "高级：查看/编辑 JSON",
    advancedDesc: "正常不用改。只有需要下发自定义字段时才编辑。",
    jsonInvalid: "JSON 格式不正确，保存前需要修复。",
    defaultName: "团队默认配置",
    gatewayName: "网关配置",
  },
  en: {
    quickTitle: "Who receives this config",
    quickDesc: "Global applies to every client. Tier-group/license/device configs override it by priority.",
    scopeGlobal: "All clients",
    scopeGroup: "A tier group",
    scopeLicense: "A license",
    scopeDevice: "A device",
    targetHelp: "Global needs no target ID. Tier group takes a group ID; license/device take their IDs.",
    modelTitle: "Choose a model provider",
    modelDesc: "Pick a provider configured above. Clients only use the gateway + a short-lived token; no key is delivered.",
    providerEmpty: "Add a provider above in “Model providers” first.",
    activeModel: "Default model",
    fastModel: "Fast model",
    strongModel: "Strong model",
    subagentModel: "Subtask model",
    modelPick: "Pick one of the provider's models, or type your own.",
    visionNative: "Model natively recognizes images",
    visionNativeHelp: "When checked, messages with images go straight to this model and skip the Qwen vision bridge. Only check this if the model itself can see images.",
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
    preset: "Provider",
    route: "Gateway route",
    securityOk: "Short-lived token",
    advanced: "Advanced: view/edit JSON",
    advancedDesc: "Normally leave this alone. Edit only when custom fields must be delivered.",
    jsonInvalid: "Invalid JSON. Fix it before saving.",
    defaultName: "Team default config",
    gatewayName: "gateway config",
  },
  ar: {
    quickTitle: "من يستلم هذا الإعداد",
    quickDesc: "الإعداد العام لكل العملاء. إعداد المجموعة/الترخيص/الجهاز يغطيه حسب الأولوية.",
    scopeGlobal: "كل العملاء",
    scopeGroup: "مجموعة فئة",
    scopeLicense: "ترخيص محدد",
    scopeDevice: "جهاز محدد",
    targetHelp: "الإعداد العام لا يحتاج هدفاً. المجموعة تأخذ معرّف المجموعة؛ الترخيص/الجهاز يأخذ معرّفه.",
    modelTitle: "اختر مزوّد النموذج",
    modelDesc: "اختر مزوّداً مضبوطاً أعلاه. يستخدم العميل البوابة + رمزاً قصيراً فقط؛ لا يُرسَل أي مفتاح.",
    providerEmpty: "أضف مزوّداً أعلاه في «مزوّدو النماذج» أولاً.",
    activeModel: "النموذج الافتراضي",
    fastModel: "النموذج السريع",
    strongModel: "النموذج القوي",
    subagentModel: "نموذج المهام الفرعية",
    modelPick: "اختر أحد نماذج المزوّد أو اكتب نموذجاً.",
    visionNative: "النموذج يتعرف على الصور أصلاً",
    visionNativeHelp: "عند التحديد، تُرسل الرسائل ذات الصور مباشرة إلى هذا النموذج متجاوزة جسر Qwen. حدّد فقط إذا كان النموذج نفسه يرى الصور.",
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
    preset: "المزوّد",
    route: "مسار البوابة",
    securityOk: "رمز قصير",
    advanced: "متقدم: عرض/تحرير JSON",
    advancedDesc: "اتركه كما هو غالباً. حرره فقط لإرسال حقول مخصصة.",
    jsonInvalid: "JSON غير صالح. أصلحه قبل الحفظ.",
    defaultName: "إعداد الفريق الافتراضي",
    gatewayName: "إعداد البوابة",
  },
};

function localeLabels(locale) {
  return labels[locale] || labels.zh;
}

function fieldClass() {
  return "w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm outline-none transition focus:border-brand focus:ring-4 focus:ring-brand/10";
}

function templateLabel(template) {
  return String(template?.label || template?.id || "");
}

function defaultDraft(copy, templates) {
  const template = templates[0] || FALLBACK_TEMPLATE;
  return {
    id: template.id ? `${template.id}-global` : "global-default",
    name: copy.defaultName,
    scope: "global",
    targetId: "",
    priority: "0",
    rolloutPercent: "100",
    selectedTemplateId: template.id,
    baseUrl: template.route,
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
    supportsVision: false,
    disabled: false,
  };
}

function selectedTemplate(draft, templates) {
  return templates.find((template) => template.id === draft.selectedTemplateId) || templates[0] || FALLBACK_TEMPLATE;
}

function splitCsv(text) {
  return String(text || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildConfig(draft, template) {
  const providerId = template.provider || template.id || "";
  const baseUrl = providerId ? `/llm/${providerId}` : "";
  const env = {
    LILY_API_BASE_URL: baseUrl,
    LILY_API_KEY: "$LILY_GATEWAY_TOKEN",
    LILY_GATEWAY_PROVIDER: providerId,
    LILY_MODEL: String(draft.model || "").trim(),
    LILY_MODEL_HAIKU: String(draft.fastModel || draft.model || "").trim(),
    LILY_MODEL_SONNET: String(draft.strongModel || draft.model || "").trim(),
    LILY_MODEL_OPUS: String(draft.strongModel || draft.model || "").trim(),
    LILY_SUBAGENT_MODEL: String(draft.subagentModel || draft.fastModel || draft.model || "").trim(),
  };

  return {
    schemaVersion: 1,
    models: {
      source: "service-managed",
      activePresetId: template.id || providerId,
      presets: [
        {
          id: template.id || providerId,
          label: templateLabel(template),
          description: "",
          capabilities: { vision: Boolean(draft.supportsVision) },
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

export function ConfigProfileForm({ providers = [] }) {
  const [state, action, pending] = useActionState(createConfigProfileAction, initialState);
  const { locale, t } = useI18n();
  const adminCopy = t.admin.configProfiles;
  const copy = localeLabels(locale);
  const templates = useMemo(() => providersToTemplates(providers), [providers]);
  const [draft, setDraft] = useState(() => defaultDraft(copy, templates));
  const [jsonOverride, setJsonOverride] = useState("");

  const activeTemplate = selectedTemplate(draft, templates);
  const config = useMemo(() => buildConfig(draft, activeTemplate), [draft, activeTemplate]);
  const generatedJson = useMemo(() => JSON.stringify(config, null, 2), [config]);
  const submittedJson = jsonOverride.trim() ? jsonOverride : generatedJson;
  const modelListId = "provider-model-options";
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
      name: `${templateLabel(template)} ${copy.gatewayName}`,
      selectedTemplateId: template.id,
      baseUrl: template.route,
      model: template.model,
      fastModel: template.fastModel,
      strongModel: template.strongModel,
      subagentModel: template.fastModel,
      priority: "20",
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
            {templates.length === 0 ? (
              <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">{copy.providerEmpty}</p>
            ) : (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {templates.map((template) => (
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
                      <span className="font-semibold text-slate-950">{templateLabel(template)}</span>
                      <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-700">{copy.securityOk}</span>
                    </div>
                    <p className="mt-2 min-h-10 text-sm text-slate-500">{template.model || "—"}</p>
                    <div className="mt-3 truncate font-mono text-xs text-slate-400">{template.route}</div>
                  </button>
                ))}
              </div>
            )}

            <datalist id={modelListId}>
              {(activeTemplate.models || []).map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>

            <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <ConfigField label={copy.activeModel} help={copy.modelPick}>
                <input className={fieldClass()} list={modelListId} value={draft.model} onChange={(event) => updateField("model", event.target.value)} />
              </ConfigField>
              <ConfigField label={copy.fastModel}>
                <input className={fieldClass()} list={modelListId} value={draft.fastModel} onChange={(event) => updateField("fastModel", event.target.value)} />
              </ConfigField>
              <ConfigField label={copy.strongModel}>
                <input className={fieldClass()} list={modelListId} value={draft.strongModel} onChange={(event) => updateField("strongModel", event.target.value)} />
              </ConfigField>
              <ConfigField label={copy.subagentModel}>
                <input className={fieldClass()} list={modelListId} value={draft.subagentModel} onChange={(event) => updateField("subagentModel", event.target.value)} />
              </ConfigField>
              <div className="md:col-span-2 xl:col-span-4">
                <label className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-3">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4"
                    checked={draft.supportsVision}
                    onChange={(event) => updateField("supportsVision", event.target.checked)}
                  />
                  <span>
                    <span className="block text-sm font-semibold text-slate-800">{copy.visionNative}</span>
                    <span className="mt-1 block text-xs text-slate-500">{copy.visionNativeHelp}</span>
                  </span>
                </label>
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
              <span className="rounded-full bg-emerald-400/20 px-3 py-1 text-xs font-semibold text-emerald-200">{copy.securityOk}</span>
            </div>
            <dl className="mt-5 space-y-3 text-sm">
              <div className="rounded-xl bg-white/5 p-3">
                <dt className="text-slate-400">{adminCopy.scope}</dt>
                <dd className="mt-1 font-semibold">{scopeLabel(draft.scope, copy)}</dd>
              </div>
              <div className="rounded-xl bg-white/5 p-3">
                <dt className="text-slate-400">{copy.preset}</dt>
                <dd className="mt-1 font-semibold">{templateLabel(activeTemplate) || "—"}</dd>
                <dd className="mt-1 font-mono text-xs text-slate-400">{draft.model}</dd>
              </div>
              <div className="rounded-xl bg-white/5 p-3">
                <dt className="text-slate-400">{copy.route}</dt>
                <dd className="mt-1 break-all font-mono text-xs">{draft.baseUrl || "—"}</dd>
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
