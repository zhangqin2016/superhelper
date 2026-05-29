#!/usr/bin/env node
"use strict";

/**
 * Web search — default 阿里 IQS; optional SearXNG / DuckDuckGo via WEBSEARCH_PROVIDER.
 * IQS: WEBSEARCH_IQS_API_KEY, WEBSEARCH_IQS_ENGINE_TYPE (default LiteAdvanced)
 * SearXNG: WEBSEARCH_SEARXNG_URL=https://your-searx.example
 */

const IQS_API_URL =
  process.env.WEBSEARCH_IQS_API_URL || "https://cloud-iqs.aliyuncs.com/search/unified";
const IQS_ENGINE_TYPE = process.env.WEBSEARCH_IQS_ENGINE_TYPE || "LiteAdvanced";

const DDG_LITE_URL = "https://lite.duckduckgo.com/lite/";
const HTML_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
};

const DEFAULT_SEARXNG_INSTANCES = [
  "https://opnxng.com",
  "https://search.sapti.me",
  "https://priv.au",
  "https://search.ononoki.org",
  "https://grep.vim.wtf",
  "https://searx.be",
];

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (compatible; LilyWorkbench/1.0; +https://github.com/)",
  Accept: "application/json",
};

const REQUEST_TIMEOUT_MS = Number(process.env.WEBSEARCH_TIMEOUT_MS) || 30000;

function errorMessage(err) {
  if (!(err instanceof Error)) return String(err);
  const parts = [err.message];
  if (err.cause instanceof Error && err.cause.message && err.cause.message !== err.message) {
    parts.push(err.cause.message);
  }
  return parts.join(": ");
}

function log(level, message) {
  const ts = new Date().toISOString();
  process.stderr.write(`[${ts}] [${level}:websearch] ${message}\n`);
}

async function readStdin() {
  if (process.stdin.isTTY) {
    throw new Error("No input provided. Pipe JSON to stdin.");
  }
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    throw new Error("No input received on stdin. Provide JSON input via pipe.");
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed.query !== "string" || parsed.query.trim().length < 2) {
    throw new Error("Query must be at least 2 characters.");
  }
  return {
    query: parsed.query.trim(),
    allowed_domains: Array.isArray(parsed.allowed_domains)
      ? parsed.allowed_domains.filter((d) => typeof d === "string")
      : undefined,
    blocked_domains: Array.isArray(parsed.blocked_domains)
      ? parsed.blocked_domains.filter((d) => typeof d === "string")
      : undefined,
  };
}

