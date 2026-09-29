import Link from "next/link";
import { AlertTriangle, Info, Lock } from "lucide-react";

/** Small shared pieces of the enterprise console. Server-safe: no state, no hooks. */

export function EnterpriseCard({ title, description, actions = null, children, className = "" }) {
  return (
    <section className={`rounded-lg border border-slate-200 bg-white p-6 ${className}`}>
      {title || actions ? (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {title ? <h2 className="text-base font-semibold text-slate-900">{title}</h2> : null}
            {description ? <p className="mt-1 text-sm text-slate-500">{description}</p> : null}
          </div>
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

const TONES = {
  info: "border-sky-200 bg-sky-50 text-sky-900",
  warning: "border-amber-200 bg-amber-50 text-amber-900",
  danger: "border-red-200 bg-red-50 text-red-900",
};

export function EnterpriseNotice({ tone = "info", title, children }) {
  const Icon = tone === "info" ? Info : AlertTriangle;
  return (
    <div role={tone === "info" ? "note" : "alert"} className={`flex gap-3 rounded-lg border px-4 py-3 text-sm ${TONES[tone] || TONES.info}`}>
      <Icon size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 space-y-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className="leading-6">{children}</div> : null}
      </div>
    </div>
  );
}

/** A section that could not load: the rest of the page stays. */
export function EnterpriseSectionError({ message }) {
  return <p role="alert" className="rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-800">{message}</p>;
}

export function EnterpriseEmpty({ children }) {
  return <p className="rounded-lg border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-500">{children}</p>;
}

/** Shown instead of a page the viewer's role does not reach. */
export function EnterpriseNoAccess({ title, body, href, linkLabel }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-8 text-center">
      <Lock size={22} className="mx-auto text-slate-400" aria-hidden="true" />
      <h2 className="mt-3 text-base font-semibold text-slate-900">{title}</h2>
      <p className="mx-auto mt-2 max-w-xl text-sm text-slate-500">{body}</p>
      <Link href={href} className="mt-5 inline-block rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700">{linkLabel}</Link>
    </section>
  );
}

export function EnterpriseBadge({ tone = "slate", children }) {
  const tones = {
    slate: "bg-slate-100 text-slate-700",
    green: "bg-emerald-50 text-emerald-700",
    amber: "bg-amber-50 text-amber-800",
    red: "bg-red-50 text-red-700",
    blue: "bg-sky-50 text-sky-700",
  };
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone] || tones.slate}`}>{children}</span>;
}
