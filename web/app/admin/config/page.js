import { redirect } from "next/navigation";

export default function ConfigPage() {
  redirect("/admin/config/overview");
}
