"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

async function writeClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the selection fallback
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** A checksum shown short, copyable whole, with the full value and how to check it tucked in <details>. */
export function DownloadSha({ sha, shaShort, labels, commands }) {
  const [state, setState] = useState("idle");
  if (!sha) return null;

  async function copy() {
    const ok = await writeClipboard(sha);
    setState(ok ? "copied" : "failed");
    window.setTimeout(() => setState("idle"), 2000);
  }

  return (
    <div className="dl-sha">
      <div className="dl-sha-row">
        <span className="dl-sha-label">{labels.sha}</span>
        <code className="dl-sha-short" title={sha}>{shaShort}</code>
        <button type="button" className="dl-sha-copy" onClick={copy} aria-label={`${labels.copy} ${labels.sha}`}>
          {state === "copied" ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          <span>{state === "copied" ? labels.copied : state === "failed" ? labels.copyFailed : labels.copy}</span>
        </button>
      </div>
      <details className="dl-sha-details">
        <summary>{labels.showFull}</summary>
        <code className="dl-sha-full">{sha}</code>
        <p className="dl-verify-title">{labels.verifyTitle}</p>
        <dl className="dl-verify">
          <dt>{labels.verifyMac}</dt>
          <dd><code dir="ltr">{commands.mac}</code></dd>
          <dt>{labels.verifyWindows}</dt>
          <dd><code dir="ltr">{commands.windows}</code></dd>
        </dl>
        <p className="dl-verify-note">{labels.verifyNote}</p>
      </details>
    </div>
  );
}
