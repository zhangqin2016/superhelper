"use strict";

/**
 * A window must never sit there as a blank rectangle.
 *
 * 2026-09-15: a window whose renderer failed to load, crashed, or simply never
 * painted showed nothing but its background colour — dark before the theme fix,
 * white after. Either way the user reads it as "Lily 白屏". Whatever the cause,
 * the window now explains itself and offers a way out.
 *
 * The fallback page is a self-contained data: URL (no file, no preload, no
 * network) so it works even when whatever broke is the app's own bundle.
 */

const REASONS = {
  "zh-CN": {
    title: "这个窗口没能加载出来",
    load_failed: "页面加载失败。",
    crashed: "页面进程意外退出。",
    never_painted: "页面在预期时间内没有显示内容。",
    detail: "技术信息",
    hint: "可以关掉这个窗口，回到主界面继续；如果是从聊天里的地址打开的，那个地址可能是错的。",
    hint_main: "点「重新加载」即可回到应用，正在进行的任务不受影响。如果反复出现，请重启 Lily，并在「设置 → 支持诊断」里把日志发给我们。",
    retry: "重新加载",
  },
  en: {
    title: "This window could not load",
    load_failed: "The page failed to load.",
    crashed: "The page process exited unexpectedly.",
    never_painted: "The page did not render anything in time.",
    detail: "Technical details",
    hint: "You can close this window and carry on in the main one. If you opened it from an address in the chat, that address may be wrong.",
    hint_main: "Reload to get back into the app; running tasks are not affected. If this keeps happening, restart Lily and send us the logs from Settings → Support diagnostics.",
    retry: "Reload",
  },
  ar: {
    title: "تعذّر تحميل هذه النافذة",
    load_failed: "فشل تحميل الصفحة.",
    crashed: "خرجت عملية الصفحة بشكل غير متوقع.",
    never_painted: "لم تعرض الصفحة أي محتوى في الوقت المتوقع.",
    detail: "تفاصيل تقنية",
    hint: "يمكنك إغلاق هذه النافذة والمتابعة في النافذة الرئيسية. إذا فتحتها من عنوان في المحادثة فقد يكون العنوان خاطئا.",
    hint_main: "أعد التحميل للعودة إلى التطبيق؛ المهام الجارية لا تتأثر. إذا تكرر ذلك فأعد تشغيل Lily وأرسل لنا السجلات من الإعدادات ← تشخيص الدعم.",
    retry: "إعادة التحميل",
  },
};

function copyFor(locale) {
  const key = String(locale || "zh-CN");
  return REASONS[key] || REASONS[key.slice(0, 2)] || REASONS["zh-CN"];
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]
  ));
}

// The fallback page has no preload and no IPC. Its button navigates to this
// URL; the guard intercepts the navigation and loads the real page again.
// (`location.reload()` on a data: page would only reload the explanation.)
const RECOVER_URL = "lily-recover://reload";

/**
 * @param {{ reason?: string, detail?: string, locale?: string, dark?: boolean, role?: "main"|"secondary" }} input
 * @returns {string} a complete HTML document
 */
function buildBlankFallbackHtml({ reason = "never_painted", detail = "", locale = "zh-CN", dark = false, role = "secondary" } = {}) {
  const copy = copyFor(locale);
  const line = copy[reason] || copy.never_painted;
  const hint = role === "main" ? copy.hint_main : copy.hint;
  const ink = dark ? "#e6e8ee" : "#1f2430";
  const muted = dark ? "#9aa3b2" : "#5b6472";
  const bg = dark ? "#121418" : "#f8f9fb";
  const card = dark ? "#1b1f27" : "#ffffff";
  const rtl = String(locale).startsWith("ar");
  return `<!doctype html><html lang="${escapeHtml(locale)}" dir="${rtl ? "rtl" : "ltr"}"><meta charset="utf-8">
<title>${escapeHtml(copy.title)}</title>
<style>
  :root { color-scheme: ${dark ? "dark" : "light"}; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:${bg}; color:${ink};
         font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; }
  main { max-width:520px; padding:28px 32px; background:${card}; border-radius:14px;
         box-shadow:0 8px 28px rgba(15,17,25,${dark ? "0.5" : "0.08"}); }
  h1 { margin:0 0 10px; font-size:17px; font-weight:600; }
  p { margin:0 0 12px; }
  .muted { color:${muted}; font-size:13px; }
  pre { margin:10px 0 0; padding:10px 12px; border-radius:8px; font-size:12px; white-space:pre-wrap;
        word-break:break-all; background:${dark ? "#0e1116" : "#f1f3f7"}; color:${muted}; }
  button { margin-top:16px; padding:8px 16px; font-size:14px; border:0; border-radius:8px;
           background:#2f7de1; color:#fff; cursor:pointer; }
</style>
<main>
  <h1>${escapeHtml(copy.title)}</h1>
  <p>${escapeHtml(line)}</p>
  <p class="muted">${escapeHtml(hint)}</p>
  ${detail ? `<p class="muted">${escapeHtml(copy.detail)}</p><pre>${escapeHtml(detail)}</pre>` : ""}
  <button onclick="location.href='${RECOVER_URL}'">${escapeHtml(copy.retry)}</button>
</main></html>`;
}

function fallbackDataUrl(input) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(buildBlankFallbackHtml(input))}`;
}

module.exports = { RECOVER_URL, buildBlankFallbackHtml, fallbackDataUrl };
