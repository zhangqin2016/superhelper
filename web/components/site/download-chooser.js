"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Info } from "lucide-react";
import { DownloadCard } from "./download-card";
import { detectPlatform, orderForRecommendation } from "../../lib/site-copy-download.mjs";

function readGpuRenderer() {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (!gl) return "";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || "") : "";
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return renderer;
  } catch {
    return "";
  }
}

async function readVisitor() {
  const nav = window.navigator;
  const uad = nav.userAgentData;
  let architecture = "";
  if (uad?.getHighEntropyValues) {
    try {
      architecture = (await uad.getHighEntropyValues(["architecture"]))?.architecture || "";
    } catch {
      architecture = "";
    }
  }
  const input = {
    uaPlatform: uad?.platform || "",
    mobile: Boolean(uad?.mobile),
    architecture,
    userAgent: nav.userAgent || "",
    maxTouchPoints: nav.maxTouchPoints || 0,
    gpuRenderer: "",
  };
  const first = detectPlatform(input);
  // Only a Mac with no architecture hint needs the GPU string to tell chips apart.
  if (first.kind === "mac" && !first.certain) return detectPlatform({ ...input, gpuRenderer: readGpuRenderer() });
  return first;
}

/**
 * The server renders every version with nothing recommended (it cannot know
 * the visitor's computer), so the first client render matches it exactly; the
 * recommendation appears after hydration.
 */
export function DownloadChooser({ items, copy, commands }) {
  const [visitor, setVisitor] = useState(null);

  useEffect(() => {
    let alive = true;
    readVisitor().then((result) => { if (alive) setVisitor(result); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const pick = copy.pick;
  const labels = copy.labels;
  const anyAvailable = items.some((item) => item.available);
  const recommended = visitor?.platform ? orderForRecommendation(items, visitor.platform) : { featured: null, others: items };
  const featured = recommended.featured && recommended.featured.available ? recommended.featured : null;
  const others = featured ? recommended.others : items;

  let neutralTitle = pick.neutralTitle;
  let neutralDesc = pick.neutralDesc;
  if (!anyAvailable) {
    neutralTitle = labels.noneTitle;
    neutralDesc = labels.noneDesc;
  } else if (visitor?.kind === "mobile") {
    neutralDesc = pick.mobile;
  } else if (visitor?.kind === "other") {
    neutralDesc = pick.other;
  }

  return (
    <div className="dl-chooser">
      {featured ? (
        <div className="dl-featured">
          <DownloadCard item={featured} copy={copy} commands={commands} featured heading={pick.recommended} />
          {visitor && !visitor.certain && visitor.kind === "mac" ? (
            <p className="dl-hint"><Info size={16} aria-hidden="true" /><span>{pick.archHint}</span></p>
          ) : null}
        </div>
      ) : (
        <div className="dl-neutral site-card" aria-live="polite">
          <h2 className="site-h3">{neutralTitle}</h2>
          <p className="dl-neutral-desc">
            {neutralDesc}
            {!anyAvailable ? <> <Link href="/contact" className="site-link">{labels.contact}</Link></> : null}
          </p>
        </div>
      )}

      <section className="dl-list" aria-labelledby="dl-list-title">
        <h2 id="dl-list-title" className="dl-list-title">{featured ? pick.others : pick.all}</h2>
        <div className="dl-grid">
          {others.map((item) => <DownloadCard key={item.platform} item={item} copy={copy} commands={commands} />)}
        </div>
      </section>
    </div>
  );
}
