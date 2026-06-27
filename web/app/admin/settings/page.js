import { redirect } from "next/navigation";

// Settings merged into the Config center ("Basics" tab). Kept as a redirect so
// old bookmarks/links still work.
export default function SettingsPage() {
  redirect("/admin/config");
}
