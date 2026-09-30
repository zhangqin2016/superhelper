import { SectionHead } from "../site/section-head";

// "How it works": hand over the project → it assembles context → keep the files.
export function HomeWorkflows({ copy }) {
  return (
    <section id="product-demo" className="site-section hm-how">
      <div className="shell">
        <SectionHead eyebrow={copy.eyebrow} title={copy.title} description={copy.description} split />
        <ol className="hm-steps">
          {copy.steps.map(([title, description], index) => (
            <li key={title} className="hm-step">
              <span className="hm-step-num site-num">{String(index + 1).padStart(2, "0")}</span>
              <h3 className="site-h3">{title}</h3>
              <p className="site-body">{description}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
