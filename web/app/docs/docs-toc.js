"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

// The help center's section nav: a sticky list on desktop, a collapsible
// "Contents" disclosure on phones. Both are real anchor links, so the page
// works without JavaScript; the script only marks the section in view and
// closes the phone disclosure after a jump.
export function DocsToc({ items, label, mobileLabel, heading }) {
  const [active, setActive] = useState(items[0]?.id || "");
  const detailsRef = useRef(null);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return undefined;
    const sections = items.map(({ id }) => document.getElementById(id)).filter(Boolean);
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible[0]) setActive(visible[0].target.id);
    }, { rootMargin: "-96px 0px -60% 0px", threshold: 0 });
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [items]);

  const links = (onPick) => (
    <ol className="hd-toc-list">
      {items.map((item) => (
        <li key={item.id}>
          <a href={`#${item.id}`} aria-current={active === item.id ? "location" : undefined} onClick={onPick}>
            {item.title}
          </a>
        </li>
      ))}
    </ol>
  );

  return (
    <>
      <aside className="hd-aside">
        <nav aria-label={label}>
          <p className="hd-aside-label">{heading}</p>
          {links()}
        </nav>
      </aside>
      <details className="hd-mobile-nav" ref={detailsRef}>
        <summary>
          <span>{mobileLabel}</span>
          <ChevronDown size={16} aria-hidden="true" />
        </summary>
        <nav aria-label={label}>{links(() => { if (detailsRef.current) detailsRef.current.open = false; })}</nav>
      </details>
    </>
  );
}
