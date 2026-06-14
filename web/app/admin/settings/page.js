import { AdminShell } from "../../../components/admin-shell";
import { Field, SubmitButton } from "../../../components/admin-forms";
import { updateSettingsAction } from "../actions";
import { safeApiGet } from "../../../lib/api";
import { getI18n } from "../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { t } = await getI18n();
  const data = await safeApiGet("/api/admin/settings", {
    settings: {
      licenseTrialDays: 3,
      qiniu: {
        publicBaseUrl: "",
        accessKey: "",
        bucket: "",
        uploadUrl: "https://upload.qiniup.com",
        hasSecretKey: false,
      },
    },
  });
  const settings = data.settings || { licenseTrialDays: 3, qiniu: {} };
  const qiniu = settings.qiniu || {};

  return (
    <AdminShell title={t.admin.pages.settings[0]} subtitle={t.admin.pages.settings[1]}>
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-950">{t.admin.settings.trialTitle}</h2>
        <p className="mt-2 max-w-2xl text-sm text-slate-500">{t.admin.settings.trialDesc}</p>
        <form action={updateSettingsAction} className="mt-6 grid gap-5 lg:grid-cols-2">
          <div className="lg:col-span-2 max-w-sm">
            <Field
              label={t.admin.settings.trialDays}
              name="licenseTrialDays"
              type="number"
              defaultValue={settings.licenseTrialDays ?? 3}
              required
            />
          </div>
          <div className="lg:col-span-2 max-w-md">
            <label className="block">
              <span className="mb-2 block text-sm font-semibold text-slate-800">媒体投递方式（图片 / 视频 / 识图 / 语音）</span>
              <select
                name="mediaDeliveryMode"
                defaultValue={settings.mediaDeliveryMode || "direct"}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand focus:ring-4 focus:ring-brand/10"
              >
                <option value="direct">直连（更快；真实密钥下发到客户端）</option>
                <option value="gateway">走网关（密钥只在服务端，客户端拿短期 token，多一跳）</option>
              </select>
              <span className="mt-1 block text-xs text-slate-500">直连绕开我们的网关，弱网下更稳更快；网关更安全但多一跳。</span>
            </label>
          </div>
          <div className="lg:col-span-2 border-t border-slate-100 pt-5">
            <h3 className="text-base font-semibold text-slate-950">{t.admin.settings.qiniuTitle}</h3>
            <p className="mt-1 text-sm text-slate-500">{t.admin.settings.qiniuDesc}</p>
          </div>
          <Field label={t.admin.settings.qiniuPublicBaseUrl} name="qiniuPublicBaseUrl" defaultValue={qiniu.publicBaseUrl || ""} required />
          <Field label={t.admin.settings.qiniuUploadUrl} name="qiniuUploadUrl" defaultValue={qiniu.uploadUrl || "https://upload.qiniup.com"} required />
          <Field label={t.admin.settings.qiniuAccessKey} name="qiniuAccessKey" defaultValue={qiniu.accessKey || ""} required />
          <Field label={t.admin.settings.qiniuBucket} name="qiniuBucket" defaultValue={qiniu.bucket || ""} required />
          <Field
            label={qiniu.hasSecretKey ? t.admin.settings.qiniuSecretKeyKeep : t.admin.settings.qiniuSecretKey}
            name="qiniuSecretKey"
            type="password"
            placeholder={qiniu.hasSecretKey ? t.admin.settings.qiniuSecretKeyPlaceholder : ""}
            required={!qiniu.hasSecretKey}
          />
          <div className="flex items-end">
            <SubmitButton>{t.admin.settings.save}</SubmitButton>
          </div>
        </form>
      </section>
    </AdminShell>
  );
}
