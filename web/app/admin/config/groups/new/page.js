import Link from "next/link";
import { AdminShell } from "../../../../../components/admin-shell";
import { ConfigGroupsPanel } from "../../../../../components/config-groups-panel";

export default function NewConfigGroupPage() {
  return (
    <AdminShell title="新增 / 更新设备组" subtitle="只创建或更新设备组。成员归组请到归组页面处理。">
      <div className="mb-5">
        <Link href="/admin/config/groups" className="text-sm font-semibold text-brand">返回设备组</Link>
      </div>
      <ConfigGroupsPanel groups={[]} showAssign={false} showList={false} />
    </AdminShell>
  );
}
