import { updateLicenseAction } from "../app/admin/actions";
import { Button } from "./ui/button";

function isoLocalDate(value) {
  if (!value) return "";
  return new Date(value).toISOString().slice(0, 10);
}

function featureText(features) {
  if (Array.isArray(features)) return features.join(",");
  if (typeof features === "string") {
    try {
      const parsed = JSON.parse(features);
      if (Array.isArray(parsed)) return parsed.join(",");
    } catch {
      return features;
    }
  }
  return "";
}

export function LicenseEditForm({ license }) {
  return (
    <form action={updateLicenseAction} className="table-card grid gap-4 p-6 lg:grid-cols-6">
      <input type="hidden" name="id" value={license.id} />
      <label className="grid gap-2 text-sm font-medium text-slate-600 lg:col-span-2">
        Customer
        <input name="customerName" defaultValue={license.customer_name || ""} className="rounded-lg border border-slate-200 px-3 py-2" />
      </label>
      <label className="grid gap-2 text-sm font-medium text-slate-600">
        Plan
        <input name="plan" defaultValue={license.plan || "pro"} className="rounded-lg border border-slate-200 px-3 py-2" />
      </label>
      <label className="grid gap-2 text-sm font-medium text-slate-600">
        Seats
        <input name="seats" type="number" min="1" defaultValue={license.seats || 1} className="rounded-lg border border-slate-200 px-3 py-2" />
      </label>
      <label className="grid gap-2 text-sm font-medium text-slate-600">
        Expires
        <input name="expiresAt" type="date" defaultValue={isoLocalDate(license.expires_at)} className="rounded-lg border border-slate-200 px-3 py-2" />
      </label>
      <label className="grid gap-2 text-sm font-medium text-slate-600">
        Status
        <select name="status" defaultValue={license.status} className="rounded-lg border border-slate-200 px-3 py-2">
          <option value="active">active</option>
          <option value="disabled">disabled</option>
        </select>
      </label>
      <label className="grid gap-2 text-sm font-medium text-slate-600 lg:col-span-5">
        Features
        <input name="features" defaultValue={featureText(license.features)} className="rounded-lg border border-slate-200 px-3 py-2" />
      </label>
      <div className="flex items-end">
        <Button>Save license</Button>
      </div>
    </form>
  );
}
