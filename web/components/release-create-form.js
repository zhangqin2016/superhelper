"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { createReleaseStateAction } from "../app/admin/actions";
import { CheckboxField, Field, SubmitButton } from "./admin-forms";
import { useI18n } from "../lib/use-i18n";

const initialState = { ok: null, message: "" };
const platforms = ["darwin-arm64", "win32-x64"];

function joinUrl(...parts) {
  return parts
    .filter((part) => part != null && String(part).trim() !== "")
    .map((part, index) => {
      const text = String(part).trim();
      if (index === 0) return text.replace(/\/+$/g, "");
      return text.replace(/^\/+|\/+$/g, "");
    })
    .join("/");
}

async function sha256Hex(file) {
  const buffer = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function ReleaseCreateForm({ cdnBaseUrl = "", cdnPrefix = "app/updates" }) {
  const [state, action, pending] = useActionState(createReleaseStateAction, initialState);
  const { t } = useI18n();
  const [version, setVersion] = useState("");
  const [platform, setPlatform] = useState("darwin-arm64");
  const [url, setUrl] = useState("");
  const [sha256, setSha256] = useState("");
  const [sizeBytes, setSizeBytes] = useState("");
  const [artifactName, setArtifactName] = useState("");
  const [isHashing, setIsHashing] = useState(false);
  const [artifactError, setArtifactError] = useState("");
  const [urlManuallyEdited, setUrlManuallyEdited] = useState(false);

  const suggestedUrl = useMemo(() => {
    if (!cdnBaseUrl || !artifactName || !version || !platform) return "";
    return joinUrl(cdnBaseUrl, cdnPrefix, platform, version, artifactName);
  }, [artifactName, cdnBaseUrl, cdnPrefix, platform, version]);

  useEffect(() => {
    if (suggestedUrl && !urlManuallyEdited) setUrl(suggestedUrl);
  }, [suggestedUrl, urlManuallyEdited]);

  async function handleArtifactChange(event) {
    const file = event.target.files?.[0];
    setArtifactError("");
    if (!file) {
      setArtifactName("");
      return;
    }
    setArtifactName(file.name);
    setSizeBytes(String(file.size));
    if (version && platform && cdnBaseUrl) {
      setUrl(joinUrl(cdnBaseUrl, cdnPrefix, platform, version, file.name));
      setUrlManuallyEdited(false);
    }
    setIsHashing(true);
    try {
      setSha256(await sha256Hex(file));
    } catch (error) {
      setArtifactError(error instanceof Error ? error.message : "Could not read artifact.");
    } finally {
      setIsHashing(false);
    }
  }

  function applySuggestedUrl() {
    if (suggestedUrl) {
      setUrl(suggestedUrl);
      setUrlManuallyEdited(false);
    }
  }

  return (
    <div className="table-card mb-6 p-6">
      <h2 className="mb-5 text-xl font-semibold">{t.admin.pages.releases[0]}</h2>
      <form action={action} className="grid gap-4 lg:grid-cols-6">
        <label className="block">
          <span className="mb-2 block text-sm font-medium text-slate-700">Version</span>
          <input
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand"
            name="version"
            value={version}
            onChange={(event) => setVersion(event.target.value)}
            placeholder="0.1.5"
            required
          />
        </label>
        <label className="block">
          <span className="mb-2 block text-sm font-medium text-slate-700">Platform</span>
          <select
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand"
            name="platform"
            value={platform}
            onChange={(event) => setPlatform(event.target.value)}
          >
            {platforms.map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
        </label>
        <label className="block lg:col-span-2">
          <span className="mb-2 block text-sm font-medium text-slate-700">Installer file</span>
          <input
            className="w-full rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-2.5 text-sm outline-none file:mr-3 file:rounded-md file:border-0 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-700"
            type="file"
            onChange={handleArtifactChange}
          />
        </label>
        <div className="lg:col-span-2">
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-slate-700">Download URL</span>
            <input
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand"
              name="url"
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                setUrlManuallyEdited(true);
              }}
              placeholder={suggestedUrl || "https://qny..."}
              required
            />
          </label>
          {suggestedUrl ? (
            <button className="mt-2 text-xs font-medium text-brand" type="button" onClick={applySuggestedUrl}>
              Use suggested URL
            </button>
          ) : null}
        </div>
        <label className="block lg:col-span-2">
          <span className="mb-2 block text-sm font-medium text-slate-700">SHA256</span>
          <input
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 font-mono text-xs outline-none focus:border-brand"
            name="sha256"
            value={sha256}
            onChange={(event) => setSha256(event.target.value)}
            placeholder={isHashing ? "Calculating..." : ""}
            required
          />
        </label>
        <label className="block">
          <span className="mb-2 block text-sm font-medium text-slate-700">Size bytes</span>
          <input
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand"
            name="sizeBytes"
            value={sizeBytes}
            onChange={(event) => setSizeBytes(event.target.value)}
            placeholder="182000000"
          />
        </label>
        <div className="lg:col-span-2">
          <Field label="Notes" name="notes" placeholder="Release notes" />
        </div>
        <p className="text-sm text-slate-500 lg:col-span-6">
          Select the installer to fill SHA256 and size automatically. Upload the same file to CDN before enabling this release.
        </p>
        {artifactError ? (
          <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800 lg:col-span-6">{artifactError}</p>
        ) : null}
        <div className="flex items-end gap-4">
          <CheckboxField label="Force update" name="forceUpdate" />
          <CheckboxField label="Disabled" name="disabled" />
        </div>
        <div className="flex items-end">
          <SubmitButton disabled={pending || isHashing}>{pending || isHashing ? "..." : t.admin.pages.releases[0]}</SubmitButton>
        </div>
      </form>
      {state?.message ? (
        <p className={`mt-4 rounded-lg px-4 py-3 text-sm ${state.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800"}`}>
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
