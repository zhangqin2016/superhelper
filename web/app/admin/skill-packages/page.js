import { redirect } from "next/navigation";

// Merged into the Content library ("Skills" tab). Kept as a redirect for old links.
export default function SkillPackagesPage() {
  redirect("/admin/library");
}
