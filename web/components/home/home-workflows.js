import { Files, ListChecks, ScanSearch } from "lucide-react";

const icons = [Files, ScanSearch, ListChecks];

export function HomeWorkflows({ problem, copy }) {
  return (
    <section className="home-section home-workflows">
      <div className="shell">
        <div className="home-section-heading home-section-heading--center">
          <p className="home-eyebrow">{problem.eyebrow}</p>
          <h2>{problem.title}</h2>
          <p>{problem.description}</p>
        </div>
        <h3 className="home-workflow-title">{copy.title}</h3>
        <div className="home-workflow-grid">
          {copy.items.map(([title, description], index) => {
            const Icon = icons[index];
            return (
              <article key={title} className="home-workflow-card">
                <div className="home-card-icon"><Icon size={22} /></div>
                <span className="home-step">0{index + 1}</span>
                <h4>{title}</h4>
                <p>{description}</p>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
