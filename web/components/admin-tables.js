"use client";

import Link from "next/link";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { AdminDataTable, SortHeader } from "./admin-data-table";
import { useI18n } from "../lib/use-i18n";
import {
  deleteConfigProfileAction,
  removeLicenseDeviceAction,
  rollbackConfigProfileAction,
  setLicenseDeviceStatusAction,
  setLicenseStatusAction,
  setConfigProfileEnabledAction,
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
    { accessorKey: "seats", header: ({ column }) => <SortHeader column={column}>{t.admin.cols.seats}</SortHeader> },
    { accessorKey: "expires_at", header: ({ column }) => <SortHeader column={column}>{t.admin.cols.expires}</SortHeader>, cell: ({ row }) => formatDate(row.original.expires_at).slice(0, 10) },
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
          <Button variant="outline" size="sm">{row.original.status === "active" ? t.admin.common.disabled : t.admin.cols.restore}</Button>
        </form>
      ),
    },
  ];
  return <AdminDataTable columns={columns} data={rows} empty={empty} filterPlaceholder={`${t.admin.common.search} ${t.admin.nav.licenses}`} />;
}

export function DevicesTable({ rows, empty }) {
  const { t } = useI18n();
  const columns = [
    { accessorKey: "id", header: ({ column }) => <SortHeader column={column}>{t.admin.nav.devices}</SortHeader>, cell: ({ row }) => <Link href={`/admin/devices/${row.original.id}`} className="font-mono text-brand">{row.original.id}</Link> },
    { accessorKey: "license_id", header: t.admin.nav.licenses, cell: ({ row }) => row.original.license_id ? <Link href={`/admin/licenses/${row.original.license_id}`} className="font-mono text-brand hover:underline">{row.original.license_id}</Link> : <span className="font-mono">-</span> },
    { accessorKey: "platform", header: t.admin.cols.platform, cell: ({ row }) => row.original.platform || "-" },
    { accessorKey: "arch", header: t.admin.cols.arch, cell: ({ row }) => row.original.arch || "-" },
    { accessorKey: "app_version", header: t.admin.cols.version, cell: ({ row }) => row.original.app_version || "-" },
    { accessorKey: "trial_ends_at", header: t.admin.cols.trial, cell: ({ row }) => trialStatus(row.original.trial_ends_at, t.admin.cols) },
    { accessorKey: "license_status", header: t.admin.common.status, cell: ({ row }) => row.original.license_status ? <Badge variant={row.original.license_status === "active" ? "success" : "danger"}>{row.original.license_status}</Badge> : "-" },
    { accessorKey: "last_seen_at", header: ({ column }) => <SortHeader column={column}>{t.admin.cols.lastSeen}</SortHeader>, cell: ({ row }) => formatDate(row.original.last_seen_at) },
    {
      id: "action",
      header: t.admin.common.action,
      cell: ({ row }) => row.original.license_device_id ? (
        <div className="flex gap-2">
          <form action={setLicenseDeviceStatusAction}>
            <input type="hidden" name="id" value={row.original.license_device_id} />
            <input type="hidden" name="status" value={row.original.license_status === "active" ? "disabled" : "active"} />
            <Button variant="outline" size="sm" formAction={setLicenseDeviceStatusAction}>{row.original.license_status === "active" ? t.admin.common.disabled : t.admin.cols.restore}</Button>
          </form>
          <form action={removeLicenseDeviceAction} onSubmit={(event) => {
            if (!window.confirm(t.admin.confirm.unbindDevice)) event.preventDefault();
          }}>
            <input type="hidden" name="id" value={row.original.license_device_id} />
            <Button variant="danger" size="sm">{t.admin.cols.unbind}</Button>
          </form>
        </div>
      ) : "-",
    },
  ];
  return <AdminDataTable columns={columns} data={rows} empty={empty} filterPlaceholder={`${t.admin.common.search} ${t.admin.nav.devices}`} />;
}

