import Link from "next/link";
import { Badge } from "./ui/badge";

const labelsByLocale = {
  zh: {
    overview: "配置中心",
    overviewDesc: "这里管理客户端启动时拉取的模型、插件和权限策略。",
    activeProfiles: "启用配置",
    globalProfiles: "全局",
    licenseProfiles: "授权",
    deviceProfiles: "设备",
    gateway: "模型网关",
    providersReady: "可用 Provider",
    pluginRegistry: "插件市场入口",
    delivery: "下发链路",
    ready: "已就绪",
    attention: "需处理",
    direct: "直连",
    serverGateway: "服务端网关",
    target: "目标",
    priority: "优先级",
    rollout: "灰度",
    latestProfiles: "最近配置",
    modelProviders: "模型 Provider",
    noProfiles: "还没有配置。先用下面模板创建全局默认配置。",
    noProviders: "没有检测到模型 provider。请在服务端环境变量里配置 provider key。",
    managePlugins: "管理插件",
    health: "查看健康检查",
    effectiveTitle: "当前生效配置",
    effectiveDesc: "默认显示全局配置。输入授权 ID 或设备 ID 后，可以看到该客户端实际会拿到什么。",
    deviceId: "设备 ID",
    licenseId: "授权 ID",
    preview: "预览",
    appliedProfiles: "命中的配置层",
    modelRoute: "模型请求路线",
    security: "安全状态",
    pluginIds: "启用插件",
    noAppliedProfiles: "当前没有命中任何后台配置，客户端会使用安装包内默认配置。",
    noModels: "没有下发模型 preset。",
    noRuntimeSecrets: "没有 runtime 级长期密钥",
    hasRuntimeSecrets: "存在 runtime 级密钥",
    safeGateway: "服务端网关 / 短期 token",
    directRisk: "存在直连或长期 key 风险",
    deliveredJson: "查看实际下发 JSON",
  },
  en: {
    overview: "Config center",
    overviewDesc: "Manage the model, plugin, and policy config fetched by clients at startup.",
    activeProfiles: "Enabled profiles",
    globalProfiles: "Global",
    licenseProfiles: "License",
    deviceProfiles: "Device",
    gateway: "Model gateway",
    providersReady: "Ready providers",
    pluginRegistry: "Plugin registry",
    delivery: "Delivery path",
    ready: "Ready",
    attention: "Needs attention",
    direct: "Direct",
    serverGateway: "Server gateway",
    target: "Target",
    priority: "Priority",
    rollout: "Rollout",
    latestProfiles: "Recent profiles",
    modelProviders: "Model providers",
    noProfiles: "No config yet. Create the global default with a template below.",
    noProviders: "No model provider detected. Configure provider keys in server env.",
    managePlugins: "Manage plugins",
    health: "Open health",
    effectiveTitle: "Effective client config",
    effectiveDesc: "Defaults to the global config. Enter a license or device ID to preview what that client will receive.",
    deviceId: "Device ID",
    licenseId: "License ID",
    preview: "Preview",
    appliedProfiles: "Applied layers",
    modelRoute: "Model route",
    security: "Security",
    pluginIds: "Enabled plugins",
    noAppliedProfiles: "No admin config applies. The client will use packaged defaults.",
    noModels: "No model preset delivered.",
    noRuntimeSecrets: "No runtime long-lived secret",
    hasRuntimeSecrets: "Runtime secrets present",
    safeGateway: "Server gateway / short-lived token",
    directRisk: "Direct or long-lived key risk",
    deliveredJson: "View delivered JSON",
  },
  ar: {
    overview: "مركز الإعدادات",
    overviewDesc: "إدارة إعدادات النماذج والإضافات والسياسات التي يجلبها العميل عند التشغيل.",
    activeProfiles: "إعدادات مفعلة",
    globalProfiles: "عام",
    licenseProfiles: "ترخيص",
    deviceProfiles: "جهاز",
    gateway: "بوابة النماذج",
    providersReady: "مزودون جاهزون",
    pluginRegistry: "سجل الإضافات",
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
    noProviders: "لم يتم العثور على مزود نماذج. أضف مفاتيح المزود في بيئة الخادم.",
    managePlugins: "إدارة الإضافات",
    health: "فحص الصحة",
    effectiveTitle: "الإعداد الفعّال للعميل",
    effectiveDesc: "يعرض الإعداد العام افتراضياً. أدخل ترخيصاً أو جهازاً لمعرفة ما سيستلمه العميل.",
    deviceId: "معرف الجهاز",
    licenseId: "معرف الترخيص",
    preview: "معاينة",
    appliedProfiles: "الطبقات المطبقة",
    modelRoute: "مسار النموذج",
    security: "الأمان",
    pluginIds: "الإضافات المفعلة",
    noAppliedProfiles: "لا يوجد إعداد إداري مطابق. سيستخدم العميل الإعدادات المضمنة.",
    noModels: "لا توجد إعدادات نموذج مرسلة.",
    noRuntimeSecrets: "لا توجد أسرار طويلة الأمد",
    hasRuntimeSecrets: "توجد أسرار تشغيل",
    safeGateway: "بوابة الخادم / رمز قصير العمر",
    directRisk: "خطر اتصال مباشر أو مفتاح طويل الأمد",
    deliveredJson: "عرض JSON المرسل",
  },
};

function labels(locale) {
  return labelsByLocale[locale] || labelsByLocale.zh;
}

