import Link from "next/link";
import { Badge } from "./ui/badge";
import { ruleAudience, summarizeRuleConfig } from "../lib/config-rule-summary.mjs";

const labelsByLocale = {
  zh: {
    overview: "最近改过的规则",
    overviewDesc: "客户端启动时会按这些规则拿到模型、技能和权限。",
    activeProfiles: "启用配置",
    globalProfiles: "全局",
    licenseProfiles: "授权",
    deviceProfiles: "设备",
    gateway: "模型网关",
    providersReady: "可用供应商",
    pluginRegistry: "技能商店地址", runtimeSecretNames: "随配置下发的密钥",
    delivery: "下发链路",
    ready: "已就绪",
    attention: "需处理",
    direct: "直连",
    serverGateway: "服务端网关",
    target: "目标",
    priority: "优先级",
    rollout: "灰度",
    latestProfiles: "最近配置", statusTitle: "现在的状态", rulesLine: "下发规则：{active} 条生效中，共 {total} 条", modelsLine: "模型：{ready} 个能用", modelsBroken: "；{names} 还没配好（缺密钥或地址）", clientOk: "客户端拉取配置：正常", clientBad: "客户端拉取配置：异常，请看健康检查", manageRules: "管理规则", manageProviders: "去配置",
    modelProviders: "模型供应商",
    noProfiles: "还没有配置。先用下面模板创建全局默认配置。",
    noProviders: "没有检测到可用模型供应商。请先到「模型供应商」配置密钥和模型。",
    managePlugins: "管理技能包",
    health: "查看健康检查",
    effectiveTitle: "当前生效配置",
    effectiveDesc: "不填时显示所有设备都会拿到的配置；填授权 ID 或设备 ID，看那台客户端实际拿到什么。",
    deviceId: "设备 ID",
    licenseId: "授权 ID",
    preview: "预览",
    whoDecided: "每项设置来自哪条规则",
    whoDecidedDesc: "每个字段最后由哪条规则定下；没列出的字段来自默认配置。",
    droppedTitle: "下发时被改掉的设置",
    droppedDesc: "规则写了、但投放管线后续环节改写或移除的字段。空即表示规则原样送达。",
    nothingDropped: "没有任何字段被改写或移除",
    stageLabel: "环节",
    appliedProfiles: "对它生效的规则",
    modelRoute: "模型怎么连",
    security: "密钥安全",
    pluginIds: "预装技能",
    noAppliedProfiles: "当前没有命中任何后台配置，客户端会使用安装包内默认配置。",
    noModels: "没有下发模型供应商。",
    defaultProvider: "默认供应商",
    providerMenu: "可选供应商",
    noRuntimeSecrets: "没有长期密钥随配置下发",
    hasRuntimeSecrets: "有长期密钥随配置下发到客户端",
    safeGateway: "全部经服务端网关，密钥不出服务器",
    directRisk: "有模型直连，密钥在客户端上",
    deliveredJson: "查看实际下发 JSON",
  },
  en: {
    overview: "Recently changed rules",
    overviewDesc: "At startup, clients get their models, skills and permissions from these rules.",
    activeProfiles: "Enabled profiles",
    globalProfiles: "Global",
    licenseProfiles: "License",
    deviceProfiles: "Device",
    gateway: "Model gateway",
    providersReady: "Ready providers",
    pluginRegistry: "Skill store address", runtimeSecretNames: "Keys sent with the config",
    delivery: "Delivery path",
    ready: "Ready",
    attention: "Needs attention",
    direct: "Direct",
    serverGateway: "Server gateway",
    target: "Target",
    priority: "Priority",
    rollout: "Rollout",
    latestProfiles: "Recent profiles", statusTitle: "What is happening now", rulesLine: "Delivery rules: {active} active of {total}", modelsLine: "Models: {ready} usable", modelsBroken: "; {names} not set up yet (missing key or address)", clientOk: "Clients fetching config: working", clientBad: "Clients fetching config: failing — see health", manageRules: "Manage rules", manageProviders: "Set up",
    modelProviders: "Model providers",
    noProfiles: "No config yet. Create the global default with a template below.",
    noProviders: "No ready model provider detected. Configure keys and models under Model providers first.",
    managePlugins: "Manage skill packages",
    health: "Open health",
    effectiveTitle: "Effective client config",
    effectiveDesc: "Blank shows what every device gets; enter a license or device ID to see what that client actually receives.",
    deviceId: "Device ID",
    licenseId: "License ID",
    preview: "Preview",
    whoDecided: "Which rule set each setting",
    whoDecidedDesc: "Which rule established each field. Fields not listed come from the packaged defaults.",
    droppedTitle: "Settings changed on delivery",
    droppedDesc: "Fields a rule set that a later stage rewrote or removed. Empty means every rule reached the client intact.",
    nothingDropped: "Nothing was rewritten or removed",
    stageLabel: "stage",
    appliedProfiles: "Rules that apply to it",
    modelRoute: "How models connect",
    security: "Key safety",
    pluginIds: "Enabled skill packages",
    noAppliedProfiles: "No admin config applies. The client will use packaged defaults.",
    noModels: "No model provider delivered.",
    defaultProvider: "Default provider",
    providerMenu: "Provider menu",
    noRuntimeSecrets: "No long-lived key is sent with the config",
    hasRuntimeSecrets: "Long-lived keys are sent to the client",
    safeGateway: "All through the server gateway; keys stay on the server",
    directRisk: "Some models connect directly, with the key on the client",
    deliveredJson: "View delivered JSON",
  },
  ar: {
    overview: "مركز الإعدادات",
    overviewDesc: "إدارة إعدادات النماذج وحزم المهارات والسياسات التي يجلبها العميل عند التشغيل.",
    activeProfiles: "إعدادات مفعلة",
    globalProfiles: "عام",
    licenseProfiles: "ترخيص",
    deviceProfiles: "جهاز",
    gateway: "بوابة النماذج",
    providersReady: "مزودون جاهزون",
    pluginRegistry: "سجل حزم المهارات",
    delivery: "مسار الإرسال",
    ready: "جاهز",
    attention: "يتطلب انتباهاً",
    direct: "مباشر",
    serverGateway: "بوابة الخادم",
    target: "الهدف",
    priority: "الأولوية",
    rollout: "النشر",
    latestProfiles: "أحدث الإعدادات",
    modelProviders: "مزودو النماذج",
    noProfiles: "لا توجد إعدادات بعد. أنشئ الإعداد العام الافتراضي من القالب أدناه.",
    noProviders: "لم يتم العثور على مزوّد نماذج جاهز. اضبط المفاتيح والنماذج في صفحة مزوّدي النماذج أولاً.",
    managePlugins: "إدارة حزم المهارات",
    health: "فحص الصحة",
    effectiveTitle: "الإعداد الفعّال للعميل",
    effectiveDesc: "يعرض الإعداد العام افتراضياً. أدخل ترخيصاً أو جهازاً لمعرفة ما سيستلمه العميل.",
    deviceId: "معرف الجهاز",
    licenseId: "معرف الترخيص",
    preview: "معاينة",
    whoDecided: "مصدر كل حقل",
    whoDecidedDesc: "أي قاعدة حدّدت كل حقل. الحقول غير المذكورة تأتي من الإعدادات الافتراضية.",
    droppedTitle: "ما جرى تغييره أو حذفه عند التسليم",
    droppedDesc: "حقول ضبطتها قاعدة ثم أعادت مرحلة لاحقة كتابتها أو أزالتها. الفراغ يعني وصول القواعد كما هي.",
    nothingDropped: "لم يُحذف أو يُعدّل أي حقل",
    stageLabel: "المرحلة",
    appliedProfiles: "الطبقات المطبقة",
    modelRoute: "مسار النموذج",
    security: "الأمان",
    pluginIds: "حزم المهارات المفعلة",
    noAppliedProfiles: "لا يوجد إعداد إداري مطابق. سيستخدم العميل الإعدادات المضمنة.",
    noModels: "لا توجد إعدادات نموذج مرسلة.",
    defaultProvider: "المزوّد الافتراضي",
    providerMenu: "المزوّدون المتاحون",
    noRuntimeSecrets: "لا توجد أسرار طويلة الأمد",
    hasRuntimeSecrets: "توجد أسرار تشغيل",
    safeGateway: "بوابة الخادم / رمز قصير العمر",
    directRisk: "خطر اتصال مباشر أو مفتاح طويل الأمد",
    deliveredJson: "عرض JSON المرسل",
  },
};

