import Link from "next/link";
import { notFound } from "next/navigation";
import { requireEnterpriseOrganization, requireEnterpriseData, roleAtLeast } from "../../../../../lib/enterprise-page";
import { getI18n } from "../../../../../lib/i18n.mjs";
import { consoleErrorMessage, enterpriseConsoleText, personDetail, personLabel } from "../../../../../lib/enterprise-console-i18n.mjs";
import { leaveOrganizationAction, saveOrganizationSettingsAction, setOrganizationPausedAction, transferOwnershipAction } from "../../actions";
import EnterpriseActionForm from "../../../../../components/enterprise-action-form";
import { EnterpriseCard, EnterpriseNotice, EnterpriseSectionError } from "../../../../../components/enterprise-ui";

export const dynamic = "force-dynamic";

const input = "rounded-lg border border-slate-200 px-3 py-2 text-sm";
const primary = "rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700";
const danger = "rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700";
const quiet = "rounded-lg border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50";

export default async function OrgSettingsPage({ params }) {
  const { id } = await params;
  const org = await requireEnterpriseOrganization(id);
  if (!org?.id) notFound();
  const { locale } = await getI18n();
  const T = enterpriseConsoleText(locale);
  const S = T.settings;
  const admin = roleAtLeast(org.role, "admin");
  const owner = org.role === "owner";
  const frozen = org.platform_status === "suspended";
  const paused = org.owner_status === "disabled";
  const api = `/api/enterprise/organizations/${encodeURIComponent(id)}`;
  // The owner needs the roster (who can take over, is anyone else an owner);
  // everyone else only their own row (an issued account cannot leave).
  const roster = await requireEnterpriseData(
    owner ? `${api}/members?limit=500` : `${api}/members?limit=5&q=${encodeURIComponent(org.viewerId || "")}`,
    { members: [] },
  );
  const members = Array.isArray(roster.members) ? roster.members : [];
  const me = members.find((m) => m.user_id === org.viewerId) || null;
  const candidates = members.filter((m) => m.user_id !== org.viewerId && m.status === "active");
  const otherOwner = members.some((m) => m.user_id !== org.viewerId && m.role === "owner" && m.status === "active");
  const lastOwner = owner && !roster.loadError && !otherOwner;
  const issued = Boolean(me?.issued);
  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-xl font-semibold">{S.title}</h2>
        {!admin ? <p className="mt-1 text-sm text-slate-500">{S.managedByAdmins}</p> : null}
      </header>

      {admin ? (
        <EnterpriseCard title={S.generalTitle}>
          <EnterpriseActionForm action={saveOrganizationSettingsAction.bind(null, id)} locale={locale} className="flex flex-wrap items-start gap-3">
            <input name="name" required maxLength={120} defaultValue={org.name} aria-label={S.nameLabel} className={`${input} min-w-0 flex-1 basis-64`} />
            <button type="submit" className={primary}>{T.common.save}</button>
          </EnterpriseActionForm>
        </EnterpriseCard>
      ) : null}

      {admin ? (
        <EnterpriseCard title={S.budgetTitle} description={S.budgetIntro}>
          <EnterpriseActionForm action={saveOrganizationSettingsAction.bind(null, id)} locale={locale} className="flex flex-wrap items-start gap-3">
            <input
              name="defaultMemberWeeklyBudget"
              type="number"
              min="0"
              step="1"
              inputMode="numeric"
              defaultValue={org.default_member_weekly_budget ?? ""}
              placeholder={S.budgetPlaceholder}
              aria-label={S.budgetLabel}
              className={`${input} w-56`}
            />
            <button type="submit" className={primary}>{T.common.save}</button>
          </EnterpriseActionForm>
        </EnterpriseCard>
      ) : null}

      {owner ? (
        paused ? (
          <EnterpriseCard title={S.resumeTitle} description={S.resumeIntro}>
            {frozen ? <div className="mb-4"><EnterpriseNotice tone="danger">{S.frozenAndPausedNote} <Link href="/contact" className="font-medium underline">{T.common.contactSupport}</Link></EnterpriseNotice></div> : null}
            <EnterpriseActionForm action={setOrganizationPausedAction.bind(null, id, false)} locale={locale} className="flex flex-wrap items-center gap-3">
              <button type="submit" className={primary}>{S.resumeButton}</button>
            </EnterpriseActionForm>
          </EnterpriseCard>
        ) : (
          <EnterpriseCard title={S.pauseTitle} description={S.pauseIntro}>
            {frozen ? <div className="mb-4"><EnterpriseNotice tone="danger">{S.frozenNote} <Link href="/contact" className="font-medium underline">{T.common.contactSupport}</Link></EnterpriseNotice></div> : null}
            <EnterpriseActionForm action={setOrganizationPausedAction.bind(null, id, true)} locale={locale} confirm={S.confirmPause} confirmName={org.name} className="flex flex-wrap items-center gap-3">
              <button type="submit" className={quiet}>{S.pauseButton}</button>
            </EnterpriseActionForm>
          </EnterpriseCard>
        )
      ) : null}

      {owner ? (
        <EnterpriseCard title={S.transferTitle} description={S.transferIntro}>
          {roster.loadError ? <EnterpriseSectionError message={consoleErrorMessage(roster.loadError, locale, "load")} /> : candidates.length === 0 ? (
            <p className="text-sm text-slate-500">{S.transferNoCandidates}</p>
          ) : (
            <EnterpriseActionForm action={transferOwnershipAction.bind(null, id)} locale={locale} confirm={S.confirmTransfer} className="flex flex-wrap items-start gap-3">
              <select name="userId" required defaultValue="" aria-label={S.transferLabel} className={`${input} min-w-0 flex-1 basis-64`}>
                <option value="" disabled>{S.transferChoose}</option>
                {candidates.map((m) => {
                  const detail = personDetail(m);
                  return <option key={m.user_id} value={m.user_id}>{`${personLabel(m, T.history.someone)}${detail ? ` (${detail})` : ""} · ${T.roles[m.role] || m.role}`}</option>;
                })}
              </select>
              <button type="submit" className={danger}>{S.transferButton}</button>
            </EnterpriseActionForm>
          )}
        </EnterpriseCard>
      ) : null}

      <EnterpriseCard title={S.leaveTitle} description={S.leaveIntro}>
        {issued ? <p className="text-sm text-slate-600">{S.leaveIssued}</p> : lastOwner ? <p className="text-sm text-slate-600">{S.leaveLastOwner}</p> : (
          <EnterpriseActionForm action={leaveOrganizationAction.bind(null, id)} locale={locale} confirm={S.confirmLeave} confirmName={org.name} className="flex flex-wrap items-center gap-3">
            <button type="submit" className={quiet}>{S.leaveButton}</button>
          </EnterpriseActionForm>
        )}
      </EnterpriseCard>
    </div>
  );
}