export function ReleasesTable({ rows, empty }) {
  const { t } = useI18n();
  const columns = [
    { accessorKey: "version", header: ({ column }) => <SortHeader column={column}>{t.admin.cols.version}</SortHeader> },
    { accessorKey: "platform", header: t.admin.cols.platform },
    { accessorKey: "enabled", header: t.admin.common.status, cell: ({ row }) => statusBadge(row.original.enabled) },
    { accessorKey: "force_update", header: t.admin.cols.force, cell: ({ row }) => String(Boolean(row.original.force_update)) },
    { accessorKey: "size_bytes", header: t.admin.cols.size, cell: ({ row }) => row.original.size_bytes ? `${(Number(row.original.size_bytes) / 1024 / 1024).toFixed(1)} MB` : "-" },
    { accessorKey: "url", header: t.admin.cols.url, cell: ({ row }) => <span className="block max-w-[360px] truncate text-slate-500">{row.original.url}</span> },
    {
      id: "action",
      header: t.admin.common.action,
      cell: ({ row }) => (
        <form action={setReleaseEnabledAction}>
          <input type="hidden" name="id" value={row.original.id} />
          <input type="hidden" name="enabled" value={row.original.enabled ? "false" : "true"} />
          <Button variant="outline" size="sm">{row.original.enabled ? t.admin.common.disabled : t.admin.common.enabled}</Button>
        </form>
      ),
    },
  ];
  return <AdminDataTable columns={columns} data={rows} empty={empty} filterPlaceholder={`${t.admin.common.search} ${t.admin.nav.releases}`} />;
}

