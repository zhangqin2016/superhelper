/**
 * Code-drawn illustrations of the organization console (/account/enterprise)
 * and the desktop identity picker. Strings come from site-copy-enterprise.mjs
 * `mocks`; styles live in ./product-mock.css with the other mocks.
 */
import { Building2, Check, History, KeyRound, Phone, UserRound } from "lucide-react";
import { MockFrame, MockPanel } from "./product-mock";

function Switch({ on = true }) {
  return <span className={`pm-switch${on ? " is-on" : ""}`}><i /></span>;
}

function initialOf(name) {
  return String(name || "").trim().slice(0, 1);
}

/**
 * The organization overview: status with its two switches, the pool, and the
 * members with their weekly budget bars. `compact` drops the nav rail.
 */
export function OrgConsoleMock({ copy, label, compact = false, className = "" }) {
  const o = copy;
  return (
    <MockFrame title={`${o.windowTitle} · ${o.orgName}`} label={label} className={`pm-frame--org${compact ? " is-compact" : ""} ${className}`}>
      <div className="pm-org">
        {compact ? null : (
          <aside className="pm-org-nav">
            <div className="pm-org-name">
              <span className="pm-org-mark"><Building2 size={14} strokeWidth={1.9} /></span>
              <span><b>{o.orgName}</b><small>{o.role}</small></span>
            </div>
            <ul>
              {o.nav.map((item, index) => <li key={item} className={index === 1 ? "is-active" : undefined}>{item}</li>)}
            </ul>
          </aside>
        )}
        <div className="pm-org-main">
          <div className="pm-org-cards">
            <div className="pm-org-card">
              <p className="pm-kicker">{o.statusLabel}</p>
              <p className="pm-org-status"><span className="pm-dot" />{o.status}</p>
              <ul className="pm-switches">
                {o.switches.map(([name, state]) => (
                  <li key={name}><span>{name}</span><span className="pm-switch-state">{state}<Switch /></span></li>
                ))}
              </ul>
            </div>
            <div className="pm-org-card">
              <p className="pm-kicker">{o.poolLabel}</p>
              <p className="pm-pool"><b className="site-num">{o.poolValue}</b><span>{o.poolUnit}</span></p>
              <p className="pm-pool-extra">{o.poolExtra}</p>
            </div>
          </div>
          <div className="pm-members">
            <div className="pm-members-head">
              <b>{o.membersLabel}</b>
              <span>{o.weekLabel}</span>
            </div>
            <ul>
              {o.members.map(([name, role, usage, percent, source]) => (
                <li key={name}>
                  <span className="pm-avatar pm-avatar--sm">{initialOf(name)}</span>
                  <span className="pm-member-name"><b>{name}</b><small>{role}</small></span>
                  <span className="pm-member-week">
                    <span className="pm-meter"><i className={percent >= 85 ? "is-high" : undefined} style={{ width: `${percent}%` }} /></span>
                    <span className="pm-member-usage"><span className="site-num">{usage}</span><small>{source}</small></span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="pm-members-note">{o.defaultNote}</p>
          </div>
        </div>
      </div>
    </MockFrame>
  );
}

/** Settings → Account in the desktop app: the identity that decides who pays. */
export function IdentityMock({ copy, label }) {
  const c = copy;
  return (
    <MockPanel label={label} className="pm-identity">
      <div className="pm-panel-head"><b>{c.title}</b><span className="pm-panel-meta">{c.path}</span></div>
      <ul className="pm-identity-options">
        {c.options.map(([name, desc], index) => (
          <li key={name} className={index === 0 ? "is-selected" : undefined}>
            <span className="pm-radio">{index === 0 ? <i /> : null}</span>
            <span className="pm-identity-icon">{index === 0 ? <Building2 size={14} strokeWidth={1.9} /> : <UserRound size={14} strokeWidth={1.9} />}</span>
            <span className="pm-identity-text"><b>{name}</b><small>{desc}</small></span>
          </li>
        ))}
      </ul>
      <div className="pm-identity-foot">
        <span className="pm-meter pm-meter--wide"><i style={{ width: "24%" }} /></span>
        <span className="site-num">{c.week}</span>
      </div>
      <p className="pm-status">{c.note}</p>
    </MockPanel>
  );
}

/** Adding members: a pending phone seat and a batch of issued accounts. */
export function AddMembersMock({ copy, label }) {
  const c = copy;
  return (
    <MockPanel label={label} className="pm-add">
      <div className="pm-panel-head"><b>{c.title}</b></div>
      <div className="pm-tabs">
        {c.tabs.map((tab, index) => <span key={tab} className={index === 0 ? "is-active" : undefined}>{index === 0 ? <Phone size={12} strokeWidth={2} /> : <KeyRound size={12} strokeWidth={2} />}{tab}</span>)}
      </div>
      <div className="pm-field">
        <span className="pm-field-label">{c.phoneLabel}</span>
        <span className="pm-field-value site-num">{c.phone}</span>
        <span className="pm-tag">{c.pending}</span>
      </div>
      <p className="pm-hint">{c.pendingNote}</p>
      <div className="pm-issued">
        <p className="pm-kicker">{c.issuedTitle}</p>
        <ul>
          {c.issued.map(([login, secret]) => (
            <li key={login}>
              <span className="pm-mono">{login}</span>
              <span className="pm-secret">{secret} <span aria-hidden="true">••••••</span></span>
            </li>
          ))}
        </ul>
        <p className="pm-hint"><Check size={11} strokeWidth={2.6} />{c.issuedNote}</p>
      </div>
    </MockPanel>
  );
}

/** The change history: who changed what, and when. */
export function HistoryMock({ copy, label }) {
  const c = copy;
  return (
    <MockPanel label={label} className="pm-history">
      <div className="pm-panel-head"><History size={14} strokeWidth={1.9} /><b>{c.title}</b></div>
      <ol className="pm-history-list">
        {c.rows.map(([who, what, when]) => (
          <li key={`${who}-${when}`}>
            <i />
            <span className="pm-history-text"><b>{who}</b><span>{what}</span></span>
            <time className="site-num">{when}</time>
          </li>
        ))}
      </ol>
    </MockPanel>
  );
}
