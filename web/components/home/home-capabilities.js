import { SectionHead } from "../site/section-head";
import { DocumentMock, ExtendMock, MemoryMock, ResearchMock } from "../site/product-mock";

const showcase = [
  ["documents", DocumentMock, "document"],
  ["research", ResearchMock, "research"],
  ["extend", ExtendMock, "extend"],
  ["memory", MemoryMock, "memory"],
];

export function HomeCapabilities({ copy, mini }) {
  return (
    <section className="site-section site-section--sunken hm-caps">
      <div className="shell">
        <SectionHead eyebrow={copy.eyebrow} title={copy.title} description={copy.description} split />
        <div className="hm-cap-grid">
          {showcase.map(([key, Mock, miniKey]) => {
            const [title, description] = copy.items[key];
            return (
              <article key={key} className="site-card hm-cap">
                <div className="hm-cap-stage"><Mock copy={mini[miniKey]} label={title} /></div>
                <div className="hm-cap-body">
                  <h3 className="site-h3">{title}</h3>
                  <p className="site-body">{description}</p>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
