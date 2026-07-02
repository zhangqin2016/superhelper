export const dynamic = "force-dynamic";

export default function AccountSettingsPage() {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-6">
      <h1 className="text-2xl font-semibold">账号设置</h1>
      <p className="mt-2 text-sm text-slate-500">手机号、登录设备和退出登录会在用户 Web session 接入后显示。</p>
    </section>
  );
}
