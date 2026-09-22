"use client";

import { useActionState, useMemo, useState } from "react";
import { createConfigProfileAction } from "../app/admin/actions";
import { CheckboxField, SubmitButton } from "./admin-forms";
import { MultiSelectField } from "./multi-select-field";
import { useI18n } from "../lib/use-i18n";
import { labels, localeLabels } from "./config-profile-copy.js";
import { MEDIA_PROVIDERS, buildAgents, buildConfig, buildMedia, deliveryProviderIds } from "./config-profile-config-builder.js";

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
    .filter((p) => p && p.enabled !== false && p.hasApiKey !== false && p.type !== "media" && !RESERVED_PROVIDER_IDS.has(p.id))
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
    speechProviders: [],
    speechDefault: "",
    agentIds: [],
    agentDefault: "",
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

export function ConfigProfileForm({ providers = [], skillPackageOptions = [], agentPackageOptions = [], mediaProviders = [] }) {
  const [state, action, pending] = useActionState(createConfigProfileAction, initialState);
  const { locale, t } = useI18n();
  const adminCopy = t.admin.configProfiles;
  const copy = localeLabels(locale);
  const templates = useMemo(() => providersToTemplates(providers), [providers]);
  // The server's catalog when it answered, the packaged list when it did not —
  // an unreachable admin API must not empty the picker.
  const mediaCatalog = mediaProviders.length ? mediaProviders : MEDIA_PROVIDERS;
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

  function mediaDraftKeys(modality) {
    if (modality === "image") return { providersKey: "imageProviders", defaultKey: "imageDefault" };
    if (modality === "video") return { providersKey: "videoProviders", defaultKey: "videoDefault" };
    return { providersKey: "speechProviders", defaultKey: "speechDefault" };
  }

  // Media generation: toggle a provider into the scope's selectable set; the
  // default auto-follows the selection (kept valid). buildMedia turns this into config.media.
  function toggleMediaProvider(modality, id) {
    const { providersKey, defaultKey } = mediaDraftKeys(modality);
    setDraft((current) => {
      const set = new Set(current[providersKey] || []);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      const list = [...set];
      const def = list.includes(current[defaultKey]) ? current[defaultKey] : list[0] || "";
      return { ...current, [providersKey]: list, [defaultKey]: def };
    });
  }
  function setMediaDefault(modality, id) {
    const { defaultKey } = mediaDraftKeys(modality);
    setDraft((current) => ({ ...current, [defaultKey]: id }));
  }

  // Agents: the multi-select owns `available`; the default radio is kept valid
  // (cleared when its agent is deselected). buildAgents turns this into config.agents.
  function setAgentIds(ids) {
    setDraft((current) => {
      const list = [...new Set((ids || []).filter(Boolean))];
      return { ...current, agentIds: list, agentDefault: list.includes(current.agentDefault) ? current.agentDefault : "" };
    });
  }
  function setAgentDefault(id) {
    setDraft((current) => ({ ...current, agentDefault: id }));
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
                  placeholder="组 ID / 授权码或授权 ID / 设备 ID"
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
            {[["image", copy.mediaImage], ["video", copy.mediaVideo], ["speech", copy.mediaSpeech]].map(([modality, label]) => {
              const { providersKey, defaultKey } = mediaDraftKeys(modality);
              const selected = draft[providersKey] || [];
              return (
                <div key={modality} className="mb-4 rounded-xl border border-slate-200 bg-white p-4 last:mb-0">
                  <div className="text-sm font-semibold text-slate-800">{label}</div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {mediaCatalog
                      .filter((p) => !Array.isArray(p.kinds) || p.kinds.includes(modality))
                      .map((p) => {
                      const on = selected.includes(p.id);
                      // A provider with no credential cannot be delivered. Ticking
                      // it used to save and silently do nothing, so it is offered
                      // as unavailable with the id an operator must create.
                      const ready = p.configured !== false;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          aria-pressed={on}
                          disabled={!ready}
                          title={ready ? undefined : `${copy.mediaUnconfigured}${p.credentialProviderId ? `: ${p.credentialProviderId}` : ""}`}
                          onClick={() => toggleMediaProvider(modality, p.id)}
                          className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                            !ready
                              ? "cursor-not-allowed bg-slate-50 text-slate-400 line-through"
                              : on ? "bg-brand text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
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
                        value={draft[defaultKey]}
                        onChange={(event) => setMediaDefault(modality, event.target.value)}
                      >
                        {selected.map((id) => (
                          <option key={id} value={id}>
                            {mediaCatalog.find((p) => p.id === id)?.label || id}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>

          <div className="rounded-2xl border border-slate-200 p-4">
            <div className="mb-4">
              <h3 className="text-lg font-semibold text-slate-950">{copy.agentsTitle}</h3>
              <p className="mt-1 text-sm text-slate-500">{copy.agentsDesc}</p>
            </div>
            <MultiSelectField
              options={agentPackageOptions}
              value={draft.agentIds || []}
              onChange={setAgentIds}
              emptyHint={copy.agentsEmpty}
            />
            {(draft.agentIds || []).length > 0 ? (
              <fieldset className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
                <legend className="px-1 text-sm font-semibold text-slate-800">{copy.agentsDefault}</legend>
                <div className="mt-2 flex flex-wrap gap-3 text-sm text-slate-700">
                  <label className="flex items-center gap-2">
                    <input type="radio" name="agentDefaultPick" value="" checked={!draft.agentDefault} onChange={() => setAgentDefault("")} />
                    <span>{copy.agentsNoDefault}</span>
                  </label>
                  {(draft.agentIds || []).map((id) => (
                    <label key={id} className="flex items-center gap-2">
                      <input type="radio" name="agentDefaultPick" value={id} checked={draft.agentDefault === id} onChange={() => setAgentDefault(id)} />
                      <span>{agentPackageOptions.find((option) => option.id === id)?.label || id}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : null}
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
              {(draft.agentIds || []).length > 0 ? (
                <div className="rounded-xl bg-white/5 p-3">
                  <dt className="text-slate-400">{copy.agentsPreview}</dt>
                  <dd className="mt-1 break-all font-mono text-xs">{(draft.agentIds || []).join(" · ")}</dd>
                  {draft.agentDefault ? <dd className="mt-1 text-xs text-slate-400">{copy.agentsDefault}: <span className="font-mono">{draft.agentDefault}</span></dd> : null}
                </div>
              ) : null}
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
