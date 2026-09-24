"use client";

import { DangerForm } from "./danger-form";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { useI18n } from "../lib/use-i18n";
import { rolloutAction, setReleaseSupportAction } from "../app/admin/actions";

// The widening steps offered from a given percentage. Only upward: stopping is pause/halt.
const STEPS = [1, 5, 10, 25, 50, 100];

const STATE_VARIANT = { draft: "default", rolling: "brand", paused: "warning", halted: "danger", complete: "success" };

function pct(value) {
  return `${Math.round(Number(value || 0) * 100) / 100}`;
}

function HealthLine({ health, copy }) {
  if (!health) return null;
  const verdict = health.verdict;
  const text = verdict === "worse" || verdict === "ok"
    ? copy.healthCompare
      .replace("{rate}", pct(health.rate))
      .replace("{base}", pct(health.baseRate))
      .replace("{baseline}", health.baseline?.version || "")
    : copy.healthVerdict[verdict] || verdict;
  return (
    <p className={`mt-1 text-xs ${verdict === "worse" ? "font-semibold text-red-700" : "text-slate-500"}`}>
      {verdict === "worse" ? `⚠ ${copy.healthWorse} · ` : ""}{text}
    </p>
  );
}

function ActionButton({ id, action, percent, label, confirm, variant = "outline" }) {
  const fields = (
    <>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="action" value={action} />
      {percent ? <input type="hidden" name="percent" value={percent} /> : null}
      <Button variant={variant} size="sm">{label}</Button>
    </>
  );
  return confirm
    ? <DangerForm action={rolloutAction} confirm={confirm}>{fields}</DangerForm>
    : <form action={rolloutAction}>{fields}</form>;
}

function ActiveRollout({ rollout, copy }) {
  const next = STEPS.filter((step) => step > Number(rollout.percent || 0));
  return (
    <div className="mt-3 rounded-lg border border-slate-200 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-semibold">{rollout.version}</span>
        <Badge variant={STATE_VARIANT[rollout.state] || "default"}>{copy.states[rollout.state] || rollout.state}</Badge>
        <span className="text-sm tabular-nums text-slate-700">{rollout.percent}%</span>
        <span className="text-xs text-slate-500">{copy.installed.replace("{n}", String(rollout.installed || 0))}</span>
      </div>
      <HealthLine health={rollout.health} copy={copy} />
      <div className="mt-2 flex flex-wrap gap-2">
        {next.filter((step) => step < 100).map((step) => (
          <ActionButton key={step} id={rollout.id} action="raise" percent={step} label={copy.widenTo.replace("{n}", String(step))} />
        ))}
        {rollout.state === "rolling" ? <ActionButton id={rollout.id} action="pause" label={copy.pause} /> : null}
        {rollout.state === "paused" ? <ActionButton id={rollout.id} action="resume" label={copy.resume} /> : null}
        <ActionButton id={rollout.id} action="complete" label={copy.complete} variant="default"
          confirm={copy.completeConfirm.replace("{version}", rollout.version).replace("{platform}", rollout.platform)} />
        <ActionButton id={rollout.id} action="halt" label={copy.halt} variant="danger"
          confirm={copy.haltConfirm.replace("{version}", rollout.version).replace("{platform}", rollout.platform)} />
      </div>
    </div>
  );
}

function StartRollout({ rollout, copy }) {
  return (
    <form action={rolloutAction} className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-slate-300 p-3 text-sm">
      <input type="hidden" name="id" value={rollout.id} />
      <input type="hidden" name="action" value="start" />
      <span className="font-mono font-semibold">{rollout.version}</span>
      <Badge variant="default">{copy.states.draft}</Badge>
      <select name="percent" defaultValue={rollout.immutableFeed ? "10" : "100"} className="rounded-md border border-slate-300 px-2 py-1" aria-label={copy.startAt}>
        {STEPS.filter((step) => rollout.immutableFeed || step === 100).map((step) => <option key={step} value={step}>{step}%</option>)}
      </select>
      <Button variant="outline" size="sm">{copy.start}</Button>
      {!rollout.immutableFeed ? <span className="text-xs text-slate-500">{copy.noOwnFeed}</span> : null}
    </form>
  );
}

function HaltedRollout({ rollout, copy }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
      <span className="font-mono">{rollout.version}</span>
      <Badge variant="danger">{copy.states.halted}</Badge>
      <span className="text-xs text-slate-500">{rollout.percent}%</span>
      <ActionButton id={rollout.id} action="reopen" label={copy.reopen} />
    </div>
  );
}

