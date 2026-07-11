import Link from "next/link";
import { ArrowUpRight, Boxes, ShieldCheck } from "lucide-react";

export function AppCatalog({ apps, copy }) {
  if (!apps.length) return null;
  return (
    <div className="catalog-grid catalog-grid--apps">
      {apps.map((app) => (
        <article className="catalog-card catalog-card--app" key={app.id}>
          <div className="catalog-card-cover" aria-hidden="true"><Boxes size={30} /></div>
          <div className="catalog-card-meta"><span>{copy.categories[app.category] || app.category}</span><span>{app.appType}</span></div>
          <h2>{app.name}</h2>
          <p>{app.summary}</p>
          <div className="catalog-card-footer">
            <span><ShieldCheck size={14} />{app.publisher}</span>
            <Link href={`/apps/${app.id}`}>{copy.details}<ArrowUpRight size={15} /></Link>
          </div>
        </article>
      ))}
    </div>
  );
}
