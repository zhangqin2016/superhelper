"use client";

import { useActionState, useMemo, useState } from "react";
import { createConfigProfileAction } from "../app/admin/actions";
import { CheckboxField, SubmitButton } from "./admin-forms";
import { MultiSelectField } from "./multi-select-field";
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
  baseUrl: "",
  model: "",
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
        baseUrl: p.base_url || p.baseUrl || "",
        model: def,
        models,
        metadata: p.metadata && typeof p.metadata === "object" ? p.metadata : {},
      };
    });
}

const labels = {
  zh: {
    quickTitle: "配置要下发给谁",
    quickDesc: "全局默认适合所有设备；设备组/授权/设备配置会按优先级覆盖全局。",
    scopeGlobal: "所有客户端",
    scopeGroup: "某个设备组",
    scopeLicense: "某个授权",
    scopeDevice: "某台设备",
    targetHelp: "全局配置不需要目标 ID；设备组填组 ID，授权/设备填对应 ID。",
    modelTitle: "模型下发",
    modelDesc: "这里不配置密钥和真实接口，只决定这条规则下客户端能看到哪些模型供应商，以及默认打开哪一个。",
    providerEmpty: "请先在上方「模型供应商」里添加一个供应商。",
    defaultProviderTitle: "默认打开的供应商（单选）",
    defaultProviderDesc: "客户端首次打开会使用这个供应商。具体模型名在「模型供应商」里维护。",
    defaultBadge: "默认",
    allowedProvidersTitle: "客户端可选供应商（多选）",
    allowedProvidersDesc: "这些供应商会出现在客户端模型下拉菜单里。默认供应商会自动包含，不能取消。",
    menuActive: "保存后客户端会收到这组可选供应商。",
    mediaTitle: "图片 / 视频生成",
    mediaDesc: "为本范围勾选可用的生成供应商（可多选），并设一个默认。留空＝沿用今天的行为（所有已配置的、服务器默认）。服务器只会下发实际配置了密钥的那些。",
    mediaImage: "图片生成",
    mediaVideo: "视频生成",
    mediaDefault: "默认：",
    providerModels: "已选供应商的模型",
    providerModelsHelp: "只读预览。每个已选供应商都会下发自己的模型列表；要改模型列表或默认模型，请去「模型供应商」页面配置。",
    toolsTitle: "技能包和客户端策略",
    toolsDesc: "这里控制技能包 registry、默认权限和最低客户端版本。",
    registry: "技能包 registry",
    pluginIds: "默认启用技能包",
    pluginIdsHelp: "多个技能包 ID 用英文逗号分隔。",
    permissionMode: "权限模式",
    minVersion: "最低客户端版本",
    timeout: "请求超时",
    visionModel: "图片识别模型",
    previewTitle: "即将下发",
    previewDesc: "保存后，客户端启动或刷新授权时会拉取这份签名配置。",
    defaultProvider: "默认供应商",
    deliveredMenu: "客户端可选菜单",
    route: "网关路线",
    securityOk: "短期 token",
    advanced: "高级：查看/编辑 JSON",
    advancedDesc: "正常不用改。手写 JSON 会覆盖上面的安全表单；不要在这里写 API Key、供应商真实地址或直连 preset。",
    jsonInvalid: "JSON 格式不正确，保存前需要修复。",
    defaultName: "团队默认配置",
    gatewayName: "网关配置",
  },
  en: {
    quickTitle: "Who receives this config",
    quickDesc: "Global applies to every client. Device-group/license/device configs override it by priority.",
    scopeGlobal: "All clients",
    scopeGroup: "A device group",
    scopeLicense: "A license",
    scopeDevice: "A device",
    targetHelp: "Global needs no target ID. Device group takes a group ID; license/device take their IDs.",
    modelTitle: "Model delivery",
    modelDesc: "This rule does not store keys or upstream URLs. It only controls which model providers the client can see and which one opens by default.",
    providerEmpty: "Add a provider above in “Model providers” first.",
    defaultProviderTitle: "Default provider (single choice)",
    defaultProviderDesc: "The client opens with this provider. Model names are maintained under “Model providers”.",
    defaultBadge: "Default",
    allowedProvidersTitle: "Client model menu (multi-select)",
    allowedProvidersDesc: "These providers appear in the client model picker. The default provider is always included and cannot be removed here.",
    menuActive: "After save, clients will receive this selectable provider menu.",
    mediaTitle: "Image / video generation",
    mediaDesc: "Pick which generation providers this scope may use (multi-select) and one default. Empty = today's behavior (all configured, server default). The server only delivers the ones that actually have a key.",
    mediaImage: "Image generation",
    mediaVideo: "Video generation",
    mediaDefault: "Default:",
    providerModels: "Models from selected providers",
    providerModelsHelp: "Read-only preview. Every selected provider delivers its own model list. Edit model names and provider defaults under “Model providers”.",
    toolsTitle: "Skill packages and client policy",
    toolsDesc: "Control skill registry, default permissions, and minimum client version.",
    registry: "Skill registry",
    pluginIds: "Default enabled skill packages",
    pluginIdsHelp: "Separate multiple skill package IDs with commas.",
    permissionMode: "Permission mode",
    minVersion: "Minimum app version",
    timeout: "Request timeout",
    visionModel: "Vision model",
    previewTitle: "Delivery preview",
    previewDesc: "After saving, clients fetch this signed config on startup or license refresh.",
    defaultProvider: "Default provider",
    deliveredMenu: "Client model menu",
    route: "Gateway route",
    securityOk: "Short-lived token",
    advanced: "Advanced: view/edit JSON",
    advancedDesc: "Normally leave this alone. Manual JSON overrides the safe form above; do not type API keys, upstream URLs, or direct presets here.",
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
    modelTitle: "إرسال النماذج",
    modelDesc: "هذه القاعدة لا تخزن المفاتيح أو عناوين المزوّدين. هي تحدد فقط المزوّدين الذين يراهم العميل والمزوّد الافتراضي.",
    providerEmpty: "أضف مزوّداً أعلاه في «مزوّدو النماذج» أولاً.",
    defaultProviderTitle: "المزوّد الافتراضي (اختيار واحد)",
    defaultProviderDesc: "يفتح العميل بهذا المزوّد. أسماء النماذج تُدار في صفحة «مزوّدو النماذج».",
    defaultBadge: "افتراضي",
    allowedProvidersTitle: "قائمة نماذج العميل (اختيار متعدد)",
    allowedProvidersDesc: "تظهر هذه المزوّدات في قائمة النماذج داخل العميل. المزوّد الافتراضي مضاف دائماً ولا يمكن حذفه هنا.",
    menuActive: "بعد الحفظ سيستلم العملاء قائمة المزوّدين القابلة للاختيار.",
    mediaTitle: "توليد الصور / الفيديو",
    mediaDesc: "اختر مزوّدي التوليد المسموح بهم لهذا النطاق (اختيار متعدد) ومزوّداً افتراضياً. فارغ = سلوك اليوم (كل المُهيأ، الافتراضي من الخادم). يرسل الخادم فقط ما له مفتاح فعلاً.",
    mediaImage: "توليد الصور",
    mediaVideo: "توليد الفيديو",
    mediaDefault: "الافتراضي:",
    providerModels: "نماذج المزوّدين المحددين",
    providerModelsHelp: "معاينة فقط. كل مزوّد محدد يرسل قائمة نماذجه. عدّل أسماء النماذج والافتراضي من صفحة «مزوّدو النماذج».",
    toolsTitle: "حزم المهارات وسياسة العميل",
    toolsDesc: "تحكم بسجل حزم المهارات والصلاحيات الافتراضية والحد الأدنى للإصدار.",
    registry: "سجل حزم المهارات",
    pluginIds: "حزم المهارات المفعلة افتراضياً",
    pluginIdsHelp: "افصل معرفات حزم المهارات بفواصل إنجليزية.",
    permissionMode: "وضع الصلاحيات",
    minVersion: "أقل إصدار للتطبيق",
    timeout: "مهلة الطلب",
    visionModel: "نموذج الصور",
    previewTitle: "معاينة الإرسال",
    previewDesc: "بعد الحفظ يجلب العميل هذا الإعداد الموقع عند التشغيل أو تحديث الترخيص.",
    defaultProvider: "المزوّد الافتراضي",
    deliveredMenu: "قائمة نماذج العميل",
    route: "مسار البوابة",
    securityOk: "رمز قصير",
    advanced: "متقدم: عرض/تحرير JSON",
    advancedDesc: "اتركه كما هو غالباً. JSON اليدوي يتجاوز النموذج الآمن؛ لا تكتب مفاتيح API أو عناوين أصلية أو presets مباشرة هنا.",
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

function templateById(templates, id) {
  return templates.find((template) => template.id === id) || null;
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
    menuProviders: template.id ? [template.id] : [],
    baseUrl: template.route,
    pluginRegistryUrl: "/api/skills/registry",
    enabledPluginIds: "",
    permissionMode: "default",
    minAppVersion: "",
    requestTimeoutMs: "300000",
    visionModel: "qwen3.7-plus",
    imageProviders: [],
    imageDefault: "",
    videoProviders: [],
    videoDefault: "",
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

// Media-generation providers offered for distribution. The server gates each by whether
// its key exists (resolveMediaSelection), so listing all here is safe — unavailable ones
// are dropped at delivery.
const MEDIA_PROVIDERS = [
  { id: "dashscope", label: "阿里百炼 DashScope" },
  { id: "volcengine", label: "火山方舟 Volcengine" },
  { id: "kling", label: "可灵 Kling" },
  { id: "minimax", label: "MiniMax" },
  { id: "zhipu", label: "智谱 Zhipu" },
];
const MEDIA_PROVIDER_IDS = new Set(MEDIA_PROVIDERS.map((p) => p.id));

// Build the per-scope media-generation selection (multi-select + one default), or null
// when nothing is selected (→ omitted from config → old behavior, never breaks clients).
function buildMedia(draft) {
  const pick = (providers, def) => {
    const list = (Array.isArray(providers) ? providers : []).filter((p) => MEDIA_PROVIDER_IDS.has(p));
    if (!list.length) return null;
    return { providers: list, default: list.includes(def) ? def : list[0] };
  };
  const image = pick(draft.imageProviders, draft.imageDefault);
  const video = pick(draft.videoProviders, draft.videoDefault);
  if (!image && !video) return null;
  return { ...(image ? { image } : {}), ...(video ? { video } : {}) };
}

function deliveryProviderIds(draft, template) {
  const menu = Array.isArray(draft.menuProviders) ? draft.menuProviders.filter(Boolean) : [];
  const defaultProvider = draft.selectedTemplateId || template.provider || template.id || "";
  return Array.from(new Set([defaultProvider, ...menu].filter(Boolean)));
}

function buildConfig(draft, template) {
  const tools = {
    pluginRegistryUrl: String(draft.pluginRegistryUrl || "/api/skills/registry").trim(),
    enabledPluginIds: splitCsv(draft.enabledPluginIds),
  };
  const policy = {
    permissionMode: String(draft.permissionMode || "default").trim(),
    minAppVersion: String(draft.minAppVersion || "").trim(),
  };
  const runtime = {
    env: {
      API_TIMEOUT_MS: String(draft.requestTimeoutMs || "300000").trim(),
      VISION_MODEL: String(draft.visionModel || "qwen3.7-plus").trim(),
    },
  };
  const media = buildMedia(draft);
  const mediaPart = media ? { media } : {};

  // Delivery rules record only a provider directive. The server expands it into
  // a signed gateway model menu at client-config time, so profiles never carry
  // upstream URLs or provider keys.
  const providers = deliveryProviderIds(draft, template);
  const activeProvider = providers.includes(draft.selectedTemplateId) ? draft.selectedTemplateId : providers[0] || "";
  const capabilities = Object.fromEntries(
    providers
      .filter((providerId) => Boolean(draft.providerCapabilities?.[providerId]?.vision))
      .map((providerId) => [providerId, { vision: true }]),
  );
  return {
    schemaVersion: 1,
    models: {
      source: "service",
      providers,
      activeProvider,
      capabilities,
    },
    tools,
    policy,
    runtime,
    ...mediaPart,
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

export function ConfigProfileForm({ providers = [], skillPackageOptions = [] }) {
  const [state, action, pending] = useActionState(createConfigProfileAction, initialState);
  const { locale, t } = useI18n();
  const adminCopy = t.admin.configProfiles;
  const copy = localeLabels(locale);
  const templates = useMemo(() => providersToTemplates(providers), [providers]);
  const [draft, setDraft] = useState(() => defaultDraft(copy, templates));
  const [jsonOverride, setJsonOverride] = useState("");

  const activeTemplate = selectedTemplate(draft, templates);
  const providerCapabilities = useMemo(
    () => Object.fromEntries(templates.map((template) => [template.id, { vision: Boolean(template.metadata?.nativeVision) }])),
    [templates],
  );
  const draftWithCapabilities = useMemo(() => ({ ...draft, providerCapabilities }), [draft, providerCapabilities]);
  const config = useMemo(() => buildConfig(draftWithCapabilities, activeTemplate), [draftWithCapabilities, activeTemplate]);
  const deliveredProviderIds = useMemo(() => deliveryProviderIds(draft, activeTemplate), [draft, activeTemplate]);
  const generatedJson = useMemo(() => JSON.stringify(config, null, 2), [config]);
  const submittedJson = jsonOverride.trim() ? jsonOverride : generatedJson;
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
      menuProviders: Array.from(new Set([...(current.menuProviders || []), template.id].filter(Boolean))),
      baseUrl: template.route,
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

  // Toggle a provider in/out of this scope's selectable model menu. A non-empty
  // menu switches buildConfig to the multi-provider directive.
  function toggleMenuProvider(id) {
    setDraft((current) => {
      if (id === current.selectedTemplateId) return current;
      const set = new Set(current.menuProviders || []);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      return { ...current, menuProviders: [...set] };
    });
  }

  // Image/video generation: toggle a provider into the scope's selectable set; the
  // default auto-follows the selection (kept valid). buildMedia turns this into config.media.
  function toggleMediaProvider(modality, id) {
    const key = modality === "image" ? "imageProviders" : "videoProviders";
    const defKey = modality === "image" ? "imageDefault" : "videoDefault";
    setDraft((current) => {
      const set = new Set(current[key] || []);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      const list = [...set];
      const def = list.includes(current[defKey]) ? current[defKey] : list[0] || "";
      return { ...current, [key]: list, [defKey]: def };
    });
  }
  function setMediaDefault(modality, id) {
    const defKey = modality === "image" ? "imageDefault" : "videoDefault";
    setDraft((current) => ({ ...current, [defKey]: id }));
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
            <div className="mt-4 grid gap-4 lg:grid-cols-3">
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
              <>
                <div className="mb-3 rounded-xl border border-brand/15 bg-brand/5 px-4 py-3">
                  <div className="text-sm font-semibold text-slate-900">{copy.defaultProviderTitle}</div>
                  <p className="mt-1 text-xs text-slate-600">{copy.defaultProviderDesc}</p>
                </div>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {templates.map((template) => {
                    const isDefault = draft.selectedTemplateId === template.id;
                    return (
                      <button
                        key={template.id}
                        type="button"
                        className={`rounded-2xl border p-4 text-start transition ${
                          isDefault
                            ? "border-brand bg-brand/5 ring-4 ring-brand/10"
                            : "border-slate-200 bg-white hover:border-brand/50"
                        }`}
                        onClick={() => chooseTemplate(template)}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="font-semibold text-slate-950">{templateLabel(template)}</span>
                          <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                            isDefault ? "bg-brand text-white" : "bg-emerald-100 text-emerald-700"
                          }`}>
                            {isDefault ? copy.defaultBadge : copy.securityOk}
                          </span>
                        </div>
                        <p className="mt-2 min-h-10 text-sm text-slate-500">{template.model || "—"}</p>
                        <div className="mt-3 truncate font-mono text-xs text-slate-400">{template.route}</div>
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            {templates.length > 0 ? (
              <div className="mt-5 rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-sm font-semibold text-slate-800">{copy.allowedProvidersTitle}</div>
                <p className="mt-1 text-xs text-slate-500">{copy.allowedProvidersDesc}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {templates.map((template) => {
                    const isDefault = draft.selectedTemplateId === template.id;
                    const on = deliveredProviderIds.includes(template.id);
                    return (
                      <button
                        key={template.id}
                        type="button"
                        onClick={() => toggleMenuProvider(template.id)}
                        aria-pressed={on}
                        aria-disabled={isDefault}
                        className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                          isDefault
                            ? "bg-brand text-white ring-2 ring-brand/20"
                            : on
                              ? "bg-slate-900 text-white"
                              : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                        }`}
                      >
                        {templateLabel(template)}
                        {isDefault ? ` · ${copy.defaultBadge}` : ""}
                      </button>
                    );
                  })}
                </div>
                {deliveredProviderIds.length > 0 ? (
                  <p className="mt-3 text-xs text-emerald-700">{copy.menuActive}</p>
                ) : null}
              </div>
            ) : null}

            {deliveredProviderIds.length ? (
              <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-sm font-semibold text-slate-800">{copy.providerModels}</div>
                <p className="mt-1 text-xs text-slate-500">{copy.providerModelsHelp}</p>
                <div className="mt-4 grid gap-3 lg:grid-cols-2">
                  {deliveredProviderIds.map((providerId) => {
                    const providerTemplate = templateById(templates, providerId);
                    const models = Array.isArray(providerTemplate?.models) ? providerTemplate.models.filter(Boolean) : [];
                    const defaultModel = providerTemplate?.model || models[0] || "";
                    return (
                      <div key={providerId} className="rounded-xl border border-slate-200 bg-white p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold text-slate-900">{templateLabel(providerTemplate) || providerId}</span>
                          {providerId === draft.selectedTemplateId ? (
                            <span className="rounded-full bg-brand/10 px-2 py-0.5 text-xs font-semibold text-brand">{copy.defaultBadge}</span>
                          ) : null}
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {(models.length ? models : [defaultModel || "—"]).map((model) => (
                            <span
                              key={`${providerId}-${model}`}
                              className={`rounded-full px-3 py-1 font-mono text-xs ring-1 ${
                                model === defaultModel
                                  ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                                  : "bg-slate-50 text-slate-600 ring-slate-200"
                              }`}
                            >
                              {model}
                            </span>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

          </div>

          <div className="rounded-2xl border border-slate-200 p-4">
            <div className="mb-4">
              <h3 className="text-lg font-semibold text-slate-950">{copy.mediaTitle}</h3>
              <p className="mt-1 text-sm text-slate-500">{copy.mediaDesc}</p>
            </div>
            {[["image", copy.mediaImage], ["video", copy.mediaVideo]].map(([modality, label]) => {
              const selKey = modality === "image" ? "imageProviders" : "videoProviders";
              const defKey = modality === "image" ? "imageDefault" : "videoDefault";
              const selected = draft[selKey] || [];
              return (
                <div key={modality} className="mb-4 rounded-xl border border-slate-200 bg-white p-4 last:mb-0">
                  <div className="text-sm font-semibold text-slate-800">{label}</div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {MEDIA_PROVIDERS.map((p) => {
                      const on = selected.includes(p.id);
                      return (
                        <button
                          key={p.id}
                          type="button"
                          aria-pressed={on}
                          onClick={() => toggleMediaProvider(modality, p.id)}
                          className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                            on ? "bg-brand text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                          }`}
                        >
                          {p.label}
                        </button>
                      );
                    })}
                  </div>
                  {selected.length > 0 ? (
                    <div className="mt-3 flex items-center gap-2 text-xs text-slate-600">
                      <span>{copy.mediaDefault}</span>
                      <select
                        className={fieldClass()}
                        value={draft[defKey]}
                        onChange={(event) => setMediaDefault(modality, event.target.value)}
                      >
                        {selected.map((id) => (
                          <option key={id} value={id}>
                            {MEDIA_PROVIDERS.find((p) => p.id === id)?.label || id}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>

          <details className="group rounded-2xl border border-slate-200 p-4">
            <summary className="cursor-pointer list-none">
              <span className="text-lg font-semibold text-slate-950">{t.admin.configAdvanced.title}</span>
              <span className="mt-1 block text-sm text-slate-500">{t.admin.configAdvanced.desc}</span>
            </summary>
            <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <ConfigField label={adminCopy.priority}>
                <input className={fieldClass()} name="priority" type="number" value={draft.priority} onChange={(event) => updateField("priority", event.target.value)} />
              </ConfigField>
              <ConfigField label={adminCopy.rolloutPercent}>
                <input className={fieldClass()} max="100" min="0" name="rolloutPercent" type="number" value={draft.rolloutPercent} onChange={(event) => updateField("rolloutPercent", event.target.value)} />
              </ConfigField>
              <div className="md:col-span-2 hidden xl:block" />
              <div className="md:col-span-2">
                <ConfigField label={copy.registry}>
                  <input className={fieldClass()} value={draft.pluginRegistryUrl} onChange={(event) => updateField("pluginRegistryUrl", event.target.value)} />
                </ConfigField>
              </div>
              <div className="md:col-span-2">
                <ConfigField label={copy.pluginIds} help={copy.pluginIdsHelp}>
                  <MultiSelectField
                    options={skillPackageOptions}
                    value={splitCsv(draft.enabledPluginIds)}
                    onChange={(ids) => updateField("enabledPluginIds", ids.join(","))}
                    emptyHint={copy.providerEmpty}
                  />
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
          </details>
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
                <dt className="text-slate-400">{copy.defaultProvider}</dt>
                <dd className="mt-1 font-semibold">{templateLabel(activeTemplate) || "—"}</dd>
                <dd className="mt-1 font-mono text-xs text-slate-400">{activeTemplate.model || "—"}</dd>
              </div>
              <div className="rounded-xl bg-white/5 p-3">
                <dt className="text-slate-400">{copy.deliveredMenu}</dt>
                <dd className="mt-1 text-xs font-semibold">
                  {deliveredProviderIds.map((id) => templateLabel(templates.find((template) => template.id === id)) || id).join(" · ") || "—"}
                </dd>
                <dd className="mt-2 break-all font-mono text-xs text-slate-400">{deliveredProviderIds.map((id) => `/llm/${id}`).join(" · ") || "—"}</dd>
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
