import { redirect } from "next/navigation";

// Merged into the Content library ("Apps" tab). Kept as a redirect for old links.
export default function AppsPage() {
  redirect("/admin/library");
}
