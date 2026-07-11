import { Blocks, Eye, FolderKanban } from "lucide-react";

const icons = [FolderKanban, Eye, Blocks];

export function HomeTrust({ copy }) {
  return (
    <section className="home-section home-trust">
      <div className="shell home-trust-inner">
        <div className="home-section-heading">
          <p className="home-eyebrow">{copy.eyebrow}</p>
          <h2>{copy.title}</h2>
        </div>
        <div className="home-trust-list">
          {copy.items.map(([title, description], index) => {
            const Icon = icons[index];
            return <article key={title}><span className="home-card-icon"><Icon size={21} /></span><div><h3>{title}</h3><p>{description}</p></div></article>;
          })}
        </div>
      </div>
    </section>
  );
}