function localInput(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// What the platform still supports: the one place "must update" comes from.
function SupportEditor({ platform, support = {}, copy }) {
  return (
    <details className="mt-3 rounded-lg border border-slate-200 p-3 text-sm">
      <summary className="cursor-pointer">
        <span className="font-medium">{copy.support}</span>{" "}
        {support.minSupportedVersion
          ? <span className="text-slate-700">{copy.minimum} <span className="font-mono">{support.minSupportedVersion}</span> · {copy.belowMinimum.replace("{n}", String(support.belowMinimum || 0))}</span>
          : <span className="text-slate-500">{copy.noMinimum}</span>}
        {(support.blockedVersions || []).map((v) => <Badge key={v} variant="danger" className="ms-1">{copy.blocked} {v}</Badge>)}
        {support.mandateDeadline ? <span className="ms-1 text-xs text-slate-500">{copy.deadlineShort} {new Date(support.mandateDeadline).toLocaleDateString()}</span> : null}
      </summary>
      <form action={setReleaseSupportAction} className="mt-3 grid gap-2">
        <input type="hidden" name="platform" value={platform} />
        <input type="hidden" name="channel" value="stable" />
        <label className="grid gap-1 text-xs text-slate-600">{copy.minimum}
          <input name="minSupportedVersion" defaultValue={support.minSupportedVersion || ""} placeholder="0.1.185" className="rounded-md border border-slate-300 px-2 py-1 font-mono text-sm" />
        </label>
        <label className="grid gap-1 text-xs text-slate-600">{copy.blockedList}
          <input name="blockedVersions" defaultValue={(support.blockedVersions || []).join(", ")} placeholder="0.1.184" className="rounded-md border border-slate-300 px-2 py-1 font-mono text-sm" />
        </label>
        <label className="grid gap-1 text-xs text-slate-600">{copy.deadline}
          <input type="datetime-local" name="mandateDeadline" defaultValue={localInput(support.mandateDeadline)} className="rounded-md border border-slate-300 px-2 py-1 text-sm" />
        </label>
        <p className="text-xs text-slate-500">{copy.supportHelp}</p>
        <div><Button variant="outline" size="sm">{copy.saveSupport}</Button></div>
      </form>
    </details>
  );
}

/** Per platform: who gets what now, the rollout in progress, and how it is doing. */
export function ReleaseRolloutsPanel({ platforms = [] }) {
  const { t } = useI18n();
  const copy = t.admin.rollouts;
  if (!platforms.length) return null;
  return (
    <div className="mb-4 grid gap-3 lg:grid-cols-3">
      {platforms.map((entry) => (
        <section key={entry.platform} className="table-card p-4">
          <div className="flex items-baseline justify-between">
            <h2 className="font-mono text-sm font-semibold">{entry.platform}</h2>
            <span className="text-xs text-slate-500">{copy.activeWeek.replace("{n}", String(entry.activeWeek || 0))}</span>
          </div>
          <p className="mt-2 text-sm text-slate-700">
            {copy.everyone}{" "}
            <span className="font-mono font-semibold">{entry.full?.version || "—"}</span>
            {entry.full ? <span className="ms-2 text-xs text-slate-500">{copy.installed.replace("{n}", String(entry.full.installed || 0))}</span> : null}
          </p>
          {entry.active ? <ActiveRollout rollout={entry.active} copy={copy} /> : null}
          {entry.betaActive ? (
            <p className="mt-2 text-xs text-slate-600"><Badge variant="brand">beta</Badge> <span className="font-mono">{entry.betaActive.version}</span> {copy.states[entry.betaActive.state]} {entry.betaActive.percent}%</p>
          ) : null}
          {!entry.active ? (entry.drafts || []).map((rollout) => <StartRollout key={rollout.id} rollout={rollout} copy={copy} />) : null}
          {(entry.halted || []).map((rollout) => <HaltedRollout key={rollout.id} rollout={rollout} copy={copy} />)}
          {!entry.active && !(entry.drafts || []).length && !(entry.halted || []).length ? <p className="mt-3 text-xs text-slate-500">{copy.nothingPending}</p> : null}
          <SupportEditor platform={entry.platform} support={entry.support} copy={copy} />
        </section>
      ))}
    </div>
  );
}
