// A coarse, human label for a paired phone from its User-Agent: device family
// and browser only ("iPhone · Safari", "Android · 微信"). Never the full UA —
// the label is shown on the desktop, and a model string is all it needs.

const DEVICE_RULES = [
  [/iPad/i, "iPad"],
  [/iPhone|iPod/i, "iPhone"],
  [/HarmonyOS|OpenHarmony/i, "鸿蒙"],
  [/Android/i, "Android"],
  [/Macintosh|Mac OS X/i, "Mac"],
  [/Windows/i, "Windows"],
  [/Linux/i, "Linux"],
];

const BROWSER_RULES = [
  [/MicroMessenger/i, "微信"],
  [/DingTalk/i, "钉钉"],
  [/Lark|Feishu/i, "飞书"],
  [/\bQQ\//i, "QQ"],
  [/EdgA?\//i, "Edge"],
  [/CriOS|Chrome\//i, "Chrome"],
  [/FxiOS|Firefox\//i, "Firefox"],
  [/Version\/[\d.]+.*Safari\//i, "Safari"],
];

export function mobileLabelFromUserAgent(userAgent) {
  const ua = String(userAgent || "").slice(0, 400);
  if (!ua) return null;
  const device = DEVICE_RULES.find(([re]) => re.test(ua))?.[1] || "";
  const browser = BROWSER_RULES.find(([re]) => re.test(ua))?.[1] || "";
  const label = [device, browser].filter(Boolean).join(" · ");
  return label || null;
}
