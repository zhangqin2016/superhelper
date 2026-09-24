"use client";

import Link from "next/link";
import { DangerForm } from "./danger-form";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { AdminDataTable, SortHeader } from "./admin-data-table";
import { useI18n } from "../lib/use-i18n";
import { RowActions } from "./row-actions";
import {
  removeLicenseDeviceAction,
  setLicenseDeviceStatusAction,
  setLicenseStatusAction,
  setReleaseEnabledAction,
  setRuntimePackEnabledAction,
  setSkillPackageEnabledAction,
  setWorkspaceAppEnabledAction,
} from "../app/admin/actions";

function statusBadge(active) {
  return <StatusBadge active={active} />;
}

function StatusBadge({ active }) {
  const { t } = useI18n();
  return <Badge variant={active ? "success" : "danger"}>{active ? t.admin.common.enabled : t.admin.common.disabled}</Badge>;
}

function formatDate(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function trialStatus(value, labels) {
  if (!value) return "-";
  const expires = new Date(value);
  if (Number.isNaN(expires.getTime())) return "-";
  const active = expires.getTime() > Date.now();
  return (
    <div className="space-y-1">
      <Badge variant={active ? "brand" : "danger"}>{active ? labels.trial : labels.expired}</Badge>
      <div className="text-xs text-slate-500">{expires.toLocaleDateString()}</div>
    </div>
  );
}

export function LicensesTable({ rows, empty }) {
  const { t } = useI18n();
  const columns = [
    { accessorKey: "id", header: ({ column }) => <SortHeader column={column}>{t.admin.nav.licenses}</SortHeader>, cell: ({ row }) => <Link href={`/admin/licenses/${row.original.id}`} className="font-mono text-brand">{row.original.id}</Link> },
    { accessorKey: "customer_name", header: t.admin.cols.customer, cell: ({ row }) => row.original.customer_name || "-" },
    { accessorKey: "plan", header: ({ column }) => <SortHeader column={column}>{t.admin.cols.plan}</SortHeader> },
    {
      // Used against allowed, so an unused license is visible at a glance.
      accessorKey: "active_devices",
      header: ({ column }) => <SortHeader column={column}>{t.admin.cols.seatsUsed}</SortHeader>,
      cell: ({ row }) => {
        const used = Number(row.original.active_devices ?? 0);
        const seats = Number(row.original.seats ?? 0);
        return (
          <span className={`tabular-nums ${used === 0 ? "text-amber-700" : seats && used >= seats ? "font-semibold text-slate-950" : ""}`}>
            {used} / {seats || "∞"}
          </span>
        );
      },
    },
    {
      accessorKey: "expires_at",
      header: ({ column }) => <SortHeader column={column}>{t.admin.cols.expires}</SortHeader>,
      cell: ({ row }) => {
        const at = new Date(row.original.expires_at).getTime();
        if (!row.original.expires_at || !Number.isFinite(at)) return "-";
        const date = new Date(at).toLocaleDateString();
        if (at < Date.now()) return <span className="flex items-center gap-2 whitespace-nowrap">{date}<Badge variant="danger">{t.admin.cols.expired}</Badge></span>;
        const days = Math.ceil((at - Date.now()) / 86_400_000);
        if (days <= 30) return <span className="flex items-center gap-2 whitespace-nowrap">{date}<Badge variant="warning">{t.admin.cols.expiresInDays.replace("{n}", String(days))}</Badge></span>;
        return date;
      },
    },
    { accessorKey: "status", header: t.admin.common.status, cell: ({ row }) => <Badge variant={row.original.status === "active" ? "success" : "danger"}>{row.original.status}</Badge> },
    {
      id: "action",
      header: t.admin.common.action,
      cell: ({ row }) => (
        <form action={setLicenseStatusAction} onSubmit={(event) => {
          if (row.original.status === "active" && !window.confirm(t.admin.confirm.disableLicense)) {
            event.preventDefault();
          }
        }}>
          <input type="hidden" name="id" value={row.original.id} />
          <input type="hidden" name="status" value={row.original.status === "active" ? "disabled" : "active"} />
          <Button variant="outline" size="sm">{row.original.status === "active" ? (t.admin.cols.disableAction) : t.admin.cols.restore}</Button>
        </form>
      ),
    },
  ];
  return <AdminDataTable columns={columns} data={rows} empty={empty} filterPlaceholder={`${t.admin.common.search} ${t.admin.nav.licenses}`} />;
}

function VersionCell({ version, latest, behindLabel }) {
  if (!version) return "-";
  const behind = latest && compareVersions(version, latest) < 0;
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <span className="font-mono">{version}</span>
      {behind ? <Badge variant="warning" title={`${behindLabel} ${latest}`}>→ {latest}</Badge> : null}
    </span>
  );
}

