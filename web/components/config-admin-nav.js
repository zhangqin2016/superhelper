import Link from "next/link";

export function ConfigAdminNav({ labels, current = "" }) {
  const items = [
    ["overview", "/admin/config/overview", labels.overview],
    ["basics", "/admin/config/settings", labels.basics],
    ["storage", "/admin/config/storage", labels.storage || "对象存储"],
    ["sms", "/admin/config/sms", labels.sms || "短信登录"],
    ["payment", "/admin/config/payment", labels.payment || "支付配置"],
    ["providers", "/admin/config/providers", labels.providers],
    ["profiles", "/admin/config/profiles", labels.profiles],
    ["groups", "/admin/config/groups", labels.groups],
  ];

  return (
    <nav className="mb-6 flex flex-wrap gap-2">
      {items.map(([key, href, label]) => (
        <Link
          key={href}
          href={href}
          aria-current={key === current ? "page" : undefined}
          className={
            key === current
              ? "inline-flex rounded-lg border border-slate-900 bg-slate-900 px-3 py-2 text-sm font-semibold text-white"
              : "inline-flex rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:border-slate-300 hover:bg-slate-50"
          }
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
