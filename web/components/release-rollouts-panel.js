"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { DangerForm } from "./danger-form";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { useI18n } from "../lib/use-i18n";
import { rolloutAction, setAutoPauseAction, setLegacyNoticeAction, setReleaseSupportAction } from "../app/admin/actions";

// The release console is organised by what an operator wants to do, not by the
// tables behind it: what is happening now per platform, then "I want to…",
// each task in plain words with its consequence shown before it is confirmed.

const STEPS = [1, 5, 10, 25, 50, 100];
const STATE_VARIANT = { draft: "default", rolling: "brand", paused: "warning", halted: "danger", complete: "success" };

export function platformName(key, t) {
  return t.admin.platforms?.[key] || key;
}

function compareVersions(a, b) {
  const pa = String(a || "").split(/[.+-]/).map((p) => Number.parseInt(p, 10) || 0);
  const pb = String(b || "").split(/[.+-]/).map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

const fill = (text, values) => Object.entries(values).reduce((out, [k, v]) => out.replaceAll(`{${k}}`, String(v)), String(text || ""));
const pct = (value) => `${Math.round(Number(value || 0) * 100) / 100}`;

function ActionButton({ id, action, percent, label, confirm, variant = "outline" }) {
  const fields = (
    <>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="action" value={action} />
      {percent ? <input type="hidden" name="percent" value={percent} /> : null}
      <Button variant={variant} size="sm">{label}</Button>
    </>
  );
  return confirm ? <DangerForm action={rolloutAction} confirm={confirm}>{fields}</DangerForm> : <form action={rolloutAction}>{fields}</form>;
}

function HealthLine({ health, copy }) {
  if (!health) return null;
  const verdict = health.verdict;
  const text = verdict === "worse" || verdict === "ok"
    ? fill(copy.healthCompare, { rate: pct(health.rate), base: pct(health.baseRate), baseline: health.baseline?.version || "" })
    : copy.healthVerdict[verdict] || verdict;
  return <p className={`mt-1 text-xs ${verdict === "worse" ? "font-semibold text-red-700" : "text-slate-500"}`}>{verdict === "worse" ? `⚠ ${copy.healthWorse} · ` : ""}{text}</p>;
}

// ── What is happening now ──────────────────────────────────────────────────

function ActiveRollout({ rollout, name, copy }) {
  const next = STEPS.filter((step) => step > Number(rollout.percent || 0) && step < 100);
  const funnel = rollout.funnel || {};
  return (
    <div className="mt-3 rounded-lg border border-brand/30 bg-brand/5 p-3">
      <p className="text-sm">
        {fill(copy.rollingNow, { version: rollout.version, percent: rollout.percent })}{" "}
        <Badge variant={STATE_VARIANT[rollout.state] || "default"}>{copy.states[rollout.state] || rollout.state}</Badge>
      </p>
      <p className="mt-1 text-xs text-slate-600">{fill(copy.funnel, { started: funnel.download_started || 0, downloaded: funnel.downloaded || 0, failed: funnel.download_failed || 0, installing: funnel.install_started || 0, running: rollout.installed || 0 })}</p>
      <HealthLine health={rollout.health} copy={copy} />
      <p className="mt-2 text-xs text-slate-500">{copy.rollingHow}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {next.map((step) => <ActionButton key={step} id={rollout.id} action="raise" percent={step} label={fill(copy.widenTo, { n: step })} />)}
        {rollout.state === "rolling" ? <ActionButton id={rollout.id} action="pause" label={copy.pause} /> : null}
        {rollout.state === "paused" ? <ActionButton id={rollout.id} action="resume" label={copy.resume} /> : null}
        <ActionButton id={rollout.id} action="complete" label={copy.complete} variant="default" confirm={fill(copy.completeConfirm, { version: rollout.version, platform: name })} />
        <ActionButton id={rollout.id} action="halt" label={copy.halt} variant="danger" confirm={fill(copy.haltConfirm, { version: rollout.version, platform: name })} />
      </div>
    </div>
  );
}

function DraftRollout({ rollout, copy }) {
  return (
    <form action={rolloutAction} className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-slate-300 p-3 text-sm">
      <input type="hidden" name="id" value={rollout.id} />
      <input type="hidden" name="action" value="start" />
      <span>{fill(copy.draftReady, { version: rollout.version })}</span>
      <select name="percent" defaultValue={rollout.immutableFeed ? "10" : "100"} className="rounded-md border border-slate-300 px-2 py-1" aria-label={copy.startAt}>
        {STEPS.filter((step) => rollout.immutableFeed || step === 100).map((step) => <option key={step} value={step}>{step === 100 ? copy.startEveryone : fill(copy.startPercent, { n: step })}</option>)}
      </select>
      <Button variant="outline" size="sm">{copy.start}</Button>
      {!rollout.immutableFeed ? <span className="text-xs text-slate-500">{copy.noOwnFeed}</span> : null}
    </form>
  );
}

function PlatformStatus({ entry, copy, t }) {
  const name = platformName(entry.platform, t);
  const support = entry.support || {};
  const share = entry.activeWeek ? Math.round(((entry.full?.installed || 0) / entry.activeWeek) * 100) : 0;
  return (
    <section className="table-card p-4" aria-label={name}>
      <h3 className="text-base font-semibold text-slate-900">{name}</h3>
      <p className="mt-1 text-sm text-slate-700">{entry.full ? fill(copy.everyoneGets, { version: entry.full.version }) : copy.nothingOffered}</p>
      <p className="mt-0.5 text-xs text-slate-500">{fill(copy.adoption, { active: entry.activeWeek || 0, updated: entry.full?.installed || 0, share })}</p>
      {support.minSupportedVersion ? <p className="mt-1 text-xs text-amber-800">{fill(copy.requiredNow, { version: support.minSupportedVersion, n: support.belowMinimum || 0 })}{support.mandateDeadline ? ` · ${fill(copy.deadlineOn, { when: new Date(support.mandateDeadline).toLocaleDateString() })}` : ""}</p> : null}
      {(support.blockedVersions || []).length ? <p className="mt-1 text-xs text-red-700">{fill(copy.pulledNow, { versions: support.blockedVersions.join("、") })}</p> : null}
      {entry.active ? <ActiveRollout rollout={entry.active} name={name} copy={copy} /> : null}
      {entry.betaActive ? <p className="mt-2 text-xs text-slate-600"><Badge variant="brand">beta</Badge> {fill(copy.betaNow, { version: entry.betaActive.version, percent: entry.betaActive.percent })}</p> : null}
      {!entry.active ? (entry.drafts || []).map((rollout) => <DraftRollout key={rollout.id} rollout={rollout} copy={copy} />) : null}
      {(entry.halted || []).map((rollout) => (
        <div key={rollout.id} className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <span>{fill(copy.haltedNote, { version: rollout.version, percent: rollout.percent })}</span>
          <ActionButton id={rollout.id} action="reopen" label={copy.reopen} />
        </div>
      ))}
      {!entry.active && !(entry.drafts || []).length && !(entry.halted || []).length ? <p className="mt-3 text-xs text-slate-500">{copy.nothingPending}</p> : null}
    </section>
  );
}

// ── I want to… ─────────────────────────────────────────────────────────────

function Task({ title, children, id }) {
  return (
    <section id={id} className="table-card p-4">
      <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      <div className="mt-2 space-y-2 text-sm text-slate-700">{children}</div>
    </section>
  );
}

function usePicker(platforms) {
  const versionsOf = (key) => platforms.find((p) => p.platform === key)?.releasedVersions || [];
  const [platform, setPlatformState] = useState(platforms[0]?.platform || "");
  const [version, setVersion] = useState(versionsOf(platforms[0]?.platform || "")[0] || "");
  const entry = platforms.find((p) => p.platform === platform) || platforms[0] || {};
  const setPlatform = (key) => { setPlatformState(key); setVersion(versionsOf(key)[0] || ""); };
  return { platform, setPlatform, version, setVersion, versionsOf, entry };
}

function PlatformVersionPicker({ platforms, t, copy, picker }) {
  return (
    <div className="flex flex-wrap gap-2">
      <select name="platform" value={picker.platform} onChange={(event) => picker.setPlatform(event.target.value)} className="rounded-md border border-slate-300 px-2 py-1" aria-label={copy.pickPlatform}>
        {platforms.map((entry) => <option key={entry.platform} value={entry.platform}>{platformName(entry.platform, t)}</option>)}
      </select>
      <select name="version" value={picker.version} onChange={(event) => picker.setVersion(event.target.value)} className="rounded-md border border-slate-300 px-2 py-1 font-mono" aria-label={copy.pickVersion}>
        {picker.versionsOf(picker.platform).map((v) => <option key={v} value={v}>{v}</option>)}
      </select>
    </div>
  );
}

function RequireUpdateTask({ platforms, copy, t }) {
  const picker = usePicker(platforms);
  const affected = useMemo(() => (picker.entry.versions || []).filter((row) => compareVersions(row.version, picker.version) < 0).reduce((sum, row) => sum + row.devices, 0), [picker.entry, picker.version]);
  const current = picker.entry.support?.minSupportedVersion || "";
  const name = platformName(picker.platform, t);
  return (
    <Task id="require" title={copy.taskRequire}>
      <p>{copy.taskRequireWhat}</p>
      <DangerForm action={setReleaseSupportAction} confirm={fill(copy.requireConfirm, { platform: name, version: picker.version, n: affected })}>
        <input type="hidden" name="op" value="require" />
        <PlatformVersionPicker platforms={platforms} t={t} copy={copy} picker={picker} />
        <input type="hidden" name="minSupportedVersion" value={picker.version} />
        <label className="mt-2 grid gap-1 text-xs text-slate-600">{copy.deadlineOptional}
          <input type="datetime-local" name="mandateDeadline" className="w-64 rounded-md border border-slate-300 px-2 py-1 text-sm" />
        </label>
        <p className="mt-2 text-xs font-medium text-amber-800">{fill(copy.requireImpact, { n: affected, version: picker.version })}</p>
        <div className="mt-2"><Button variant="default" size="sm">{copy.requireRun}</Button></div>
      </DangerForm>
      {current ? (
        <form action={setReleaseSupportAction} className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <input type="hidden" name="op" value="require" />
          <input type="hidden" name="platform" value={picker.platform} />
          <input type="hidden" name="minSupportedVersion" value="" />
          <input type="hidden" name="mandateDeadline" value="" />
          <span>{fill(copy.requireCurrent, { platform: name, version: current })}</span>
          <Button variant="outline" size="sm">{copy.requireClear}</Button>
        </form>
      ) : null}
      <p className="text-xs text-slate-500">{copy.taskRequireHow}</p>
    </Task>
  );
}

function PullVersionTask({ platforms, copy, t }) {
  const picker = usePicker(platforms);
  const using = (picker.entry.versions || []).find((row) => row.version === picker.version)?.devices || 0;
  const blocked = picker.entry.support?.blockedVersions || [];
  const name = platformName(picker.platform, t);
  return (
    <Task id="pull" title={copy.taskPull}>
      <p>{copy.taskPullWhat}</p>
      <DangerForm action={setReleaseSupportAction} confirm={fill(copy.pullConfirm, { platform: name, version: picker.version, n: using })}>
        <input type="hidden" name="op" value="block" />
        <input type="hidden" name="blocked" value={blocked.join(",")} />
        <PlatformVersionPicker platforms={platforms} t={t} copy={copy} picker={picker} />
        <p className="mt-2 text-xs font-medium text-red-700">{fill(copy.pullImpact, { n: using })}</p>
        <div className="mt-2"><Button variant="danger" size="sm">{copy.pullRun}</Button></div>
      </DangerForm>
      {blocked.length ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-slate-600">{fill(copy.pulledList, { platform: name })}</span>
          {blocked.map((v) => (
            <form key={v} action={setReleaseSupportAction} className="inline-flex items-center gap-1">
              <input type="hidden" name="op" value="unblock" />
              <input type="hidden" name="platform" value={picker.platform} />
              <input type="hidden" name="version" value={v} />
              <input type="hidden" name="blocked" value={blocked.join(",")} />
              <Badge variant="danger">{v}</Badge>
              <Button variant="outline" size="sm">{copy.unblock}</Button>
            </form>
          ))}
        </div>
      ) : null}
      <p className="text-xs text-slate-500">{copy.taskPullHow}</p>
    </Task>
  );
}

