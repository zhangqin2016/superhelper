// The phone pages install as an app: a home-screen icon that opens /m/pair
// full-screen, where the saved pairing reconnects by itself. Without this, the
// page was reachable only by scanning again once its tab was closed.
export const metadata = {
  title: "Lily 手机控制",
  manifest: "/m/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Lily 控制", statusBarStyle: "default" },
  icons: { icon: "/brand/icon-192.png", apple: "/brand/icon-192.png" },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#faf9f7",
};

export default function MobileLayout({ children }) {
  return children;
}
