"use client";

import Link from "next/link";
import { DangerForm } from "./danger-form";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { useI18n } from "../lib/use-i18n";
import { ruleAudience, summarizeRuleConfig } from "../lib/config-rule-summary.mjs";
import { deleteConfigProfileAction, rollbackConfigProfileAction, setConfigProfileEnabledAction } from "../app/admin/actions";

// The delivery rules, read the way delivery reads them: in merge order, each
// saying who receives it and what it changes, in words. Ids, priorities and the
// raw JSON are still one click away under "more" — never the first thing read.

function RuleCard({ rule, order, copy, locale, legacy, providerName, mediaName }) {
  const enabled = rule.enabled !== false;
  const percent = Number(rule.rollout_percent ?? 100);
  const lines = summarizeRuleConfig(rule.config, { locale, providerName, mediaName });
  const href = `/admin/config/profiles/${encodeURIComponent(rule.id)}`;
  const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ""));
  return (
    <li className={`table-card p-4 ${enabled ? "" : "opacity-70"}`}>
      <div className="flex flex-wrap items-start gap-3">
        <span className="mt-0.5 inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-slate-100 px-2 text-xs font-semibold tabular-nums text-slate-600">{order}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={href} className="text-base font-semibold text-slate-900 hover:text-brand hover:underline">{rule.name || rule.id}</Link>
            <Badge variant={enabled ? "success" : "default"}>{enabled ? copy.on : copy.off}</Badge>
            {enabled && percent < 100 ? <Badge variant="warning">{fill(copy.partial, { percent })}</Badge> : null}
          </div>
          <dl className="mt-2 grid gap-x-3 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
            <dt className="text-slate-500">{copy.who}</dt>
            <dd className="text-slate-800">{ruleAudience(rule, copy)}</dd>
            <dt className="text-slate-500">{copy.what}</dt>
            <dd className="text-slate-800">
              <ul className="space-y-0.5">
                {lines.map((line, index) => <li key={index}>{line.label ? <span className="text-slate-500">{line.label}{copy.colon}</span> : null}{line.value}</li>)}
              </ul>
            </dd>
          </dl>
          {!enabled ? <p className="mt-2 text-xs text-slate-500">{copy.offNote}</p> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={href} className="inline-flex h-8 items-center rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-800 hover:bg-slate-50">{copy.edit}</Link>
          <form action={setConfigProfileEnabledAction}>
            <input type="hidden" name="id" value={rule.id} />
            <input type="hidden" name="enabled" value={enabled ? "false" : "true"} />
            <Button variant="outline" size="sm">{enabled ? copy.disable : copy.enable}</Button>
          </form>
        </div>
      </div>
      <details className="mt-3 border-t border-slate-100 pt-2 text-sm">
        <summary className="cursor-pointer text-slate-500 hover:text-slate-800">{copy.more}</summary>
        <dl className="mt-2 grid gap-x-3 gap-y-1 sm:grid-cols-[max-content_1fr]">
          <dt className="text-slate-500">{copy.id}</dt><dd className="font-mono text-slate-700">{rule.id}</dd>
          {rule.target_id ? <><dt className="text-slate-500">{copy.scope[rule.scope] || rule.scope} ID</dt><dd className="font-mono text-slate-700">{rule.target_id}</dd></> : null}
          <dt className="text-slate-500">{copy.priority}</dt><dd className="tabular-nums text-slate-700">{Number(rule.priority ?? 0)}</dd>
        </dl>
        <div className="mt-3 overflow-x-auto rounded-lg bg-slate-50 p-3">
          <p className="mb-1 text-xs text-slate-500">{copy.raw}</p>
          <pre className="text-xs text-slate-700">{JSON.stringify(typeof rule.config === "string" ? safeParse(rule.config) : rule.config, null, 2)}</pre>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <DangerForm action={rollbackConfigProfileAction} confirm={legacy.rollbackConfirm}>
            <input type="hidden" name="id" value={rule.id} />
            <Button variant="outline" size="sm">{copy.rollback}</Button>
          </DangerForm>
          <DangerForm action={deleteConfigProfileAction} confirm={legacy.deleteConfirm}>
            <input type="hidden" name="id" value={rule.id} />
            <Button variant="danger" size="sm">{copy.delete}</Button>
          </DangerForm>
        </div>
      </details>
    </li>
  );
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function ConfigRulesList({ rules = [], providers = [], mediaProviders = [] }) {
  const { locale, t } = useI18n();
  const copy = t.admin.configRules;
  const legacy = t.admin.configProfiles;
  const providerNames = new Map(providers.map((p) => [p.id, p.label || p.id]));
  const mediaNames = new Map(mediaProviders.map((p) => [p.id, (locale === "zh" ? p.label : p.labelEn || p.label) || p.id]));
  const providerName = (id) => providerNames.get(id) || id;
  const mediaName = (id) => mediaNames.get(id) || id;
  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-700">
        <h2 className="font-semibold text-slate-900">{copy.howTitle}</h2>
        <p className="mt-1">{copy.how}</p>
      </section>
      {rules.length ? (
        <ol className="space-y-3">
          {rules.map((rule, index) => (
            <RuleCard key={rule.id} rule={rule} order={index + 1} copy={copy} locale={locale} legacy={legacy} providerName={providerName} mediaName={mediaName} />
          ))}
        </ol>
      ) : (
        <p className="table-card p-4 text-sm text-slate-600">{copy.empty}</p>
      )}
    </div>
  );
}
