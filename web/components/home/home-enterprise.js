import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import { OrgConsoleMock } from "../site/enterprise-mocks";

export function HomeEnterprise({ copy, orgMock, mockLabel }) {
  return (
    <section className="site-section hm-ent">
      <div className="shell hm-ent-inner">
        <div className="hm-ent-copy">
          <p className="site-eyebrow">{copy.eyebrow}</p>
          <h2 className="site-h2">{copy.title}</h2>
          <p className="site-lead">{copy.description}</p>
          <ul className="hm-ent-points">
            {copy.points.map(([title, description]) => (
              <li key={title}>
                <span className="hm-check"><Check size={13} strokeWidth={2.6} /></span>
                <div><h3>{title}</h3><p>{description}</p></div>
              </li>
            ))}
          </ul>
          <Link href="/enterprise" className="site-btn site-btn--secondary">{copy.cta}<ArrowRight className="site-flip" size={17} /></Link>
        </div>
        <div className="hm-ent-visual">
          <OrgConsoleMock copy={orgMock} label={mockLabel} compact className="pm-frame--raised" />
        </div>
      </div>
    </section>
  );
}
