"use strict";

// Deliberately limited to top-level scalar metadata. Nested YAML is ignored,
// never flattened into authoritative name/description/dependency fields.
function scalar(value) {
  if (value.startsWith('"')) {
    try { const parsed = JSON.parse(value); return typeof parsed === "string" ? parsed : ""; } catch { return ""; }
  }
  if (value.startsWith("'")) return value.endsWith("'") ? value.slice(1, -1).replace(/''/g, "'") : "";
  if (/^[\[\]{&*!]|^(?:null|~|true|false)$/i.test(value)) return "";
  return value.replace(/\s+#.*$/, "").trim();
}

function parseFrontmatter(text) {
  const source = typeof text === "string" ? text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n") : "";
  const match = /^---\s*\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(source);
  if (!match) return { meta: {}, body: source.trim() };
  const meta = {};
  const lines = match[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv || ["__proto__", "constructor", "prototype"].includes(kv[1])) continue;
    const value = kv[2].trim();
    if (/^[>|][+-]?(?:\s+#.*)?$/.test(value)) {
      const block = [];
      while (i + 1 < lines.length && /^(?:\s+.*|\s*)$/.test(lines[i + 1])) block.push(lines[++i]);
      const nonempty = block.filter(line => line.trim());
      const indent = nonempty.length ? Math.min(...nonempty.map(line => line.match(/^ */)[0].length)) : 0;
      const content = block.map(line => line.slice(indent)).join("\n").replace(/\n+$/, "");
      meta[kv[1]] = (value[0] === ">" ? content.replace(/([^\n])\n(?=[^\n])/g, "$1 ") : content) + (value[1] === "-" || !content ? "" : "\n");
    } else {
      meta[kv[1]] = scalar(value);
    }
  }
  return { meta, body: match[2].trim() };
}

module.exports = { parseFrontmatter };
