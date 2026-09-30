import Link from "next/link";
import { ArrowRight } from "lucide-react";

/** System requirements, the first three steps after installing, and where to read more. */
export function DownloadGuide({ copy }) {
  const { requirements, after, more } = copy;
  return (
    <div className="dl-guide">
      <section className="dl-steps" aria-labelledby="dl-after-title">
        <h2 id="dl-after-title" className="site-h2">{after.title}</h2>
        <ol className="dl-step-list">
          {after.steps.map(([title, body], index) => (
            <li key={title} className="dl-step">
              <span className="dl-step-num site-num" aria-hidden="true">{index + 1}</span>
              <h3 className="site-h3">{title}</h3>
              <p>{body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="dl-req" aria-labelledby="dl-req-title">
        <h2 id="dl-req-title" className="site-h3">{requirements.title}</h2>
        <dl className="dl-req-list">
          {requirements.items.map(([label, value]) => (
            <div key={label} className="dl-req-row">
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <nav className="dl-more" aria-label={`${more.changelog} / ${more.help}`}>
        {[["/changelog", more.changelog, more.changelogDesc], ["/docs", more.help, more.helpDesc]].map(([href, title, desc]) => (
          <Link key={href} href={href} className="dl-more-link site-card site-card--interactive">
            <span>
              <span className="dl-more-title">{title}</span>
              <span className="dl-more-desc">{desc}</span>
            </span>
            <ArrowRight size={18} className="dl-arrow" aria-hidden="true" />
          </Link>
        ))}
      </nav>
    </div>
  );
}
