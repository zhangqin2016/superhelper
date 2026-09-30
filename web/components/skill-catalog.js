"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Search, Sparkles, X } from "lucide-react";

function groupKey(skill) {
  return skill.category || skill.categoryLabel;
}

// The registry labels one category id in more than one way ("office" is both
// 办公文档 and 办公协作), which scattered one-skill groups over the page.
// Group by the id; name the group by the label most of its skills carry.
function groupLabels(skills) {
  const votes = new Map();
  for (const skill of skills) {
    const key = groupKey(skill);
    const tally = votes.get(key) || new Map();
    const label = skill.categoryLabel || skill.category;
    tally.set(label, (tally.get(label) || 0) + 1);
    votes.set(key, tally);
  }
  return new Map([...votes.entries()].map(([key, tally]) => [key, [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0]]));
}

function count(template, n) {
  return String(template || "{n}").replace("{n}", String(n));
}

// The skill library as a compact, filterable list: search by name or purpose,
// narrow to one category, grouped under category headings. Everything is
// server-rendered first (every skill keeps its #id anchor for deep links from
// the wish pool); filtering is in the browser.
export function SkillCatalog({ skills, copy }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");

  const labels = useMemo(() => {
    const majority = groupLabels(skills);
    return new Map([...majority.entries()].map(([key, label]) => [key, copy.categories?.[key] || label]));
  }, [skills, copy.categories]);

  const categories = useMemo(() => {
    const counts = new Map();
    for (const skill of skills) counts.set(groupKey(skill), (counts.get(groupKey(skill)) || 0) + 1);
    return [...counts.entries()];
  }, [skills]);

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const map = new Map();
    for (const skill of skills) {
      const key = groupKey(skill);
      if (category && key !== category) continue;
      if (needle && ![skill.name, skill.description, skill.id, skill.categoryLabel, labels.get(key)].some((value) => String(value || "").toLowerCase().includes(needle))) continue;
      const list = map.get(key) || [];
      list.push(skill);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [skills, labels, query, category]);

  const shown = groups.reduce((total, [, items]) => total + items.length, 0);
  const filtered = Boolean(query.trim() || category);

  return (
    <div className="sk-catalog">
      <div className="sk-toolbar">
        <label className="sk-search">
          <Search size={17} aria-hidden="true" />
          <span className="sk-sr">{copy.searchLabel}</span>
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={copy.searchPlaceholder} autoComplete="off" />
          {query ? <button type="button" className="sk-search-clear" onClick={() => setQuery("")} aria-label={copy.clear}><X size={15} /></button> : null}
        </label>
        <div className="sk-filters" role="group" aria-label={copy.filterLabel}>
          <button type="button" className="sk-filter" aria-pressed={!category} onClick={() => setCategory("")}>
            {copy.all}<span className="site-num">{skills.length}</span>
          </button>
          {categories.map(([key, total]) => (
            <button type="button" key={key} className="sk-filter" aria-pressed={category === key} onClick={() => setCategory(category === key ? "" : key)}>
              {labels.get(key)}<span className="site-num">{total}</span>
            </button>
          ))}
        </div>
      </div>

      <p className="sk-count site-num" aria-live="polite">{count(copy.count, shown)}</p>

      {groups.length ? (
        <div className="sk-groups">
          {groups.map(([key, items]) => (
            <section key={key} className="sk-group" aria-label={labels.get(key)}>
              <h2 className="sk-group-title">{labels.get(key)}<span className="site-num">{items.length}</span></h2>
              <ul className="sk-list">
                {items.map((skill) => (
                  <li id={skill.id} className="sk-item" key={skill.id}>
                    <span className="sk-mark" aria-hidden="true"><Sparkles size={16} strokeWidth={1.75} /></span>
                    <div className="sk-text">
                      <h3>{skill.name}</h3>
                      <p>{skill.description || copy.noDescription}</p>
                    </div>
                    {skill.riskLevel && skill.riskLevel !== "low" ? <span className="site-chip sk-risk">{copy.risks?.[skill.riskLevel] || skill.riskLevel}</span> : null}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <div className="sk-empty site-card">
          <p>{copy.noResults}</p>
          {filtered ? <button type="button" className="site-btn site-btn--secondary site-btn--sm" onClick={() => { setQuery(""); setCategory(""); }}>{copy.clear}</button> : null}
        </div>
      )}

      <div className="sk-cta site-card">
        <div>
          <h2 className="site-h3">{copy.ctaTitle}</h2>
          <p>{copy.ctaBody}</p>
        </div>
        <Link href="/download" className="site-btn site-btn--primary">{copy.getLily}<ArrowUpRight size={16} aria-hidden="true" /></Link>
      </div>
    </div>
  );
}