// Versions compare by meaning: as text "0.1.99" sorts after "0.1.183".
function compareVersions(a, b) {
  const pa = String(a || "").split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  const pb = String(b || "").split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

export function DevicesTable({ rows, latest = {}, empty }) {
  const { t } = useI18n();
  const copy = t.admin.devicesList;
  const columns = [
    { accessorKey: "id", header: ({ column }) => <SortHeader column={column}>{t.admin.nav.devices}</SortHeader>, cell: ({ row }) => <Link href={`/admin/devices/${row.original.id}`} className="font-mono text-brand">{row.original.id}</Link> },
    // A licensed device's trial date means nothing; only an unlicensed one is on trial.
    { accessorKey: "license_id", header: t.admin.nav.licenses, cell: ({ row }) => row.original.license_id ? <Link href={`/admin/licenses/${row.original.license_id}`} className="font-mono text-brand hover:underline">{row.original.license_id}</Link> : trialStatus(row.original.trial_ends_at, t.admin.cols) },
    { accessorKey: "platform", header: t.admin.cols.platform, cell: ({ row }) => [row.original.platform, row.original.arch].filter(Boolean).join("-") || "-" },
    { accessorKey: "app_version", header: t.admin.cols.version, cell: ({ row }) => <VersionCell version={row.original.app_version} latest={latest[[row.original.platform, row.original.arch].filter(Boolean).join("-")] || ""} behindLabel={copy.behind} /> },
    { accessorKey: "license_status", header: t.admin.common.status, cell: ({ row }) => row.original.license_status ? <Badge variant={row.original.license_status === "active" ? "success" : "danger"}>{row.original.license_status}</Badge> : "-" },
    { accessorKey: "last_seen_at", header: ({ column }) => <SortHeader column={column}>{t.admin.cols.lastSeen}</SortHeader>, cell: ({ row }) => formatDate(row.original.last_seen_at) },
    {
      id: "action",
      header: t.admin.common.action,
      cell: ({ row }) => row.original.license_device_id ? (
        <RowActions>
          <form action={setLicenseDeviceStatusAction}>
            <input type="hidden" name="id" value={row.original.license_device_id} />
            <input type="hidden" name="status" value={row.original.license_status === "active" ? "disabled" : "active"} />
            <Button variant="outline" size="sm" formAction={setLicenseDeviceStatusAction}>{row.original.license_status === "active" ? t.admin.cols.disableAction : t.admin.cols.restore}</Button>
          </form>
          <DangerForm action={removeLicenseDeviceAction} confirm={t.admin.confirm.unbindDevice}>
            <input type="hidden" name="id" value={row.original.license_device_id} />
            <Button variant="danger" size="sm">{t.admin.cols.unbind}</Button>
          </DangerForm>
        </RowActions>
      ) : "-",
    },
  ];
  return <AdminDataTable columns={columns} data={rows} empty={empty} filterPlaceholder={`${t.admin.common.search} ${t.admin.nav.devices}`} />;
}

function fileName(url) {
  const value = String(url || "");
  return decodeURIComponent(value.split("?")[0].split("/").pop() || "") || "-";
}

// One row per version — a version ships to several platforms, and three rows
// for one release made a 415-row list read as 1,245. Each platform is a chip
// that says what it is to clients now; the rare per-platform switch sits under
// "more", and the decisions (require / pull) live in the tasks above.
export function ReleasesTable({ rows, latest = {}, support = {}, empty }) {
  const { t } = useI18n();
  const copy = t.admin.releaseConsole;
  const groups = [];
  const byVersion = new Map();
  for (const row of rows) {
    if (!byVersion.has(row.version)) {
      const group = { version: row.version, rows: [], created_at: row.created_at, notes: row.notes || "" };
      byVersion.set(row.version, group);
      groups.push(group);
    }
    const group = byVersion.get(row.version);
    group.rows.push(row);
    if (new Date(row.created_at) < new Date(group.created_at)) group.created_at = row.created_at;
  }
  const chip = (row) => {
    const policy = support[row.platform] || {};
    const name = t.admin.platforms?.[row.platform] || row.platform;
    let label = copy.chipSuperseded;
    let variant = "default";
    if (!row.enabled) { label = row.archived_at ? copy.chipArchived : copy.chipDisabled; variant = "default"; }
    else if ((policy.blockedVersions || []).includes(row.version)) { label = copy.chipPulled; variant = "danger"; }
    else if (latest[row.platform] === row.version) { label = copy.chipOffered; variant = "success"; }
    if (policy.minSupportedVersion === row.version && variant !== "danger") label = `${label} · ${copy.chipMinimum}`;
    return <Badge key={row.id} variant={variant} className="me-1 mb-1" title={row.url}>{`${name}：${label}`}</Badge>;
  };
  const columns = [
    { accessorKey: "version", header: ({ column }) => <SortHeader column={column}>{t.admin.cols.version}</SortHeader>, cell: ({ row }) => <span className="font-mono">{row.original.version}</span> },
    { id: "platforms", header: copy.colPlatforms, cell: ({ row }) => <div className="flex flex-wrap">{row.original.rows.map(chip)}</div> },
    { accessorKey: "created_at", header: ({ column }) => <SortHeader column={column}>{copy.colReleased}</SortHeader>, cell: ({ row }) => new Date(row.original.created_at).toLocaleDateString() },
    { id: "notes", header: copy.colNotes, cell: ({ row }) => <span className="line-clamp-2 max-w-md text-xs text-slate-600" title={row.original.notes}>{row.original.notes || "—"}</span> },
    {
      id: "more",
      header: "",
      cell: ({ row }) => (
        <details className="text-xs">
          <summary className="cursor-pointer text-slate-500">{copy.more}</summary>
          <div className="mt-2 space-y-2">
            {row.original.rows.map((item) => (
              <div key={item.id} className="flex flex-wrap items-center gap-2">
                <span className="w-32">{t.admin.platforms?.[item.platform] || item.platform}</span>
                <a href={item.url} className="max-w-[200px] truncate font-mono text-slate-500 hover:text-brand" title={item.url}>{fileName(item.url)}</a>
                <span className="tabular-nums text-slate-400">{item.size_bytes ? `${(Number(item.size_bytes) / 1024 / 1024).toFixed(0)} MB` : ""}</span>
                {!item.archived_at ? (
                  <form action={setReleaseEnabledAction}>
                    <input type="hidden" name="id" value={item.id} />
                    <input type="hidden" name="enabled" value={item.enabled ? "false" : "true"} />
                    <Button variant="outline" size="sm">{item.enabled ? t.admin.cols.disableAction : t.admin.cols.enableAction}</Button>
                  </form>
                ) : null}
              </div>
            ))}
            <p className="text-slate-500">{copy.moreHint}</p>
          </div>
        </details>
      ),
    },
  ];
  return <AdminDataTable columns={columns} data={groups} empty={empty} filterPlaceholder={`${t.admin.common.search} ${t.admin.nav.releases}`} />;
}

export function RuntimePacksTable({ rows, empty }) {
  const { t } = useI18n();
  const columns = [
    { accessorKey: "pack_id", header: ({ column }) => <SortHeader column={column}>{t.admin.cols.pack}</SortHeader>, cell: ({ row }) => <span className="font-mono">{row.original.pack_id}</span> },
    { accessorKey: "platform", header: t.admin.cols.platform },
    { accessorKey: "version", header: ({ column }) => <SortHeader column={column}>{t.admin.cols.version}</SortHeader> },
    { accessorKey: "enabled", header: t.admin.common.status, cell: ({ row }) => statusBadge(row.original.enabled) },
    { accessorKey: "size_bytes", header: t.admin.cols.size, cell: ({ row }) => row.original.size_bytes ? `${(Number(row.original.size_bytes) / 1024 / 1024).toFixed(1)} MB` : "-" },
    { accessorKey: "url", header: t.admin.cols.file, cell: ({ row }) => <a href={row.original.url} title={row.original.url} className="block max-w-[260px] truncate font-mono text-xs text-slate-500 hover:text-brand">{fileName(row.original.url)}</a> },
    { accessorKey: "created_at", header: ({ column }) => <SortHeader column={column}>{t.admin.cols.created}</SortHeader>, cell: ({ row }) => formatDate(row.original.created_at) },
    {
      id: "action",
      header: t.admin.common.action,
      cell: ({ row }) => (
        <form action={setRuntimePackEnabledAction}>
          <input type="hidden" name="id" value={row.original.id} />
          <input type="hidden" name="enabled" value={row.original.enabled ? "false" : "true"} />
          <Button variant="outline" size="sm">{row.original.enabled ? t.admin.cols.disableAction : t.admin.cols.enableAction}</Button>
        </form>
      ),
    },
  ];
  return <AdminDataTable columns={columns} data={rows} empty={empty} filterPlaceholder={`${t.admin.common.search} ${t.admin.nav.runtimePacks}`} />;
}

export function SkillPackagesTable({ rows, empty }) {
  const { t } = useI18n();
  const columns = [
    { accessorKey: "skill_id", header: ({ column }) => <SortHeader column={column}>Skill ID</SortHeader>, cell: ({ row }) => <span className="font-mono">{row.original.skill_id}</span> },
    { accessorKey: "name", header: t.admin.cols.name },
    { accessorKey: "version", header: ({ column }) => <SortHeader column={column}>{t.admin.cols.version}</SortHeader> },
    { accessorKey: "capability_layer", header: t.admin.cols.capability, cell: ({ row }) => <Badge variant="brand">{row.original.capability_layer}</Badge> },
    { accessorKey: "risk_level", header: t.admin.cols.risk, cell: ({ row }) => <Badge variant={row.original.risk_level === "high" ? "danger" : row.original.risk_level === "medium" ? "brand" : "success"}>{row.original.risk_level}</Badge> },
    { accessorKey: "default_eligible", header: t.admin.cols.default, cell: ({ row }) => row.original.default_eligible ? <Badge variant="success">{t.admin.cols.yes}</Badge> : <span className="text-slate-400">{t.admin.cols.no}</span> },
    { accessorKey: "enabled", header: t.admin.common.status, cell: ({ row }) => statusBadge(row.original.enabled) },
    { accessorKey: "artifact_url", header: t.admin.cols.file, cell: ({ row }) => <a href={row.original.artifact_url} title={row.original.artifact_url} className="block max-w-[260px] truncate font-mono text-xs text-slate-500 hover:text-brand">{fileName(row.original.artifact_url)}</a> },
    {
      id: "action",
      header: t.admin.common.action,
      cell: ({ row }) => (
        <form action={setSkillPackageEnabledAction}>
          <input type="hidden" name="id" value={row.original.id} />
          <input type="hidden" name="enabled" value={row.original.enabled ? "false" : "true"} />
          <Button variant="outline" size="sm">{row.original.enabled ? t.admin.cols.disableAction : t.admin.cols.enableAction}</Button>
        </form>
      ),
    },
  ];
  return <AdminDataTable columns={columns} data={rows} empty={empty} filterPlaceholder={`${t.admin.common.search} ${t.admin.nav.skillPackages}`} />;
}

export function WorkspaceAppsTable({ rows, empty }) {
  const { t } = useI18n();
  const columns = [
    { accessorKey: "app_id", header: ({ column }) => <SortHeader column={column}>App ID</SortHeader>, cell: ({ row }) => <span className="font-mono">{row.original.app_id}</span> },
    { accessorKey: "name", header: t.admin.cols.name },
    { accessorKey: "version", header: ({ column }) => <SortHeader column={column}>{t.admin.cols.version}</SortHeader> },
    { accessorKey: "category", header: t.admin.cols.category, cell: ({ row }) => <Badge variant="brand">{row.original.category}</Badge> },
    { accessorKey: "app_type", header: t.admin.cols.type },
    { accessorKey: "risk_level", header: t.admin.cols.risk, cell: ({ row }) => <Badge variant={row.original.risk_level === "high" ? "danger" : row.original.risk_level === "medium" ? "brand" : "success"}>{row.original.risk_level}</Badge> },
    { accessorKey: "featured", header: t.admin.cols.featured, cell: ({ row }) => row.original.featured ? <Badge variant="success">{t.admin.cols.yes}</Badge> : <span className="text-slate-400">{t.admin.cols.no}</span> },
    { accessorKey: "enabled", header: t.admin.common.status, cell: ({ row }) => statusBadge(row.original.enabled) },
    { accessorKey: "artifact_url", header: t.admin.cols.file, cell: ({ row }) => <a href={row.original.artifact_url} title={row.original.artifact_url} className="block max-w-[260px] truncate font-mono text-xs text-slate-500 hover:text-brand">{fileName(row.original.artifact_url)}</a> },
    {
      id: "action",
      header: t.admin.common.action,
      cell: ({ row }) => (
        <form action={setWorkspaceAppEnabledAction}>
          <input type="hidden" name="id" value={row.original.id} />
          <input type="hidden" name="enabled" value={row.original.enabled ? "false" : "true"} />
          <Button variant="outline" size="sm">{row.original.enabled ? t.admin.cols.disableAction : t.admin.cols.enableAction}</Button>
        </form>
      ),
    },
  ];
  return <AdminDataTable columns={columns} data={rows} empty={empty} filterPlaceholder={`${t.admin.common.search} ${t.admin.nav.apps}`} />;
}

