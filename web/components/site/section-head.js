/**
 * Eyebrow + heading + optional lead, shared by the home and enterprise pages.
 * `split` puts the lead beside the heading on wide screens.
 */
export function SectionHead({ eyebrow, title, description, align = "start", split = false, as: Heading = "h2", id }) {
  const className = ["site-head", `site-head--${align}`, split ? "site-head--split" : ""].filter(Boolean).join(" ");
  return (
    <div className={className}>
      <div className="site-head-main">
        {eyebrow ? <p className="site-eyebrow">{eyebrow}</p> : null}
        <Heading id={id} className="site-h2">{title}</Heading>
      </div>
      {description ? <p className="site-lead site-head-lead">{description}</p> : null}
    </div>
  );
}
