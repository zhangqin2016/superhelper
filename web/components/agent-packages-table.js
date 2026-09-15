"use client";

import Link from "next/link";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { AdminDataTable, SortHeader } from "./admin-data-table";
import { useI18n } from "../lib/use-i18n";
import { setAgentPackageEnabledAction, setAgentPackageFeaturedAction } from "../app/admin/actions";

const COPY = {
  zh: { scope: "范围", global: "全局", organization: "组织", channel: "渠道", edit: "编辑", feature: "设为精选", unfeature: "取消精选", updated: "更新时间", dimensions: "维度" },
  en: { scope: "Scope", global: "Global", organization: "Organization", channel: "Channel", edit: "Edit", feature: "Feature", unfeature: "Unfeature", updated: "Updated", dimensions: "Dimensions" },
};

function definitionOf(row) {
  const value = row.definition;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" ? value : {};
}

function dimensionCount(definition) {
  let count = 0;
  if (definition.role) count += 1;
  if (definition.skills?.enabled?.length) count += 1;
  if (definition.knowledge?.packs?.length || definition.knowledge?.guidance) count += 1;
  if (definition.autonomy?.permissionModeId && definition.autonomy.permissionModeId !== "inherit") count += 1;
  if (definition.model?.presetId) count += 1;
  if (definition.tools?.mcpAllow?.length || definition.tools?.connectors?.length || definition.tools?.disallow?.length) count += 1;
  if (definition.automations?.length) count += 1;
  return count;
}

export function AgentPackagesTable({ rows, empty }) {
  const { locale, t } = useI18n();
  const copy = COPY[locale] || COPY.en;
  const columns = [
    { accessorKey: "agent_id", header: ({ column }) => <SortHeader column={column}>Agent ID</SortHeader>, cell: ({ row }) => <span className="font-mono">{row.original.agent_id}</span> },
    { id: "name", header: t.admin.cols.name, cell: ({ row }) => { const d = definitionOf(row.original); return <span>{d.icon ? `${d.icon} ` : ""}{d.name || "-"}</span>; } },
    { accessorKey: "version", header: ({ column }) => <SortHeader column={column}>{t.admin.cols.version}</SortHeader> },
    { accessorKey: "channel", header: copy.channel, cell: ({ row }) => <Badge variant="brand">{row.original.channel}</Badge> },
    {
      id: "scope",
      header: copy.scope,
      cell: ({ row }) => row.original.scope_type === "organization"
        ? <span className="text-xs"><Badge variant="default">{copy.organization}</Badge> <span className="font-mono text-slate-500">{row.original.organization_id}</span></span>
        : <Badge variant="success">{copy.global}</Badge>,
    },
    { id: "dimensions", header: copy.dimensions, cell: ({ row }) => <span className="tabular-nums">{dimensionCount(definitionOf(row.original))}</span> },
    { accessorKey: "featured", header: t.admin.cols.featured, cell: ({ row }) => row.original.featured ? <Badge variant="success">{t.admin.cols.yes}</Badge> : <span className="text-slate-400">{t.admin.cols.no}</span> },
    { accessorKey: "enabled", header: t.admin.common.status, cell: ({ row }) => <Badge variant={row.original.enabled ? "success" : "danger"}>{row.original.enabled ? t.admin.common.enabled : t.admin.common.disabled}</Badge> },
    { accessorKey: "updated_at", header: copy.updated, cell: ({ row }) => <span className="text-xs text-slate-500">{row.original.updated_at ? new Date(row.original.updated_at).toLocaleString() : "-"}</span> },
    {
      id: "action",
      header: t.admin.common.action,
      cell: ({ row }) => (
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/admin/agents/${row.original.id}`} className="text-xs font-semibold text-brand">{copy.edit}</Link>
          <form action={setAgentPackageFeaturedAction}>
            <input type="hidden" name="id" value={row.original.id} />
            <input type="hidden" name="featured" value={row.original.featured ? "false" : "true"} />
            <Button variant="outline" size="sm">{row.original.featured ? copy.unfeature : copy.feature}</Button>
          </form>
          <form action={setAgentPackageEnabledAction}>
            <input type="hidden" name="id" value={row.original.id} />
            <input type="hidden" name="enabled" value={row.original.enabled ? "false" : "true"} />
            <Button variant="outline" size="sm">{row.original.enabled ? t.admin.common.disabled : t.admin.common.enabled}</Button>
          </form>
        </div>
      ),
    },
  ];
  return <AdminDataTable columns={columns} data={rows} empty={empty} filterPlaceholder={`${t.admin.common.search} ${t.admin.nav.agents || "Agents"}`} />;
}
