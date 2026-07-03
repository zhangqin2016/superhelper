import Link from "next/link";
import { AdminShell } from "../../../../components/admin-shell";
import { ReleaseCreateForm } from "../../../../components/release-create-form";
import { getI18n } from "../../../../lib/i18n.mjs";

export default async function NewReleasePage() {
  const { t } = await getI18n();
  const cdnBaseUrl =
    process.env.RELEASE_CDN_BASE_URL ||
    process.env.NEXT_PUBLIC_RELEASE_CDN_BASE_URL ||
    process.env.QINIU_PUBLIC_BASE_URL ||
    "https://qny.lanrensoft.cn";
  const cdnPrefix =
    process.env.RELEASE_CDN_PREFIX ||
    process.env.NEXT_PUBLIC_RELEASE_CDN_PREFIX ||
    "app/updates";

  return (
    <AdminShell title="新增版本" subtitle="只创建或更新一个客户端发布版本。">
      <div className="mb-5">
        <Link href="/admin/releases" className="text-sm font-semibold text-brand">返回版本列表</Link>
      </div>
      <ReleaseCreateForm title={t.admin.pages.releases[0]} cdnBaseUrl={cdnBaseUrl} cdnPrefix={cdnPrefix} />
    </AdminShell>
  );
}
