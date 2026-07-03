import Link from "next/link";

export function ConfigAdminNav({ labels }) {
  const items = [
    ["/admin/config/overview", labels.overview],
    ["/admin/config/settings", labels.basics],
    ["/admin/config/storage", labels.storage || "对象存储"],
    ["/admin/config/sms", labels.sms || "短信登录"],
    ["/admin/config/payment", labels.payment || "支付配置"],
    ["/admin/config/providers", labels.providers],
    ["/admin/config/profiles", labels.profiles],
    ["/admin/config/groups", labels.groups],
  ];

  return (
    <div className="mb-6 flex flex-wrap gap-2">
      {items.map(([href, label]) => (
        <Link
          key={href}
          href={href}
          className="inline-flex rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:border-slate-300 hover:bg-slate-50"
        >
          {label}
        </Link>
      ))}
    </div>
  );
}
