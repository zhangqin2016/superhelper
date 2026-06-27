import { redirect } from "next/navigation";

// Merged into the Content library ("Runtime" tab). Kept as a redirect for old links.
export default function RuntimePacksPage() {
  redirect("/admin/library");
}
