"use strict";

function shortIndexDesc(desc, cap = 180) {
  const s = String(desc || "").replace(/\s+/g, " ").trim();
  if (s.length <= cap) return s;
  const slice = s.slice(0, cap);
  const trimmed = slice.replace(/\s+\S*$/, "");
  return `${(trimmed.length >= cap * 0.6 ? trimmed : slice).trim()}…`;
}

const EXCLUSION = /\bnot\s+for\b|\buse\s+[\w-]+\s+instead\b|不适用|不用于|不负责|不处理|改用|应使用|(?:→|交给)\s*(?:lily-|anthropics-)[\w-]+|لا\s+يُستخدم|ليس\s+لـ/i;
function indexDesc(desc) {
  const text = String(desc || "").replace(/\s+/g, " ").trim();
  const head = shortIndexDesc(text);
  if (process.env.LILY_GUIDE_INDEX_NEGATIVE === "0" || text.length <= 180) return head;
  const shown = head.replace(/…$/, "").length;
  const clauses = [];
  for (const match of text.matchAll(/[^。！？；.!?;]+[。！？；.!?;]?/g)) {
    if (match.index + match[0].length <= shown || !EXCLUSION.test(match[0])) continue;
    const sentence = match[0].trim();
    // Keep a complete exclusion when possible; when a long compound sentence
    // contains multiple routes, retain only the matching comma-delimited parts.
    clauses.push(...(sentence.length <= 160 ? [sentence] : sentence.split(/[，,、；;]/).filter(s => EXCLUSION.test(s)).map(s => s.trim())));
  }
  const tail = shortIndexDesc([...new Set(clauses)].join("; "), 160);
  return tail ? `${head} ${tail}` : head;
}

module.exports = { shortIndexDesc, indexDesc };
