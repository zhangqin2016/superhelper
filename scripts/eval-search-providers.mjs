#!/usr/bin/env node
/**
 * Compare web search providers on one question set, the same way for each:
 * the decision "which licensed search API backs Lily's server-side search, and
 * which is the failover" is made on measurements, not on vendor claims.
 *
 *   WEBSEARCH_IQS_API_KEY=… [WEBSEARCH_IQS_API_URL=…] BOCHA_API_KEY=… \
 *     node scripts/eval-search-providers.mjs [--providers iqs,bocha] [--iqs-engines LiteAdvanced,Generic] [--out report.json]
 *
 * A provider runs only when its key is set. Scores per provider:
 * - hit@5: a stable fact from `expect` appears in the top-5 titles/snippets;
 * - fresh@5: for time-sensitive questions, share of the top 5 dated within the
 *   question's window (an undated result counts as not fresh);
 * - latency p50/p95, errors, empty answers, distinct domains in the top 5.
 * Keys are read from the environment and never printed.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const TIMEOUT_MS = Number(process.env.SEARCH_EVAL_TIMEOUT_MS) || 15000;

async function postJson(url, key, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* reported below */ }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${String(data?.message || data?.msg || data?.error?.message || text).slice(0, 160)}`);
  if (!data) throw new Error(`non-JSON response: ${text.slice(0, 120)}`);
  return data;
}

const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } };

// Each adapter maps a provider's response onto { title, url, snippet, date }.
const PROVIDERS = {
  iqs: {
    label: "阿里 IQS",
    key: () => process.env.WEBSEARCH_IQS_API_KEY,
    async search(q, key, variant) {
      const data = await postJson(process.env.WEBSEARCH_IQS_API_URL || "https://cloud-iqs.aliyuncs.com/search/unified", key, {
        query: q, engineType: variant || "LiteAdvanced",
        contents: { mainText: false, markdownText: false, summary: false, rerankScore: true },
      });
      return (data.pageItems || []).map((i) => ({ title: i.title, url: i.link, snippet: i.snippet, date: i.publishedTime }));
    },
  },
  bocha: {
    label: "博查 Web Search",
    key: () => process.env.BOCHA_API_KEY,
    async search(q, key) {
      const data = await postJson("https://api.bochaai.com/v1/web-search", key, { query: q, freshness: "noLimit", summary: true, count: 10 });
      const items = data?.data?.webPages?.value || data?.webPages?.value || [];
      return items.map((i) => ({ title: i.name, url: i.url, snippet: i.summary || i.snippet, date: i.datePublished || i.dateLastCrawled }));
    },
  },
  zhipu: {
    label: "智谱 Web Search (search_std)",
    key: () => process.env.ZHIPU_API_KEY,
    async search(q, key) {
      const data = await postJson("https://open.bigmodel.cn/api/paas/v4/web_search", key, {
        search_query: q, search_engine: process.env.ZHIPU_SEARCH_ENGINE || "search_std", count: 10,
      });
      return (data.search_result || []).map((i) => ({ title: i.title, url: i.link, snippet: i.content, date: i.publish_date }));
    },
  },
  baidu: {
    label: "百度千帆 AI 搜索 (web_search)",
    key: () => process.env.QIANFAN_API_KEY,
    async search(q, key) {
      const data = await postJson("https://qianfan.baidubce.com/v2/ai_search/web_search", key, {
        messages: [{ role: "user", content: q }], search_source: "baidu_search_v2",
        resource_type_filter: [{ type: "web", top_k: 10 }],
      });
      return (data.references || []).map((i) => ({ title: i.title, url: i.url, snippet: i.content || i.snippet, date: i.date }));
    },
  },
  tavily: {
    label: "Tavily",
    key: () => process.env.TAVILY_API_KEY,
    async search(q, key) {
      const data = await postJson("https://api.tavily.com/search", key, { query: q, max_results: 10 });
      return (data.results || []).map((i) => ({ title: i.title, url: i.url, snippet: i.content, date: i.published_date }));
    },
  },
};

function parseDate(value) {
  if (!value) return null;
  const t = Date.parse(String(value).replace(/年|月/g, "-").replace(/日/, ""));
  return Number.isFinite(t) ? t : null;
}

function scoreOne(question, results, now) {
  const top = results.slice(0, 5);
  const text = top.map((r) => `${r.title || ""} ${r.snippet || ""}`).join("\n").toLowerCase();
  const hit = question.expect.some((e) => text.includes(String(e).toLowerCase()));
  let fresh = null;
  if (question.fresh) {
    const windowMs = question.fresh * 86400000;
    fresh = top.length ? top.filter((r) => { const t = parseDate(r.date); return t && now - t <= windowMs && t <= now + 86400000; }).length / top.length : 0;
  }
  return { hit, fresh, count: results.length, dated: top.filter((r) => parseDate(r.date)).length, domains: new Set(top.map((r) => host(r.url)).filter(Boolean)).size };
}

const pct = (xs, p) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

async function main() {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : ""; };
  const only = arg("--providers").split(",").filter(Boolean);
  const { questions } = JSON.parse(fs.readFileSync(path.join(here, "search-eval-questions.json"), "utf8"));
  const now = Date.now();
  const report = { at: new Date(now).toISOString(), questions: questions.length, providers: {} };
  const runs = [];
  for (const [id, provider] of Object.entries(PROVIDERS)) {
    if (only.length && !only.includes(id)) continue;
    const key = provider.key()?.trim();
    if (!key) { console.error(`[search-eval] ${id}: no key, skipped`); continue; }
    // IQS tiers share one key; each requested engine type is its own run.
    const variants = id === "iqs" ? (arg("--iqs-engines") || "LiteAdvanced").split(",").filter(Boolean) : [""];
    for (const variant of variants) runs.push({ id: variant ? `${id}:${variant}` : id, provider, key, variant });
  }
  for (const { id, provider, key, variant } of runs) {
    const rows = [];
    for (const question of questions) {
      const started = Date.now();
      try {
        const results = await provider.search(question.q, key, variant);
        rows.push({ id: question.id, kind: question.kind, ms: Date.now() - started, ...scoreOne(question, results, now),
          top: results.slice(0, 3).map((r) => `${host(r.url)} | ${String(r.title || "").slice(0, 40)}`) });
      } catch (error) {
        rows.push({ id: question.id, kind: question.kind, ms: Date.now() - started, error: String(error?.message || error) });
        console.error(`[search-eval] ${id} ${question.id}: ${String(error?.message || error)}`);
      }
    }
    const ok = rows.filter((r) => !r.error);
    const fresh = ok.filter((r) => r.fresh !== null);
    report.providers[id] = {
      label: variant ? `${provider.label} (${variant})` : provider.label,
      hitAt5: `${ok.filter((r) => r.hit).length}/${rows.length}`,
      freshAt5: fresh.length ? +(fresh.reduce((a, r) => a + r.fresh, 0) / fresh.length).toFixed(2) : null,
      errors: rows.length - ok.length,
      empty: ok.filter((r) => r.count === 0).length,
      p50ms: pct(ok.map((r) => r.ms), 50), p95ms: pct(ok.map((r) => r.ms), 95),
      datedShare: ok.length ? +(ok.reduce((a, r) => a + r.dated, 0) / (ok.length * 5)).toFixed(2) : 0,
      avgDomains: ok.length ? +(ok.reduce((a, r) => a + r.domains, 0) / ok.length).toFixed(1) : 0,
      misses: ok.filter((r) => !r.hit).map((r) => r.id),
      rows,
    };
  }
  const out = arg("--out");
  if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log("| provider | hit@5 | fresh@5 | p50 ms | p95 ms | errors | empty | dated | domains/5 | misses |");
  console.log("|---|---|---|---|---|---|---|---|---|---|");
  for (const p of Object.values(report.providers)) {
    console.log(`| ${p.label} | ${p.hitAt5} | ${p.freshAt5 ?? "-"} | ${p.p50ms} | ${p.p95ms} | ${p.errors} | ${p.empty} | ${p.datedShare} | ${p.avgDomains} | ${p.misses.join(", ") || "-"} |`);
  }
}

main().catch((error) => { console.error(`[search-eval] ${error?.stack || error}`); process.exit(1); });
