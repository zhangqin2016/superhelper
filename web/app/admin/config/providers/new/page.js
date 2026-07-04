import Link from "next/link";
import { AdminShell } from "../../../../../components/admin-shell";
import { ModelProvidersPanel } from "../../../../../components/model-providers-panel";
import { safeApiGet } from "../../../../../lib/api";
import { getI18n } from "../../../../../lib/i18n.mjs";

export default async function NewModelProviderPage({ searchParams }) {
  const { t } = await getI18n();
  const params = await searchParams;
  const editId = typeof params?.id === "string" ? params.id : "";
  const data = editId ? await safeApiGet("/api/admin/model-providers", { providers: [] }) : { providers: [] };
  const initialProvider = editId
    ? (data.providers || []).find((provider) => provider.id === editId) || null
    : null;

  return (
    <AdminShell title={initialProvider ? "编辑模型供应商" : "新增 / 更新模型供应商"} subtitle="只处理模型或媒体供应商的地址、模型列表和服务端密钥。">
      <div className="mb-5">
        <Link href="/admin/config/providers" className="text-sm font-semibold text-brand">返回模型供应商</Link>
      </div>
      <ModelProvidersPanel providers={[]} initialProvider={initialProvider} showList={false} />
    </AdminShell>
  );
}
