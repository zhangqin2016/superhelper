// Web app manifest for the phone pages (see app/m/layout.js).
export const dynamic = "force-static";

export function GET() {
  const manifest = {
    name: "Lily 手机控制",
    short_name: "Lily 控制",
    description: "用手机给电脑上的 Lily 派任务、看进度。",
    id: "/m/pair",
    start_url: "/m/pair",
    scope: "/m/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#faf9f7",
    theme_color: "#faf9f7",
    lang: "zh-CN",
    icons: [
      { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
  return new Response(JSON.stringify(manifest), { headers: { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "public, max-age=3600" } });
}
