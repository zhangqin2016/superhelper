// Minimal, dependency-free, XSS-safe markdown → React nodes (renders elements,
// never dangerouslySetInnerHTML). Covers what desktop replies actually use:
// code blocks, headings, bullet/numbered lists, bold, inline code, links.
function mdInline(text, kp) {
  const nodes = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0; let m; let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) nodes.push(<code key={`${kp}c${k}`} className="rounded bg-[#f1efe9] px-1 py-px font-mono text-[0.85em] text-[#1f2328]">{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("**")) nodes.push(<strong key={`${kp}b${k}`}>{tok.slice(2, -2)}</strong>);
    else { const lm = /\[([^\]]+)\]\(([^)\s]+)\)/.exec(tok); nodes.push(<a key={`${kp}a${k}`} href={lm[2]} target="_blank" rel="noreferrer" className="text-[#2f7de1] underline underline-offset-2">{lm[1]}</a>); }
    last = m.index + tok.length; k += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function renderMarkdown(src) {
  const lines = String(src || "").split("\n");
  const out = []; let i = 0; let key = 0;
  const isBlock = (l) => l.trim().startsWith("```") || /^#{1,6}\s/.test(l) || /^\s*[-*]\s/.test(l) || /^\s*\d+\.\s/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith("```")) {
      const buf = []; i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) { buf.push(lines[i]); i += 1; }
      i += 1;
      out.push(<pre key={key++} className="my-2 overflow-x-auto rounded-xl bg-[#1f2328] p-3 font-mono text-[12px] leading-5 text-[#e6e3db]"><code>{buf.join("\n")}</code></pre>);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { out.push(<p key={key++} className={`mt-1 font-semibold ${h[1].length <= 2 ? "text-base" : "text-sm"}`}>{mdInline(h[2], `h${key}`)}</p>); i += 1; continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = []; while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, "")); i += 1; }
      out.push(<ul key={key++} className="my-1 list-disc pl-5">{items.map((it, ix) => <li key={ix}>{mdInline(it, `u${key}-${ix}`)}</li>)}</ul>);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = []; while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, "")); i += 1; }
      out.push(<ol key={key++} className="my-1 list-decimal pl-5">{items.map((it, ix) => <li key={ix}>{mdInline(it, `o${key}-${ix}`)}</li>)}</ol>);
      continue;
    }
    if (line.trim() === "") { i += 1; continue; }
    const buf = []; while (i < lines.length && lines[i].trim() !== "" && !isBlock(lines[i])) { buf.push(lines[i]); i += 1; }
    out.push(<p key={key++} className="whitespace-pre-wrap break-words">{buf.map((b, bi) => <span key={bi}>{mdInline(b, `p${key}-${bi}`)}{bi < buf.length - 1 ? <br /> : null}</span>)}</p>);
  }
  return out;
}

