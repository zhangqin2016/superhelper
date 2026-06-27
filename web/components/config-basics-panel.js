import { Field, SubmitButton } from "./admin-forms";
import { updateSettingsAction } from "../app/admin/actions";

// "Basics" tab of the Config center — global defaults that used to live on the
// standalone Settings page (trial days, model/media delivery, file storage).
// Server-rendered: no client state, just a form posting the server action.
export function ConfigBasicsPanel({ settings, t }) {
  const qiniu = settings.qiniu || {};
  const delivery = t.admin.settingsDelivery;
  const s = t.admin.settings;
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-xl font-semibold text-slate-950">{s.trialTitle}</h2>
      <p className="mt-2 max-w-2xl text-sm text-slate-500">{s.trialDesc}</p>
      <form action={updateSettingsAction} className="mt-6 grid gap-5 lg:grid-cols-2">
        <div className="lg:col-span-2 max-w-sm">
          <Field label={s.trialDays} name="licenseTrialDays" type="number" defaultValue={settings.licenseTrialDays ?? 3} required />
        </div>
        <div className="lg:col-span-2 max-w-md">
          <label className="block">
            <span className="mb-2 block text-sm font-semibold text-slate-800">{delivery.modelTitle}</span>
            <select
              name="modelDeliveryMode"
              defaultValue={settings.modelDeliveryMode || "direct"}
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand focus:ring-4 focus:ring-brand/10"
            >
              <option value="direct">{delivery.direct}</option>
              <option value="gateway">{delivery.gateway}</option>
            </select>
            <span className="mt-1 block text-xs text-slate-500">{delivery.modelHelp}</span>
          </label>
        </div>
        <div className="lg:col-span-2 max-w-md">
          <label className="block">
            <span className="mb-2 block text-sm font-semibold text-slate-800">{delivery.mediaTitle}</span>
            <select
              name="mediaDeliveryMode"
              defaultValue={settings.mediaDeliveryMode || "direct"}
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand focus:ring-4 focus:ring-brand/10"
            >
              <option value="direct">{delivery.direct}</option>
              <option value="gateway">{delivery.gateway}</option>
            </select>
            <span className="mt-1 block text-xs text-slate-500">{delivery.mediaHelp}</span>
          </label>
        </div>
        <div className="lg:col-span-2 border-t border-slate-100 pt-5">
          <h3 className="text-base font-semibold text-slate-950">{s.qiniuTitle}</h3>
          <p className="mt-1 text-sm text-slate-500">{s.qiniuDesc}</p>
        </div>
        <Field label={s.qiniuPublicBaseUrl} name="qiniuPublicBaseUrl" defaultValue={qiniu.publicBaseUrl || ""} required />
        <Field label={s.qiniuUploadUrl} name="qiniuUploadUrl" defaultValue={qiniu.uploadUrl || "https://upload.qiniup.com"} required />
        <Field label={s.qiniuAccessKey} name="qiniuAccessKey" defaultValue={qiniu.accessKey || ""} required />
        <Field label={s.qiniuBucket} name="qiniuBucket" defaultValue={qiniu.bucket || ""} required />
        <Field
          label={qiniu.hasSecretKey ? s.qiniuSecretKeyKeep : s.qiniuSecretKey}
          name="qiniuSecretKey"
          type="password"
          placeholder={qiniu.hasSecretKey ? s.qiniuSecretKeyPlaceholder : ""}
          required={!qiniu.hasSecretKey}
        />
        <div className="flex items-end">
          <SubmitButton>{s.save}</SubmitButton>
        </div>
      </form>
    </section>
  );
}
