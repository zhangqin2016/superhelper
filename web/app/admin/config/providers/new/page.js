import Link from "next/link";
import { AdminShell } from "../../../../../components/admin-shell";
import { ModelProvidersPanel } from "../../../../../components/model-providers-panel";
import { getI18n } from "../../../../../lib/i18n.mjs";

export default async function NewModelProviderPage() {
  const { t } = await getI18n();

  return (
    <AdminShell title="新增 / 更新模型供应商" subtitle="只处理模型或媒体供应商的地址、模型列表和服务端密钥。">
      <div className="mb-5">
        <Link href="/admin/config/providers" className="text-sm font-semibold text-brand">返回模型供应商</Link>
      </div>
      <ModelProvidersPanel providers={[]} showList={false} />
    </AdminShell>
  );
}
