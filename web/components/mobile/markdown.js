// Minimal, dependency-free, XSS-safe markdown → React nodes (renders elements,
// never dangerouslySetInnerHTML). Covers what desktop replies actually use:
// code blocks, tables, headings, bullet/numbered lists, bold, inline code,
// links. Nothing here may widen the page: long unbroken text (paths, URLs)
// wraps anywhere, and what is wide by nature — code blocks, tables — scrolls
// inside its own box.
function mdInline(text, kp) {
  const nodes = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0; let m; let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) nodes.push(<code key={`${kp}c${k}`} className="rounded bg-[#f1efe9] px-1 py-px font-mono text-[0.85em] text-[#1f2328] [overflow-wrap:anywhere]">{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("**")) nodes.push(<strong key={`${kp}b${k}`}>{tok.slice(2, -2)}</strong>);
    else { const lm = /\[([^\]]+)\]\(([^)\s]+)\)/.exec(tok); nodes.push(<a key={`${kp}a${k}`} href={lm[2]} target="_blank" rel="noreferrer" className="text-[#2f7de1] underline underline-offset-2 [overflow-wrap:anywhere]">{lm[1]}</a>); }
    last = m.index + tok.length; k += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?(\s*:?-{2,}:?\s*\|)+\s*:?-{0,}:?\s*\|?\s*$/;
const cells = (row) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());

export function renderMarkdown(src) {
  const lines = String(src || "").split("\n");
  const out = []; let i = 0; let key = 0;
  const isTable = (at) => TABLE_ROW.test(lines[at] || "") && TABLE_RULE.test(lines[at + 1] || "");
  const isBlock = (l, at) => l.trim().startsWith("```") || /^#{1,6}\s/.test(l) || /^\s*[-*]\s/.test(l) || /^\s*\d+\.\s/.test(l) || isTable(at);
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith("```")) {
      const buf = []; i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) { buf.push(lines[i]); i += 1; }
      i += 1;
      out.push(<pre key={key++} className="my-2 overflow-x-auto rounded-xl bg-[#1f2328] p-3 font-mono text-[12px] leading-5 text-[#e6e3db]"><code>{buf.join("\n")}</code></pre>);
      continue;
    }
    if (isTable(i)) {
      const head = cells(line); i += 2;
      const rows = []; while (i < lines.length && TABLE_ROW.test(lines[i])) { rows.push(cells(lines[i])); i += 1; }
      out.push(
        <div key={key++} className="my-2 overflow-x-auto rounded-xl border border-[#ebe8e1]">
          <table className="w-full border-collapse text-left text-[13px] leading-5">
            <thead className="bg-[#f4f2ed] text-[#4a463f]"><tr>{head.map((cell, ci) => <th key={ci} className="min-w-[5.5rem] px-2.5 py-1.5 font-semibold">{mdInline(cell, `th${key}-${ci}`)}</th>)}</tr></thead>
            <tbody>{rows.map((row, ri) => <tr key={ri} className="border-t border-[#efece6] align-top">{head.map((_, ci) => <td key={ci} className="min-w-[5.5rem] px-2.5 py-1.5 [overflow-wrap:anywhere]">{mdInline(row[ci] || "", `td${key}-${ri}-${ci}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { out.push(<p key={key++} className={`mt-1 font-semibold [overflow-wrap:anywhere] ${h[1].length <= 2 ? "text-base" : "text-sm"}`}>{mdInline(h[2], `h${key}`)}</p>); i += 1; continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = []; while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, "")); i += 1; }
      out.push(<ul key={key++} className="my-1 list-disc pl-5 [overflow-wrap:anywhere]">{items.map((it, ix) => <li key={ix}>{mdInline(it, `u${key}-${ix}`)}</li>)}</ul>);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = []; while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, "")); i += 1; }
      out.push(<ol key={key++} className="my-1 list-decimal pl-5 [overflow-wrap:anywhere]">{items.map((it, ix) => <li key={ix}>{mdInline(it, `o${key}-${ix}`)}</li>)}</ol>);
      continue;
    }
    if (line.trim() === "") { i += 1; continue; }
    const buf = [lines[i]]; i += 1;
    while (i < lines.length && lines[i].trim() !== "" && !isBlock(lines[i], i)) { buf.push(lines[i]); i += 1; }
    out.push(<p key={key++} className="whitespace-pre-wrap [overflow-wrap:anywhere]">{buf.map((b, bi) => <span key={bi}>{mdInline(b, `p${key}-${bi}`)}{bi < buf.length - 1 ? <br /> : null}</span>)}</p>);
  }
  return out;
}