export function RuntimePacksTable({ rows, empty }) {
  const { t } = useI18n();
  const columns = [
    { accessorKey: "pack_id", header: ({ column }) => <SortHeader column={column}>{t.admin.cols.pack}</SortHeader>, cell: ({ row }) => <span className="font-mono">{row.original.pack_id}</span> },
    { accessorKey: "platform", header: t.admin.cols.platform },
    { accessorKey: "version", header: ({ column }) => <SortHeader column={column}>{t.admin.cols.version}</SortHeader> },
    { accessorKey: "enabled", header: t.admin.common.status, cell: ({ row }) => statusBadge(row.original.enabled) },
    { accessorKey: "size_bytes", header: t.admin.cols.size, cell: ({ row }) => row.original.size_bytes ? `${(Number(row.original.size_bytes) / 1024 / 1024).toFixed(1)} MB` : "-" },
    { accessorKey: "url", header: t.admin.cols.url, cell: ({ row }) => <span className="block max-w-[360px] truncate text-slate-500">{row.original.url}</span> },
    { accessorKey: "created_at", header: ({ column }) => <SortHeader column={column}>{t.admin.cols.created}</SortHeader>, cell: ({ row }) => formatDate(row.original.created_at) },
    {
      id: "action",
      header: t.admin.common.action,
      cell: ({ row }) => (
        <form action={setRuntimePackEnabledAction}>
          <input type="hidden" name="id" value={row.original.id} />
          <input type="hidden" name="enabled" value={row.original.enabled ? "false" : "true"} />
          <Button variant="outline" size="sm">{row.original.enabled ? t.admin.common.disabled : t.admin.common.enabled}</Button>
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
    { accessorKey: "artifact_url", header: t.admin.cols.fileUrl, cell: ({ row }) => <span className="block max-w-[320px] truncate text-slate-500">{row.original.artifact_url}</span> },
    {
      id: "action",
      header: t.admin.common.action,
      cell: ({ row }) => (
        <form action={setSkillPackageEnabledAction}>
          <input type="hidden" name="id" value={row.original.id} />
          <input type="hidden" name="enabled" value={row.original.enabled ? "false" : "true"} />
          <Button variant="outline" size="sm">{row.original.enabled ? t.admin.common.disabled : t.admin.common.enabled}</Button>
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
    { accessorKey: "artifact_url", header: t.admin.cols.fileUrl, cell: ({ row }) => <span className="block max-w-[320px] truncate text-slate-500">{row.original.artifact_url}</span> },
    {
      id: "action",
      header: t.admin.common.action,
      cell: ({ row }) => (
        <form action={setWorkspaceAppEnabledAction}>
          <input type="hidden" name="id" value={row.original.id} />
          <input type="hidden" name="enabled" value={row.original.enabled ? "false" : "true"} />
          <Button variant="outline" size="sm">{row.original.enabled ? t.admin.common.disabled : t.admin.common.enabled}</Button>
        </form>
      ),
    },
  ];
  return <AdminDataTable columns={columns} data={rows} empty={empty} filterPlaceholder={`${t.admin.common.search} ${t.admin.nav.apps}`} />;
}

function configSummary(config) {
  const value = typeof config === "string" ? tryParseJson(config) : config;
  if (!value || typeof value !== "object") return "-";
  const parts = [];
  const models = Array.isArray(value.models?.presets)
    ? value.models.presets.length
    : Array.isArray(value.models?.catalog)
      ? value.models.catalog.length
      : 0;
  if (models) parts.push(`${models} models`);
  if (value.tools?.pluginRegistryUrl) parts.push("skill registry");
  if (value.policy?.permissionMode) parts.push(`policy: ${value.policy.permissionMode}`);
  return parts.length ? parts.join(" · ") : JSON.stringify(value).slice(0, 80);
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function ConfigProfilesTable({ rows, empty }) {
  const { t } = useI18n();
  const copy = t.admin.configProfiles;
  const columns = [
    { accessorKey: "id", header: ({ column }) => <SortHeader column={column}>ID</SortHeader>, cell: ({ row }) => <span className="font-mono">{row.original.id}</span> },
    { accessorKey: "name", header: copy.name },
    { accessorKey: "scope", header: copy.scope, cell: ({ row }) => <Badge variant="brand">{row.original.scope}</Badge> },
    { accessorKey: "target_id", header: copy.targetId, cell: ({ row }) => <span className="font-mono">{row.original.target_id || "-"}</span> },
    { accessorKey: "priority", header: ({ column }) => <SortHeader column={column}>{copy.priority}</SortHeader> },
    { accessorKey: "rollout_percent", header: copy.rolloutPercent, cell: ({ row }) => `${Number(row.original.rollout_percent ?? 100)}%` },
    { accessorKey: "enabled", header: t.admin.common.status, cell: ({ row }) => statusBadge(row.original.enabled) },
    { accessorKey: "config", header: copy.config, cell: ({ row }) => <span className="block max-w-[460px] truncate text-slate-500">{configSummary(row.original.config)}</span> },
    {
      id: "action",
      header: t.admin.common.action,
      cell: ({ row }) => (
        <div className="flex gap-2">
          <form action={setConfigProfileEnabledAction}>
            <input type="hidden" name="id" value={row.original.id} />
            <input type="hidden" name="enabled" value={row.original.enabled ? "false" : "true"} />
            <Button variant="outline" size="sm">{row.original.enabled ? t.admin.common.disabled : t.admin.common.enabled}</Button>
          </form>
          <form action={rollbackConfigProfileAction} onSubmit={(event) => {
            if (!window.confirm(copy.rollbackConfirm)) event.preventDefault();
          }}>
            <input type="hidden" name="id" value={row.original.id} />
            <Button variant="outline" size="sm">{copy.rollback}</Button>
          </form>
          <form action={deleteConfigProfileAction} onSubmit={(event) => {
            if (!window.confirm(copy.deleteConfirm)) event.preventDefault();
          }}>
            <input type="hidden" name="id" value={row.original.id} />
            <Button variant="danger" size="sm">{copy.delete}</Button>
          </form>
        </div>
      ),
    },
  ];
  return <AdminDataTable columns={columns} data={rows} empty={empty} filterPlaceholder={`${t.admin.common.search} ${copy.title}`} />;
}
