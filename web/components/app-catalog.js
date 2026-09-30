import Link from "next/link";
import { ArrowUpRight, Boxes, ChartLine, Clapperboard, CodeXml, Database, FileText, GraduationCap, Plug, Search, Sparkles, Workflow } from "lucide-react";

const CATEGORY_ICONS = {
  business: Workflow,
  finance: ChartLine,
  creative: Clapperboard,
  connectors: Plug,
  office: FileText,
  data: Database,
  productivity: Sparkles,
  developer: CodeXml,
  education: GraduationCap,
  research: Search,
};

// One accent, four compositions: the cover pattern follows the app's place in
// the catalog, so neighbouring cards never look identical.
export function AppCover({ app, index = 0, size = "card" }) {
  const Icon = CATEGORY_ICONS[app.category] || Boxes;
  const mark = Array.from(app.name || "")[0] || "";
  return (
    <div className={`pc-cover pc-cover--p${index % 4} pc-cover--${size}`} aria-hidden="true">
      <span className="pc-cover-icon"><Icon size={size === "hero" ? 26 : 22} strokeWidth={1.75} /></span>
      <span className="pc-cover-mark">{mark}</span>
    </div>
  );
}

export function appTypeLabel(copy, type) {
  return copy.types?.[type] || type;
}

export function AppCatalog({ apps, copy }) {
  if (!apps.length) return null;
  const count = apps.length;
  const layout = count === 1 ? "one" : count === 2 || count === 4 ? "two" : "three";
  const wideLast = layout === "three" && count % 3 === 1;
  return (
    <div className={`pc-app-grid pc-app-grid--${layout}`}>
      {apps.map((app, index) => (
        <Link
          href={`/apps/${app.id}`}
          className={`pc-app-card site-card site-card--interactive${wideLast && index === count - 1 ? " pc-app-card--wide" : ""}`}
          key={app.id}
        >
          <AppCover app={app} index={index} />
          <div className="pc-app-body">
            <div className="pc-app-meta">
              <span className="site-chip site-chip--brand">{copy.categories?.[app.category] || app.category}</span>
              {appTypeLabel(copy, app.appType) !== (copy.categories?.[app.category] || app.category)
                ? <span className="site-chip">{appTypeLabel(copy, app.appType)}</span> : null}
            </div>
            <h2 className="site-h3 pc-app-name">{app.name}</h2>
            <p className="pc-app-summary">{app.summary}</p>
            <div className="pc-app-footer">
              <span>{app.publisher}</span>
              <span className="pc-app-cta">{copy.details}<ArrowUpRight size={15} aria-hidden="true" /></span>
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}