function validateDomainExclusivity(input) {
  const hasAllowed = input.allowed_domains?.length > 0;
  const hasBlocked = input.blocked_domains?.length > 0;
  if (hasAllowed && hasBlocked) {
    throw new Error(
      "Cannot specify both allowed_domains and blocked_domains in the same request.",
    );
  }
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatSearchResults(results) {
  const lines = ["<search_results>"];
  for (const result of results) {
    lines.push("  <result>");
    lines.push(`    <title>${escapeXml(result.title)}</title>`);
    lines.push(`    <url>${escapeXml(result.url)}</url>`);
    lines.push(`    <snippet>${escapeXml(result.snippet ?? "")}</snippet>`);
    lines.push("  </result>");
  }
  lines.push("</search_results>");
  return lines.join("\n");
}

function normalizeDomain(input) {
  return input
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
}

function matchesDomain(url, domain) {
  const urlHost = normalizeDomain(new URL(url).hostname);
  const normalizedDomain = normalizeDomain(domain);
  return urlHost === normalizedDomain || urlHost.endsWith("." + normalizedDomain);
}

function filterByDomains(results, allowedDomains, blockedDomains) {
  if (!allowedDomains?.length && !blockedDomains?.length) {
    return results;
  }
  if (allowedDomains?.length) {
    return results.filter((result) =>
      allowedDomains.some((domain) => matchesDomain(result.url, domain)),
    );
  }
  return results.filter(
    (result) => !blockedDomains.some((domain) => matchesDomain(result.url, domain)),
  );
}

function searxInstances() {
  const list = [];
  const custom = process.env.WEBSEARCH_SEARXNG_URL?.trim();
  if (custom) list.push(custom.replace(/\/+$/, ""));
  for (const inst of DEFAULT_SEARXNG_INSTANCES) {
    const normalized = inst.replace(/\/+$/, "");
    if (!list.includes(normalized)) list.push(normalized);
  }
  return list;
}

async function searchSearXNG(query, baseUrl) {
  const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json`;
  const response = await fetch(url, {
    headers: FETCH_HEADERS,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`SearXNG ${baseUrl} returned HTTP ${response.status}`);
  }
  const data = await response.json();
  const raw = Array.isArray(data.results) ? data.results : [];
  return raw
    .map((item) => ({
      title: String(item.title || "").trim(),
      url: String(item.url || "").trim(),
      snippet: String(item.content || item.snippet || "").trim(),
    }))
    .filter((item) => item.title && item.url);
}

async function searchWithSearXNG(query) {
  const instances = searxInstances();
  let lastError = null;

  for (const instance of instances) {
    try {
      log("info", `Searching via SearXNG: ${instance}`);
      const results = await searchSearXNG(query, instance);
      if (results.length > 0) {
        log("info", `Got ${results.length} results from ${instance}`);
        return results;
      }
      log("warn", `No results from ${instance}, trying next instance`);
    } catch (err) {
      lastError = err;
      log(
        "warn",
        `${instance} failed: ${errorMessage(err)}`,
      );
    }
  }

  throw lastError || new Error("No search results from any SearXNG instance");
}

function buildIqsAdvancedParams(input) {
  const advancedParams = { numResults: 10 };
  if (input.allowed_domains?.length) {
    advancedParams.includeSites = input.allowed_domains.map(normalizeDomain).join(",");
  } else if (input.blocked_domains?.length) {
    advancedParams.excludeSites = input.blocked_domains.map(normalizeDomain).join(",");
  }
  return advancedParams;
}

async function searchIQS(input) {
  const apiKey = process.env.WEBSEARCH_IQS_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("阿里 IQS 未就绪，请重启应用或联系管理员。");
  }

  const body = {
    query: input.query,
    engineType: IQS_ENGINE_TYPE,
    contents: {
      mainText: false,
      markdownText: false,
      summary: false,
      rerankScore: true,
    },
    advancedParams: buildIqsAdvancedParams(input),
  };

  const response = await fetch(IQS_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const msg =
      data?.message ||
      data?.Message ||
      data?.error?.message ||
      response.statusText ||
      "request failed";
    throw new Error(`阿里 IQS HTTP ${response.status}: ${msg}`);
  }

  const items = Array.isArray(data?.pageItems) ? data.pageItems : [];
  const results = items
    .map((item) => ({
      title: String(item.title || "").trim(),
      url: String(item.link || item.url || "").trim(),
      snippet: String(item.snippet || item.summary || "").trim(),
    }))
    .filter((item) => item.title && item.url);

  if (results.length === 0) {
    throw new Error("阿里 IQS returned no results");
  }
  return results;
}

function extractUrlFromDdgRedirect(href) {
  try {
    const fullHref = href.startsWith("//") ? `https:${href}` : href;
    const parsed = new URL(fullHref);
    const uddg = parsed.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    return fullHref;
  } catch {
    return href;
  }
}

function parseDdgLiteHtml(html) {
  const results = [];
  const linkRe = /<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkRe.exec(html)) !== null) {
    const href = match[1];
    const title = match[2].replace(/<[^>]+>/g, "").trim();
    const resultUrl = extractUrlFromDdgRedirect(href);
    if (title && resultUrl) {
      results.push({ title, url: resultUrl, snippet: "" });
    }
  }
  return results;
}

async function searchDDG(query) {
  const url = `${DDG_LITE_URL}?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: HTML_HEADERS,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`DuckDuckGo returned HTTP ${response.status}`);
  }
  const html = await response.text();
  if (html.includes("DDG.deep.anomalyDetectionBlock")) {
    throw new Error("DuckDuckGo rate-limited this request. Please retry later.");
  }
  const results = parseDdgLiteHtml(html);
  if (results.length === 0) {
    throw new Error("DuckDuckGo returned no results");
  }
  return results;
}

function resolveProvider() {
  const raw = String(process.env.WEBSEARCH_PROVIDER || "iqs").trim().toLowerCase();
  if (raw === "duckduckgo") return "duckduckgo";
  if (raw === "searxng") return "searxng";
  return "iqs";
}

async function searchWithProvider(input) {
  const provider = resolveProvider();
  if (provider === "duckduckgo") {
    log("info", "Searching via DuckDuckGo Lite");
    return searchDDG(input.query);
  }
  if (provider === "searxng") {
    return searchWithSearXNG(input.query);
  }
  log("info", `Searching via 阿里 IQS (${IQS_ENGINE_TYPE})`);
  return searchIQS(input);
}

async function main() {
  try {
    const parsed = await readStdin();
    validateDomainExclusivity(parsed);
    log("info", `Searching for: ${parsed.query} (${resolveProvider()})`);
    const results = await searchWithProvider(parsed);
    const filtered = filterByDomains(
      results,
      parsed.allowed_domains,
      parsed.blocked_domains,
    );
    process.stdout.write(formatSearchResults(filtered));
  } catch (err) {
    log("error", errorMessage(err));
    process.exitCode = 1;
  }
}

main();
