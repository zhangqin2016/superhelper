import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { loadEnterpriseOrganization, roleAtLeast } from "../../../../lib/enterprise-page";
import { getI18n } from "../../../../lib/i18n.mjs";
import { consoleErrorMessage, enterpriseConsoleText, fill, organizationState } from "../../../../lib/enterprise-console-i18n.mjs";
import EnterpriseOrgNav from "../../../../components/enterprise-org-nav";
import { EnterpriseBadge, EnterpriseNotice } from "../../../../components/enterprise-ui";

export const dynamic = "force-dynamic";

const STATE_TONE = { active: "green", paused: "amber", frozen: "red" };

/**
 * Everything every organization page shares: who you are here, what state
 * the organization is in (a platform freeze and an owner pause are different
 * things and say so), and the tabs your role reaches.
 */
export default async function OrganizationLayout({ children, params }) {
  const { id } = await params;
  const { locale } = await getI18n();
  const T = enterpriseConsoleText(locale);
  const back = (
    <Link href="/account/enterprise" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
      <ArrowLeft size={14} className="rtl:rotate-180" aria-hidden="true" /> {T.common.backToList}
    </Link>
  );
  const loaded = await loadEnterpriseOrganization(id);
  if (!loaded.ok) {
    return (
      <div className="space-y-4">
        {back}
        <EnterpriseNotice tone="danger" title={T.org.unavailableTitle}>{consoleErrorMessage(loaded.code, locale, "load")}</EnterpriseNotice>
      </div>
    );
  }
  const org = loaded.org;
  const state = organizationState(org);
  const base = `/account/enterprise/${org.id}`;
  const items = [
    { href: base, label: T.nav.overview },
    ...(roleAtLeast(org.role, "admin") ? [
      { href: `${base}/members`, label: T.nav.members },
      { href: `${base}/usage`, label: T.nav.usage },
      { href: `${base}/history`, label: T.nav.history },
    ] : []),
    ...(org.role === "owner" ? [{ href: `${base}/grants`, label: T.nav.pool }] : []),
    { href: `${base}/settings`, label: T.nav.settings },
  ];
  const frozen = org.platform_status === "suspended";
  const paused = org.owner_status === "disabled";
  const membershipDisabled = org.me && org.me.ok === false && org.me.code === "ORG_MEMBER_DISABLED";
  return (
    <div className="space-y-6">
      <header className="space-y-3">
        {back}
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-slate-950">{org.name}</h1>
          <EnterpriseBadge tone={STATE_TONE[state]}>{T.orgStatus[state]}</EnterpriseBadge>
          <EnterpriseBadge tone="blue">{T.roles[org.role] || org.role}</EnterpriseBadge>
        </div>
        {frozen ? (
          <EnterpriseNotice tone="danger" title={T.org.frozenTitle}>
            <p>{T.org.frozenBody}</p>
            {org.platform_status_reason ? <p>{fill(T.org.frozenReason, { reason: org.platform_status_reason })}</p> : null}
            {paused ? <p>{T.org.alsoPaused}</p> : null}
            <p><Link href="/contact" className="font-medium underline">{T.common.contactSupport}</Link></p>
          </EnterpriseNotice>
        ) : paused ? (
          <EnterpriseNotice tone="warning" title={T.org.pausedTitle}>
            <p>{org.role === "owner" ? T.org.pausedOwner : T.org.pausedOther}</p>
          </EnterpriseNotice>
        ) : null}
        {membershipDisabled ? (
          <EnterpriseNotice tone="warning" title={T.org.membershipDisabledTitle}>{T.org.membershipDisabledBody}</EnterpriseNotice>
        ) : null}
        <EnterpriseOrgNav items={items} base={base} />
      </header>
      {children}
    </div>
  );
}