function PublishTask({ copy }) {
  return (
    <Task id="publish" title={copy.taskPublish}>
      <ol className="list-decimal space-y-1 ps-5">
        <li>{copy.publishStep1}<pre className="mt-1 overflow-x-auto rounded-md bg-slate-900 px-3 py-2 font-mono text-xs text-slate-100">npm run release:one -- --bump patch --upload --rollout 10 --notes "…"</pre></li>
        <li>{copy.publishStep2}</li>
        <li>{copy.publishStep3}<pre className="mt-1 overflow-x-auto rounded-md bg-slate-900 px-3 py-2 font-mono text-xs text-slate-100">npm run release:promote -- --version 0.1.x</pre></li>
      </ol>
      <p className="text-xs text-slate-500">{copy.publishNote}</p>
    </Task>
  );
}

function AutoPauseTask({ autoPause = {}, copy }) {
  return (
    <Task id="protect" title={copy.taskProtect}>
      <p>{copy.taskProtectWhat}</p>
      <form action={setAutoPauseAction} className="space-y-2">
        <label className="flex items-center gap-2"><input type="checkbox" name="enabled" defaultChecked={Boolean(autoPause.enabled)} />{copy.autoPauseEnabled}</label>
        <details className="text-xs text-slate-600">
          <summary className="cursor-pointer">{fill(copy.protectAdvanced, { ratio: autoPause.worseRatio, devices: autoPause.minDevices, hours: autoPause.windowHours })}</summary>
          <div className="mt-2 flex flex-wrap gap-3">
            <label className="grid gap-1">{copy.minDevices}<input name="minDevices" type="number" defaultValue={autoPause.minDevices} className="w-24 rounded-md border border-slate-300 px-2 py-1" /></label>
            <label className="grid gap-1">{copy.worseRatio}<input name="worseRatio" type="number" step="0.1" defaultValue={autoPause.worseRatio} className="w-24 rounded-md border border-slate-300 px-2 py-1" /></label>
            <label className="grid gap-1">{copy.windowHours}<input name="windowHours" type="number" defaultValue={autoPause.windowHours} className="w-24 rounded-md border border-slate-300 px-2 py-1" /></label>
          </div>
        </details>
        <Button variant="outline" size="sm">{copy.save}</Button>
      </form>
    </Task>
  );
}

