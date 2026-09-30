import Link from "next/link";
import { Download } from "lucide-react";
import { DownloadSha } from "./download-sha";

function Meta({ item, labels }) {
  const rows = [
    [labels.version, item.version],
    [labels.size, item.size],
    [labels.released, item.released],
    [labels.installer, item.ext],
  ].filter(([, value]) => value);
  if (!rows.length) return null;
  return (
    <dl className="dl-meta">
      {rows.map(([label, value]) => (
        <div key={label} className="dl-meta-item">
          <dt>{label}</dt>
          <dd className="site-num" dir="ltr">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** One platform's installer. `featured` is the large recommended version. */
export function DownloadCard({ item, copy, commands, featured = false, heading }) {
  const platform = copy.platforms[item.platform];
  const labels = copy.labels;
  return (
    <article className={`dl-card site-card${featured ? " dl-card--featured" : ""}`}>
      <div className="dl-card-main">
        <div className="dl-card-title">
          {heading ? <p className="site-eyebrow dl-card-eyebrow">{heading}</p> : null}
          <h3 className={featured ? "site-h2 dl-card-name" : "site-h3 dl-card-name"}>{platform.name}</h3>
          <p className="dl-card-detail">{platform.detail}</p>
        </div>
        {item.available ? (
          <a href={item.url} className={`site-btn ${featured ? "site-btn--primary site-btn--lg" : "site-btn--secondary"} dl-card-cta`} rel="noopener">
            <Download size={featured ? 18 : 16} aria-hidden="true" />
            {labels.download}
          </a>
        ) : (
          <span className="site-chip dl-card-missing">{labels.unavailable}</span>
        )}
      </div>
      {item.available ? (
        <>
          <Meta item={item} labels={labels} />
          <DownloadSha sha={item.sha} shaShort={item.shaShort} labels={labels} commands={commands} />
        </>
      ) : (
        <p className="dl-card-note">
          {labels.unavailableNote} <Link href="/contact" className="site-link">{labels.contact}</Link>
        </p>
      )}
    </article>
  );
}
