"use strict";

/**
 * Email autodiscovery — turn a bare email address into IMAP/SMTP settings so the
 * user never types a host, port, or SSL flag.
 *
 * Resolution order:
 *   1. Built-in table of common providers (esp. CN: 163/126/qq/foxmail/…).
 *   2. Mozilla ISPDB (autoconfig.thunderbird.net) — covers thousands of domains.
 *   3. Convention guess (imap.<domain>:993 / smtp.<domain>:465), flagged so the
 *      UI can let the user confirm.
 *
 * Each result also carries `secretKind` and human guidance: many CN providers
 * (163/qq/…) reject the login password and require an "authorization code"
 * (授权码) / app-password, so we tell the user exactly how to get it.
 */

const ssl = (host, port) => ({ host, port, secure: true });
const starttls = (host, port) => ({ host, port, secure: false });

// guidance: { kind: "password" | "app-password", text, url }
const APP_PW = (text, url) => ({ kind: "app-password", text, url });
const PLAIN = { kind: "password", text: "", url: "" };

const NETEASE_GUIDE = APP_PW(
  "网易邮箱需用「授权码」而非登录密码:网页登录 → 设置 → POP3/SMTP/IMAP → 开启 IMAP/SMTP 服务 → 按提示获取授权码,粘贴到下方。",
  "https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac2 a5feb28b66796d3b",
);
const QQ_GUIDE = APP_PW(
  "QQ/Foxmail 邮箱需用「授权码」:网页登录 → 设置 → 账户 → 开启 IMAP/SMTP 服务 → 生成授权码,粘贴到下方。",
  "https://service.mail.qq.com/detail/0/75",
);

const TABLE = {
  // NetEase
  "163.com": { imap: ssl("imap.163.com", 993), smtp: ssl("smtp.163.com", 465), guide: NETEASE_GUIDE },
  "126.com": { imap: ssl("imap.126.com", 993), smtp: ssl("smtp.126.com", 465), guide: NETEASE_GUIDE },
  "yeah.net": { imap: ssl("imap.yeah.net", 993), smtp: ssl("smtp.yeah.net", 465), guide: NETEASE_GUIDE },
  // Tencent
  "qq.com": { imap: ssl("imap.qq.com", 993), smtp: ssl("smtp.qq.com", 465), guide: QQ_GUIDE },
  "foxmail.com": { imap: ssl("imap.qq.com", 993), smtp: ssl("smtp.qq.com", 465), guide: QQ_GUIDE },
  "exmail.qq.com": { imap: ssl("imap.exmail.qq.com", 993), smtp: ssl("smtp.exmail.qq.com", 465), guide: QQ_GUIDE },
  // Other CN
  "sina.com": { imap: ssl("imap.sina.com", 993), smtp: ssl("smtp.sina.com", 465) },
  "sina.cn": { imap: ssl("imap.sina.com", 993), smtp: ssl("smtp.sina.com", 465) },
  "139.com": { imap: ssl("imap.139.com", 993), smtp: ssl("smtp.139.com", 465) },
  "aliyun.com": { imap: ssl("imap.aliyun.com", 993), smtp: ssl("smtp.aliyun.com", 465) },
  "263.net": { imap: ssl("imap.263.net", 993), smtp: ssl("smtp.263.net", 465) },
  // International (OAuth preferred where available)
  "gmail.com": { imap: ssl("imap.gmail.com", 993), smtp: ssl("smtp.gmail.com", 465), oauthProvider: "gmail", guide: APP_PW("建议用「一键连接 Gmail」授权;若用 IMAP,需先开启两步验证并生成应用专用密码。", "https://support.google.com/mail/answer/185833") },
  "googlemail.com": { imap: ssl("imap.gmail.com", 993), smtp: ssl("smtp.gmail.com", 465), oauthProvider: "gmail" },
  "outlook.com": { imap: ssl("outlook.office365.com", 993), smtp: starttls("smtp.office365.com", 587), oauthProvider: "outlook" },
  "hotmail.com": { imap: ssl("outlook.office365.com", 993), smtp: starttls("smtp.office365.com", 587), oauthProvider: "outlook" },
  "live.com": { imap: ssl("outlook.office365.com", 993), smtp: starttls("smtp.office365.com", 587), oauthProvider: "outlook" },
  "icloud.com": { imap: ssl("imap.mail.me.com", 993), smtp: starttls("smtp.mail.me.com", 587), guide: APP_PW("iCloud 需在 appleid.apple.com 生成「App 专用密码」。", "https://support.apple.com/zh-cn/102654") },
  "me.com": { imap: ssl("imap.mail.me.com", 993), smtp: starttls("smtp.mail.me.com", 587) },
  "yahoo.com": { imap: ssl("imap.mail.yahoo.com", 993), smtp: ssl("smtp.mail.yahoo.com", 465), guide: APP_PW("Yahoo 需生成「应用专用密码」。", "https://help.yahoo.com/kb/SLN15241.html") },
};