function labels(locale) {
  // A locale without a line falls back to English for that line only.
  return { ...labelsByLocale.en, ...(labelsByLocale[locale] || labelsByLocale.zh) };
}

function gatewayCheck(health) {
  return (health?.checks || []).find((check) => check.name === "model_gateway") || {};
}

function configDeliveryCheck(health) {
  return (health?.checks || []).find((check) => check.name === "config_delivery") || {};
}

function redactConfig(value) {
  if (Array.isArray(value)) return value.map(redactConfig);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, nested] of Object.entries(value)) {
    if (/(KEY|TOKEN|SECRET|PASSWORD)$/i.test(key)) {
      output[key] = nested ? "<redacted>" : "";
    } else {
      output[key] = redactConfig(nested);
    }
  }
  return output;
}

function statusBadge(ok, copy) {
  return <Badge variant={ok ? "success" : "danger"}>{ok ? copy.ready : copy.attention}</Badge>;
}

function effectivePreviewPanel(preview, copy, deviceId, licenseId, ruleCopy, locale) {
  const summary = preview?.summary || {};
  const profiles = Array.isArray(preview?.appliedProfiles) ? preview.appliedProfiles : [];
  // The delivery receipt: which rule set each field, and what a later stage did
  // to it. Both come from the same pipeline the client is served by.
  const provenanceRows = Object.entries(preview?.provenance || {}).sort(([a], [b]) => a.localeCompare(b));
  const decisions = (Array.isArray(preview?.decisions) ? preview.decisions : []).filter((entry) => entry?.reason !== "added");
  const models = Array.isArray(summary.modelPresets) ? summary.modelPresets : [];
  const runtimeSecrets = Array.isArray(summary.runtimeSecretKeys) ? summary.runtimeSecretKeys : [];
  // The route badge speaks for the models only; long-lived runtime keys have
  // their own badge in the security panel.
  const riskOk = summary.risks ? !(summary.risks.directModelPresets || summary.risks.longLivedModelKeys) : summary.riskLevel !== "warning";
  const activeModel = models.find((model) => model.id === summary.activePresetId);

  return (
    <section className="table-card p-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-950">{copy.effectiveTitle}</h2>
          <p className="mt-2 text-sm text-slate-500">{copy.effectiveDesc}</p>
        </div>
        <form className="grid gap-3 md:grid-cols-[1fr_1fr_auto]" method="get">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-slate-500">{copy.licenseId}</span>
            <input className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand" name="licenseId" defaultValue={licenseId} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-slate-500">{copy.deviceId}</span>
            <input className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand" name="deviceId" defaultValue={deviceId} />
          </label>
          <button className="self-end rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white" type="submit">{copy.preview}</button>
        </form>
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div className="text-sm font-semibold text-slate-950">{copy.appliedProfiles}</div>
          <div className="mt-3 space-y-2">
            {profiles.length ? profiles.map((profile) => (
              <div key={profile.id} className="rounded-lg bg-white p-3 text-sm">
                <div className="font-semibold text-slate-800">{profile.name || profile.id}</div>
                <div className="mt-1 text-xs text-slate-500">{ruleCopy ? ruleAudience({ scope: profile.scope, target_id: profile.targetId }, ruleCopy) : profile.scope}{Number(profile.rolloutPercent ?? 100) < 100 ? ` · ${copy.rollout} ${Number(profile.rolloutPercent)}%` : ""}</div>
              </div>
            )) : <p className="text-sm text-slate-500">{copy.noAppliedProfiles}</p>}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-semibold text-slate-950">{copy.modelRoute}</div>
            <Badge variant={riskOk ? "success" : "danger"}>{riskOk ? copy.safeGateway : copy.directRisk}</Badge>
          </div>
          <div className="mt-3 space-y-2">
            {models.length ? models.map((model) => (
              <div key={model.id} className="rounded-lg bg-white p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-slate-800">{model.label || model.id}</span>
                  <Badge variant={model.delivery === "server_gateway" && !model.exposesLongLivedSecret ? "success" : "danger"}>
                    {model.delivery === "server_gateway" ? copy.serverGateway : copy.direct}
                  </Badge>
                </div>
                <div className="mt-1 font-mono text-xs text-slate-500">{model.model || "-"}</div>
                <div className="mt-1 truncate font-mono text-xs text-slate-400">{model.baseUrl || "-"}</div>
              </div>
            )) : <p className="text-sm text-slate-500">{copy.noModels}</p>}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-semibold text-slate-950">{copy.security}</div>
            <Badge variant={runtimeSecrets.length ? "danger" : "success"}>{runtimeSecrets.length ? copy.hasRuntimeSecrets : copy.noRuntimeSecrets}</Badge>
          </div>
          <dl className="mt-3 space-y-3 text-sm">
            <div className="rounded-lg bg-white p-3">
              <dt className="text-xs text-slate-500">{copy.defaultProvider}</dt>
              <dd className="mt-1 text-slate-800">{activeModel ? `${activeModel.label || activeModel.id} · ${activeModel.model || ""}` : summary.activePresetId || "-"}</dd>
            </div>
            {summary.pluginRegistryUrl && summary.pluginRegistryUrl !== "/api/skills/registry" ? (
              <div className="rounded-lg bg-white p-3">
                <dt className="text-xs text-slate-500">{copy.pluginRegistry}</dt>
                <dd className="mt-1 break-all font-mono text-slate-800">{summary.pluginRegistryUrl}</dd>
              </div>
            ) : null}
            <div className="rounded-lg bg-white p-3">
              <dt className="text-xs text-slate-500">{copy.pluginIds}</dt>
              <dd className="mt-1 text-slate-800">{(summary.enabledPluginIds || []).join(", ") || "-"}</dd>
            </div>
            <div className="rounded-lg bg-white p-3">
              <dt className="text-xs text-slate-500">{copy.runtimeSecretNames}</dt>
              <dd className="mt-1 font-mono text-slate-800">{runtimeSecrets.join(", ") || copy.noRuntimeSecrets}</dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div className="text-sm font-semibold text-slate-950">{copy.whoDecided}</div>
          <p className="mt-1 text-xs text-slate-500">{copy.whoDecidedDesc}</p>
          <div className="mt-3 max-h-64 space-y-1 overflow-auto">
            {provenanceRows.length ? provenanceRows.map(([field, source]) => (
              <div key={field} className="flex items-baseline justify-between gap-3 rounded-lg bg-white px-3 py-2 text-xs">
                <span className="font-mono text-slate-700">{field}</span>
                <span className="shrink-0 text-slate-500">{source?.name || source?.id} · {source?.scope}</span>
              </div>
            )) : <p className="text-sm text-slate-500">{copy.noAppliedProfiles}</p>}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div className="text-sm font-semibold text-slate-950">{copy.droppedTitle}</div>
          <p className="mt-1 text-xs text-slate-500">{copy.droppedDesc}</p>
          <div className="mt-3 max-h-64 space-y-1 overflow-auto">
            {decisions.length ? decisions.map((decision, index) => (
              <div key={`${decision.stage}-${decision.field}-${index}`} className="rounded-lg bg-white px-3 py-2 text-xs">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-mono text-slate-700">{decision.field || decision.rule}</span>
                  <Badge variant={decision.reason === "removed" ? "danger" : "warning"}>{decision.reason}</Badge>
                </div>
                <div className="mt-1 text-slate-500">{copy.stageLabel}: {decision.stage}{decision.detail ? ` · ${decision.detail}` : ""}</div>
              </div>
            )) : <p className="text-sm text-slate-500">{copy.nothingDropped}</p>}
          </div>
        </div>
      </div>

      {preview?.effectiveConfig ? (
        <details className="mt-5 rounded-xl border border-slate-200 bg-slate-950 p-4 text-white">
          <summary className="cursor-pointer text-sm font-semibold">{copy.deliveredJson}</summary>
          <pre className="mt-4 max-h-[420px] overflow-auto rounded-lg bg-black/30 p-4 text-xs leading-6 text-slate-100">
            {JSON.stringify(redactConfig(preview.effectiveConfig), null, 2)}
          </pre>
        </details>
      ) : null}
    </section>
  );
}

