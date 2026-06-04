import { AdminLoginForm } from "../../../components/admin-login-form";
import { LanguageSwitcher } from "../../../components/language-switcher";
import { getI18n } from "../../../lib/i18n.mjs";

export default async function AdminLoginPage() {
  const { locale, t } = await getI18n();
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0c1015] px-6">
      <section className="w-full max-w-md rounded-2xl border border-white/10 bg-white p-8 shadow-2xl">
        <div className="mb-5 flex justify-end">
          <LanguageSwitcher initialLocale={locale} />
        </div>
        <div className="mb-8">
          <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-lg bg-slate-950 text-sm font-bold text-white">LW</div>
          <h1 className="text-3xl font-semibold text-slate-950">{t.admin.loginTitle}</h1>
          <p className="mt-2 text-sm text-slate-500">{t.admin.loginDesc}</p>
        </div>
        <AdminLoginForm />
      </section>
    </main>
  );
}