function parseConfig(config) {
  if (!config) return {};
  if (typeof config === "object") return config;
  try {
    return JSON.parse(config);
  } catch {
    return {};
  }
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

function countByScope(rows, scope) {
  return rows.filter((row) => row.enabled && row.scope === scope).length;
}

function statusBadge(ok, copy) {
  return <Badge variant={ok ? "success" : "danger"}>{ok ? copy.ready : copy.attention}</Badge>;
}

function effectivePreviewPanel(preview, copy, deviceId, licenseId) {
  const summary = preview?.summary || {};
  const profiles = Array.isArray(preview?.appliedProfiles) ? preview.appliedProfiles : [];
  const models = Array.isArray(summary.modelPresets) ? summary.modelPresets : [];
  const runtimeSecrets = Array.isArray(summary.runtimeSecretKeys) ? summary.runtimeSecretKeys : [];
  const riskOk = summary.riskLevel !== "warning";

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
                <div className="font-mono font-semibold text-slate-800">{profile.id}</div>
                <div className="mt-1 text-xs text-slate-500">{profile.scope} · {copy.priority} {profile.priority} · {copy.rollout} {Number(profile.rolloutPercent ?? 100)}%</div>
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
              <dt className="text-xs text-slate-500">Preset</dt>
              <dd className="mt-1 font-mono text-slate-800">{summary.activePresetId || "-"}</dd>
            </div>
            <div className="rounded-lg bg-white p-3">
              <dt className="text-xs text-slate-500">{copy.pluginRegistry}</dt>
              <dd className="mt-1 break-all font-mono text-slate-800">{summary.pluginRegistryUrl || "-"}</dd>
            </div>
            <div className="rounded-lg bg-white p-3">
              <dt className="text-xs text-slate-500">{copy.pluginIds}</dt>
              <dd className="mt-1 text-slate-800">{(summary.enabledPluginIds || []).join(", ") || "-"}</dd>
            </div>
            <div className="rounded-lg bg-white p-3">
              <dt className="text-xs text-slate-500">{copy.security}</dt>
              <dd className="mt-1 font-mono text-slate-800">{runtimeSecrets.join(", ") || copy.noRuntimeSecrets}</dd>
            </div>
          </dl>
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

export function ConfigCenterPanels({ rows = [], health = {}, preview = null, locale = "zh", deviceId = "", licenseId = "" }) {
  const copy = labels(locale);
  const enabledRows = rows.filter((row) => row.enabled);
  const gateway = gatewayCheck(health);
  const delivery = configDeliveryCheck(health);
  const providers = Array.isArray(gateway.providers) ? gateway.providers : [];
  const readyProviders = providers.filter((provider) => provider.ready);
  const recentRows = rows.slice(0, 4);

  return (
    <div className="mb-6 space-y-6">
      <section className="grid gap-4 xl:grid-cols-4">
        {[
          [copy.activeProfiles, enabledRows.length, `${copy.globalProfiles} ${countByScope(rows, "global")} · ${copy.licenseProfiles} ${countByScope(rows, "license")} · ${copy.deviceProfiles} ${countByScope(rows, "device")}`],
          [copy.gateway, `${readyProviders.length}/${providers.length}`, gateway.enabled === false ? "disabled" : copy.providersReady],
          [copy.pluginRegistry, delivery.pluginRegistryUrl || "/api/plugins/registry", copy.delivery],
          [copy.delivery, delivery.endpoint || "/api/client/config", health.status || "unknown"],
        ].map(([title, value, detail]) => (
          <div key={title} className="metric-card rounded-xl p-5">
            <div className="text-sm font-medium text-slate-500">{title}</div>
            <div className="mt-3 break-all text-2xl font-semibold text-slate-950">{value}</div>
            <div className="mt-2 text-xs text-slate-500">{detail}</div>
          </div>
        ))}
      </section>

      {effectivePreviewPanel(preview, copy, deviceId, licenseId)}

      <section className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="table-card p-6">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-slate-950">{copy.overview}</h2>
              <p className="mt-2 text-sm text-slate-500">{copy.overviewDesc}</p>
            </div>
            <div className="flex gap-2">
              <Link className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:border-brand hover:text-brand" href="/admin/plugins">
                {copy.managePlugins}
              </Link>
              <Link className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:border-brand hover:text-brand" href="/admin/health">
                {copy.health}
              </Link>
            </div>
          </div>
          <div className="mt-5 space-y-3">
            {recentRows.length ? recentRows.map((row) => {
              const config = parseConfig(row.config);
              const activePresetId = config.models?.activePresetId || "-";
              const modelCount = Array.isArray(config.models?.presets) ? config.models.presets.length : 0;
              return (
                <div key={row.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-slate-950">{row.name}</span>
                    <Badge variant="brand">{row.scope}</Badge>
                    {statusBadge(row.enabled, copy)}
                  </div>
                  <div className="mt-3 grid gap-2 text-sm text-slate-600 md:grid-cols-4">
                    <span>{copy.target}: <b className="font-mono">{row.target_id || "global"}</b></span>
                    <span>{copy.priority}: <b>{row.priority}</b></span>
                    <span>{copy.rollout}: <b>{Number(row.rollout_percent ?? 100)}%</b></span>
                    <span>preset: <b>{activePresetId}</b> · {modelCount}</span>
                  </div>
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
