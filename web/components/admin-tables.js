"use client";

import Link from "next/link";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { AdminDataTable, SortHeader } from "./admin-data-table";
import { useI18n } from "../lib/use-i18n";
import {
  removeLicenseDeviceAction,
  setLicenseDeviceStatusAction,
  setLicenseStatusAction,
  setPluginEnabledAction,
  setReleaseEnabledAction,
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

function trialStatus(value) {
  if (!value) return "-";
  const expires = new Date(value);
  if (Number.isNaN(expires.getTime())) return "-";
  const active = expires.getTime() > Date.now();
  return (
    <div className="space-y-1">
      <Badge variant={active ? "brand" : "danger"}>{active ? "Trial" : "Expired"}</Badge>
      <div className="text-xs text-slate-500">{expires.toLocaleDateString()}</div>
    </div>
  );
}

export function LicensesTable({ rows, empty }) {
  const { t } = useI18n();
  const columns = [
    { accessorKey: "id", header: ({ column }) => <SortHeader column={column}>{t.admin.nav.licenses}</SortHeader>, cell: ({ row }) => <Link href={`/admin/licenses/${row.original.id}`} className="font-mono text-brand">{row.original.id}</Link> },
    { accessorKey: "customer_name", header: "Customer", cell: ({ row }) => row.original.customer_name || "-" },
    { accessorKey: "plan", header: ({ column }) => <SortHeader column={column}>Plan</SortHeader> },
    { accessorKey: "seats", header: ({ column }) => <SortHeader column={column}>Seats</SortHeader> },
    { accessorKey: "expires_at", header: ({ column }) => <SortHeader column={column}>Expires</SortHeader>, cell: ({ row }) => formatDate(row.original.expires_at).slice(0, 10) },
    { accessorKey: "status", header: t.admin.common.status, cell: ({ row }) => <Badge variant={row.original.status === "active" ? "success" : "danger"}>{row.original.status}</Badge> },
    {
      id: "action",
      header: t.admin.common.action,
      cell: ({ row }) => (
        <form action={setLicenseStatusAction} onSubmit={(event) => {
          if (row.original.status === "active" && !window.confirm("Disable this license? Active devices will stop refreshing successfully.")) {
            event.preventDefault();
          }
        }}>
          <input type="hidden" name="id" value={row.original.id} />
          <input type="hidden" name="status" value={row.original.status === "active" ? "disabled" : "active"} />
          <Button variant="outline" size="sm">{row.original.status === "active" ? t.admin.common.disabled : "Restore"}</Button>
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
    { accessorKey: "license_id", header: t.admin.nav.licenses, cell: ({ row }) => <span className="font-mono">{row.original.license_id || "-"}</span> },
    { accessorKey: "platform", header: "Platform", cell: ({ row }) => row.original.platform || "-" },
    { accessorKey: "arch", header: "Arch", cell: ({ row }) => row.original.arch || "-" },
    { accessorKey: "app_version", header: "Version", cell: ({ row }) => row.original.app_version || "-" },
    { accessorKey: "trial_ends_at", header: "Trial", cell: ({ row }) => trialStatus(row.original.trial_ends_at) },
    { accessorKey: "license_status", header: t.admin.common.status, cell: ({ row }) => row.original.license_status ? <Badge variant={row.original.license_status === "active" ? "success" : "danger"}>{row.original.license_status}</Badge> : "-" },
    { accessorKey: "last_seen_at", header: ({ column }) => <SortHeader column={column}>Last seen</SortHeader>, cell: ({ row }) => formatDate(row.original.last_seen_at) },
    {
      id: "action",
      header: t.admin.common.action,
      cell: ({ row }) => row.original.license_device_id ? (
        <div className="flex gap-2">
          <form action={setLicenseDeviceStatusAction}>
            <input type="hidden" name="id" value={row.original.license_device_id} />
            <input type="hidden" name="status" value={row.original.license_status === "active" ? "disabled" : "active"} />
            <Button variant="outline" size="sm" formAction={setLicenseDeviceStatusAction}>{row.original.license_status === "active" ? t.admin.common.disabled : "Restore"}</Button>
          </form>
          <form action={removeLicenseDeviceAction} onSubmit={(event) => {
            if (!window.confirm("Unbind this device from the license?")) event.preventDefault();
          }}>
            <input type="hidden" name="id" value={row.original.license_device_id} />
            <Button variant="danger" size="sm">Unbind</Button>
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
    { accessorKey: "version", header: ({ column }) => <SortHeader column={column}>Version</SortHeader> },
    { accessorKey: "platform", header: "Platform" },
    { accessorKey: "enabled", header: t.admin.common.status, cell: ({ row }) => statusBadge(row.original.enabled) },
    { accessorKey: "force_update", header: "Force", cell: ({ row }) => String(Boolean(row.original.force_update)) },
    { accessorKey: "size_bytes", header: "Size", cell: ({ row }) => row.original.size_bytes ? `${(Number(row.original.size_bytes) / 1024 / 1024).toFixed(1)} MB` : "-" },
    { accessorKey: "url", header: "URL", cell: ({ row }) => <span className="block max-w-[360px] truncate text-slate-500">{row.original.url}</span> },
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

export function PluginsTable({ rows, empty }) {
  const { t } = useI18n();
  const columns = [
    { accessorKey: "id", header: ({ column }) => <SortHeader column={column}>ID</SortHeader>, cell: ({ row }) => <span className="font-mono">{row.original.id}</span> },
    { accessorKey: "name", header: "Name" },
    { accessorKey: "type", header: "Type", cell: ({ row }) => <Badge variant="brand">{row.original.type}</Badge> },
    { accessorKey: "version", header: ({ column }) => <SortHeader column={column}>Version</SortHeader> },
    { accessorKey: "enabled", header: t.admin.common.status, cell: ({ row }) => statusBadge(row.original.enabled) },
    {
      id: "action",
      header: t.admin.common.action,
      cell: ({ row }) => (
        <form action={setPluginEnabledAction}>
          <input type="hidden" name="id" value={row.original.id} />
          <input type="hidden" name="enabled" value={row.original.enabled ? "false" : "true"} />
          <Button variant="outline" size="sm">{row.original.enabled ? t.admin.common.disabled : t.admin.common.enabled}</Button>
        </form>
      ),
    },
  ];
  return <AdminDataTable columns={columns} data={rows} empty={empty} filterPlaceholder={`${t.admin.common.search} ${t.admin.nav.plugins}`} />;
}