function domainOf(email) {
  const at = String(email || "").trim().toLowerCase().lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).trim().toLowerCase() : "";
}

function shape(domain, cfg, source) {
  return {
    provider: "imap-smtp",
    domain,
    source, // "builtin" | "ispdb" | "guess"
    oauthProvider: cfg.oauthProvider || null, // hint: prefer one-click OAuth
    imap: cfg.imap,
    smtp: cfg.smtp,
    secretKind: cfg.guide?.kind || "password",
    guidance: cfg.guide && cfg.guide.text ? { text: cfg.guide.text, url: cfg.guide.url || "" } : null,
  };
}

function lookupBuiltin(domain) {
  const cfg = TABLE[domain];
  return cfg ? shape(domain, cfg, "builtin") : null;
}

// Minimal Thunderbird-autoconfig XML extraction (no XML dep needed for this
// well-formed document). Returns { imap, smtp } or null.
function parseIspdbXml(xml) {
  const pick = (type) => {
    const re = new RegExp(`<(incoming|outgoing)Server[^>]*type="${type}"[^>]*>([\\s\\S]*?)</(incoming|outgoing)Server>`, "i");
    const block = re.exec(xml)?.[2];
    if (!block) return null;
    const host = /<hostname>([^<]+)<\/hostname>/i.exec(block)?.[1]?.trim();
    const port = Number(/<port>(\d+)<\/port>/i.exec(block)?.[1]);
    const socket = /<socketType>([^<]+)<\/socketType>/i.exec(block)?.[1]?.trim().toUpperCase();
    if (!host || !Number.isInteger(port)) return null;
    return { host, port, secure: socket === "SSL" };
  };
  const imap = pick("imap");
  const smtp = pick("smtp");
  return imap && smtp ? { imap, smtp } : null;
}

async function fetchIspdb(domain, { fetchImpl = fetch, timeoutMs = 4000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(domain)}`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const parsed = parseIspdbXml(await res.text());
    return parsed ? shape(domain, parsed, "ispdb") : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function guess(domain) {
  return shape(domain, { imap: ssl(`imap.${domain}`, 993), smtp: ssl(`smtp.${domain}`, 465) }, "guess");
}

/**
 * @param {string} email
 * @param {object} [opts] { fetchImpl, timeoutMs, online }
 * @returns {Promise<object|null>}
 */
async function autodiscover(email, opts = {}) {
  const domain = domainOf(email);
  if (!domain || !domain.includes(".")) return null;
  const builtin = lookupBuiltin(domain);
  if (builtin) return builtin;
  if (opts.online !== false) {
    const ispdb = await fetchIspdb(domain, opts);
    if (ispdb) return ispdb;
  }
  return guess(domain);
}

module.exports = { autodiscover, domainOf, parseIspdbXml, lookupBuiltin };