function LegacyNoticeTask({ legacyNotice = {}, platforms, copy }) {
  const hits = legacyNotice.hits || {};
  const anyMinimum = platforms.some((p) => p.support?.minSupportedVersion);
  return (
    <Task id="notice" title={copy.taskNotice}>
      <p>{copy.taskNoticeWhat}</p>
      {!anyMinimum ? <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">{copy.noticeNeedsMinimum}</p> : null}
      <form action={setLegacyNoticeAction} className="space-y-2">
        <label className="flex items-center gap-2"><input type="checkbox" name="enabled" defaultChecked={Boolean(legacyNotice.enabled)} />{copy.legacyNoticeEnabled}</label>
        <details className="text-xs text-slate-600">
          <summary className="cursor-pointer">{copy.noticeTrial}</summary>
          <label className="mt-2 grid gap-1">{copy.trialLicenses}<textarea name="licenseIds" rows={2} defaultValue={(legacyNotice.licenseIds || []).join("\n")} className="rounded-md border border-slate-300 px-2 py-1 font-mono" /></label>
          <label className="mt-2 grid gap-1">{copy.trialDevices}<textarea name="deviceIds" rows={2} defaultValue={(legacyNotice.deviceIds || []).join("\n")} className="rounded-md border border-slate-300 px-2 py-1 font-mono" /></label>
        </details>
        <Button variant="outline" size="sm">{copy.save}</Button>
      </form>
      <p className="text-xs text-slate-500">{fill(copy.noticeHits, { requests: hits.requests || 0, devices: hits.devices || 0 })} · {copy.noticeCaveat}</p>
    </Task>
  );
}

/** The release console: what is happening now, then the tasks in plain words. */
export function ReleaseRolloutsPanel({ platforms = [], autoPause = null, legacyNotice = null }) {
  const { t } = useI18n();
  const copy = t.admin.releaseConsole;
  if (!platforms.length) return null;
  return (
    <div className="mb-6 space-y-6">
      <div>
        <h2 className="mb-2 text-sm font-semibold text-slate-500">{copy.nowTitle}</h2>
        <div className="grid gap-3 lg:grid-cols-3">
          {platforms.map((entry) => <PlatformStatus key={entry.platform} entry={entry} copy={copy} t={t} />)}
        </div>
      </div>
      <div>
        <h2 className="mb-2 text-sm font-semibold text-slate-500">{copy.tasksTitle}</h2>
        <div className="grid gap-3 lg:grid-cols-2">
          <PublishTask copy={copy} />
          <RequireUpdateTask platforms={platforms} copy={copy} t={t} />
          <PullVersionTask platforms={platforms} copy={copy} t={t} />
          {autoPause ? <AutoPauseTask autoPause={autoPause} copy={copy} /> : null}
          {legacyNotice ? <LegacyNoticeTask legacyNotice={legacyNotice} platforms={platforms} copy={copy} /> : null}
          <Task id="cleanup" title={copy.taskCleanup}>
            <p>{copy.taskCleanupWhat}</p>
            <Link href="/admin/releases/archive" className="inline-flex rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-50">{copy.cleanupOpen}</Link>
          </Task>
        </div>
      </div>
    </div>
  );
}
