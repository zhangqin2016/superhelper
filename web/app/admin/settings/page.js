import { AdminShell } from "../../../components/admin-shell";
import { Field, SubmitButton } from "../../../components/admin-forms";
import { updateSettingsAction } from "../actions";
import { safeApiGet } from "../../../lib/api";
import { getI18n } from "../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { t } = await getI18n();
  const data = await safeApiGet("/api/admin/settings", {
    settings: { licenseTrialDays: 3 },
  });
  const settings = data.settings || { licenseTrialDays: 3 };

  return (
    <AdminShell title={t.admin.pages.settings[0]} subtitle={t.admin.pages.settings[1]}>
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-950">{t.admin.settings.trialTitle}</h2>
        <p className="mt-2 max-w-2xl text-sm text-slate-500">{t.admin.settings.trialDesc}</p>
        <form action={updateSettingsAction} className="mt-6 max-w-sm space-y-5">
          <Field
            label={t.admin.settings.trialDays}
            name="licenseTrialDays"
            type="number"
            defaultValue={settings.licenseTrialDays ?? 3}
            required
          />
          <SubmitButton>{t.admin.settings.save}</SubmitButton>
        </form>
      </section>
    </AdminShell>
  );
}
