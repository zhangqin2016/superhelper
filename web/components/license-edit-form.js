"use client";

import { updateLicenseAction } from "../app/admin/actions";
import { Field, SelectField, SubmitButton } from "./admin-forms";
import { MultiSelectField } from "./multi-select-field";

const LICENSE_FEATURES = ["updates", "skill-packages", "usage"];
const FEATURE_OPTIONS = LICENSE_FEATURES.map((id) => ({ id, label: id }));

function isoLocalDate(value) {
  if (!value) return "";
  return new Date(value).toISOString().slice(0, 10);
}

function featureList(features) {
  if (Array.isArray(features)) return features;
  if (typeof features === "string") {
    try {
      const parsed = JSON.parse(features);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return features.split(",").map((item) => item.trim()).filter(Boolean);
    }
  }
  return [];
}

export function LicenseEditForm({ license }) {
  return (
    <form action={updateLicenseAction} className="table-card grid gap-4 p-6 lg:grid-cols-6">
      <input type="hidden" name="id" value={license.id} />
      <div className="lg:col-span-2">
        <Field label="Customer" name="customerName" defaultValue={license.customer_name || ""} />
      </div>
      <SelectField label="Plan" name="plan" defaultValue={license.plan || "pro"} options={["trial", "pro", "team", "enterprise"]} />
      <Field label="Seats" name="seats" type="number" defaultValue={license.seats || 1} />
      <Field label="Expires" name="expiresAt" type="date" defaultValue={isoLocalDate(license.expires_at)} />
      <SelectField label="Status" name="status" defaultValue={license.status || "active"} options={["active", "disabled"]} />
      <div className="lg:col-span-5">
        <MultiSelectField label="Features" name="features" options={FEATURE_OPTIONS} defaultValue={featureList(license.features)} />
      </div>
      <div className="flex items-end">
        <SubmitButton>Save license</SubmitButton>
      </div>
    </form>
  );
}