const fill = (text, values) => String(text || "").replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ""));

export function ConfigCenterPanels({ rows = [], health = {}, preview = null, locale = "zh", deviceId = "", licenseId = "", ruleCopy = null, providers: providerRows = [] }) {
  const copy = labels(locale);
  const enabledRows = rows.filter((row) => row.enabled);
  const gateway = gatewayCheck(health);
  const delivery = configDeliveryCheck(health);
  const providers = Array.isArray(gateway.providers) ? gateway.providers : [];
  const readyProviders = providers.filter((provider) => provider.ready);
  const notReady = providers.filter((provider) => !provider.ready).map((provider) => provider.id);
  const providerNames = new Map(providerRows.map((row) => [row.id, row.label || row.id]));
  const providerName = (id) => providerNames.get(id) || id;
  const recentRows = [...rows].sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0)).slice(0, 4);

  return (
    <div className="mb-6 space-y-6">
      <section className="table-card p-5" aria-label={copy.statusTitle}>
        <h2 className="text-base font-semibold text-slate-950">{copy.statusTitle}</h2>
        <ul className="mt-3 space-y-2 text-sm text-slate-800">
          <li className="flex flex-wrap items-center gap-2">
            <span>{fill(copy.rulesLine, { active: enabledRows.length, total: rows.length })}</span>
            <Link className="text-brand hover:underline" href="/admin/config/profiles">{copy.manageRules}</Link>
          </li>
          <li className="flex flex-wrap items-center gap-2">
            {statusBadge(!notReady.length, copy)}
            <span>{fill(copy.modelsLine, { ready: readyProviders.length })}{notReady.length ? fill(copy.modelsBroken, { names: notReady.map(providerName).join(locale === "zh" ? "、" : ", ") }) : ""}</span>
            {notReady.length ? <Link className="text-brand hover:underline" href="/admin/config/providers">{copy.manageProviders}</Link> : null}
          </li>
          <li className="flex flex-wrap items-center gap-2">
            {statusBadge(delivery.ok !== false && health.status !== "error", copy)}
            <span>{delivery.ok !== false && health.status !== "error" ? copy.clientOk : copy.clientBad}</span>
          </li>
        </ul>
      </section>

      {effectivePreviewPanel(preview, copy, deviceId, licenseId, ruleCopy, locale)}

      <section className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="table-card p-6">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-slate-950">{copy.overview}</h2>
              <p className="mt-2 text-sm text-slate-500">{copy.overviewDesc}</p>
            </div>
            <div className="flex gap-2">
              <Link className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:border-brand hover:text-brand" href="/admin/skill-packages">
                {copy.managePlugins}
              </Link>
              <Link className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:border-brand hover:text-brand" href="/admin/health">
                {copy.health}
              </Link>
            </div>
          </div>
          <div className="mt-5 space-y-3">
            {recentRows.length ? recentRows.map((row) => {
              const lines = summarizeRuleConfig(row.config, { locale, providerName }).slice(0, 3);
              return (
                <div key={row.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/admin/config/profiles/${encodeURIComponent(row.id)}`} className="font-semibold text-slate-950 hover:text-brand hover:underline">{row.name || row.id}</Link>
                    {statusBadge(row.enabled, copy)}
                  </div>
                  {ruleCopy ? <div className="mt-2 text-sm text-slate-700">{ruleCopy.who}{ruleCopy.colon}{ruleAudience(row, ruleCopy)}</div> : null}
                  <div className="mt-1 text-sm text-slate-600">{lines.map((line) => `${line.label ? `${line.label}${ruleCopy?.colon || ": "}` : ""}${line.value}`).join(" · ")}</div>
                </div>
              );
            }) : <div className="rounded-xl border border-dashed border-slate-300 p-5 text-sm text-slate-500">{copy.noProfiles}</div>}
          </div>
        </div>

        <div className="table-card p-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold text-slate-950">{copy.modelProviders}</h2>
              <p className="mt-2 text-sm text-slate-500">{gateway.detail || "-"}</p>
            </div>
            {statusBadge(gateway.ok, copy)}
          </div>
          <div className="mt-5 space-y-3">
            {providers.length ? providers.map((provider) => (
              <div key={provider.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="font-semibold text-slate-950">{provider.id}</div>
                  {statusBadge(provider.ready, copy)}
                </div>
                <div className="mt-2 text-xs uppercase tracking-wide text-slate-400">{provider.type} · {provider.hasApiKey ? copy.serverGateway : copy.direct}</div>
                <div className="mt-2 break-all font-mono text-xs text-slate-500">{provider.baseUrl || "-"}</div>
                <div className="mt-2 text-xs text-slate-500">{(provider.models || []).slice(0, 4).join(", ") || provider.model || "-"}</div>
              </div>
            )) : <div className="rounded-xl border border-dashed border-slate-300 p-5 text-sm text-slate-500">{copy.noProviders}</div>}
          </div>
        </div>
      </section>
    </div>
  );
}
