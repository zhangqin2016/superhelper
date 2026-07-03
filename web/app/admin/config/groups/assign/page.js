import Link from "next/link";
import { AdminShell } from "../../../../../components/admin-shell";
import { ConfigGroupsPanel } from "../../../../../components/config-groups-panel";
import { safeApiGet } from "../../../../../lib/api";

export const dynamic = "force-dynamic";

export default async function AssignConfigGroupPage() {
  const groupsData = await safeApiGet("/api/admin/config-groups", { groups: [] });

  return (
    <AdminShell title="设备组成员归组" subtitle="只处理设备或授权与设备组之间的归属关系。">
      <div className="mb-5">
        <Link href="/admin/config/groups" className="text-sm font-semibold text-brand">返回设备组</Link>
      </div>
      <ConfigGroupsPanel groups={groupsData.groups || []} showCreate={false} showList={false} />
    </AdminShell>
  );
}
