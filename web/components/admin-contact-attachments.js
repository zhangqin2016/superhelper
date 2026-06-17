"use client";

import { ExternalLink, ImageIcon, X } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../lib/use-i18n";

function attachmentUrl(attachment) {
  return String(attachment?.public_url || attachment?.publicUrl || "").trim();
}

function attachmentName(attachment, copy) {
  return attachment?.original_name || attachment?.object_key?.split("/").pop() || copy.fallbackName;
}

function formatSize(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function AttachmentThumb({ attachment, onPreview, copy }) {
  const [failed, setFailed] = useState(false);
  const url = attachmentUrl(attachment);
  const name = attachmentName(attachment, copy);
  const canPreview = Boolean(url) && !failed;

  return (
    <button
      type="button"
      onClick={() => {
        if (canPreview) onPreview(attachment);
      }}
      className="group min-w-0 rounded-xl border border-slate-200 bg-white p-2 text-left shadow-sm transition hover:border-teal-300 hover:shadow-md disabled:cursor-not-allowed"
      disabled={!canPreview}
      title={url || attachment?.object_key || name}
    >
      <div className="flex h-24 items-center justify-center overflow-hidden rounded-lg bg-slate-100">
        {canPreview ? (
          <img
            src={url}
            alt={name}
            className="h-full w-full object-cover transition group-hover:scale-[1.03]"
            loading="lazy"
            onError={() => setFailed(true)}
          />
        ) : (
          <div className="flex flex-col items-center gap-2 text-slate-400">
            <ImageIcon className="h-6 w-6" />
            <span className="text-xs">{url ? copy.previewFailed : copy.missingUrl}</span>
          </div>
        )}
      </div>
      <div className="mt-2 truncate text-xs font-semibold text-slate-700">{name}</div>
      <div className="mt-1 truncate text-[11px] text-slate-400">
        {formatSize(attachment?.size_bytes) || attachment?.object_key || copy.attachmentLabel}
      </div>
    </button>
  );
}

export function AdminContactAttachments({ attachments = [] }) {
  const [preview, setPreview] = useState(null);
  const { t } = useI18n();
  const copy = t.admin.attachments;
  const items = Array.isArray(attachments) ? attachments : [];
  const previewUrl = attachmentUrl(preview);

  if (!items.length) return <span className="text-slate-400">-</span>;

  return (
    <>
      <div className="grid min-w-[260px] max-w-[360px] grid-cols-2 gap-3">
        {items.map((attachment) => (
          <AttachmentThumb
            key={attachment.id || attachment.object_key}
            attachment={attachment}
            copy={copy}
            onPreview={setPreview}
          />
        ))}
      </div>

      {preview && previewUrl ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-6"
          role="dialog"
          aria-modal="true"
          onClick={() => setPreview(null)}
        >
          <div
            className="flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <div className="min-w-0">
                <div className="truncate font-semibold text-slate-950">{attachmentName(preview, copy)}</div>
                <div className="mt-1 truncate text-xs text-slate-500">{preview.object_key}</div>
              </div>
              <div className="ml-4 flex shrink-0 items-center gap-2">
                <a
                  href={previewUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                >
                  <ExternalLink className="h-4 w-4" />
                  {copy.openOriginal}
                </a>
                <button
                  type="button"
                  onClick={() => setPreview(null)}
                  className="rounded-lg border border-slate-200 p-2 text-slate-500 hover:bg-slate-50 hover:text-slate-900"
                  aria-label={copy.closePreview}
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-slate-950 p-4">
              <img
                src={previewUrl}
                alt={attachmentName(preview, copy)}
                className="max-h-[78vh] max-w-full rounded-lg object-contain"
              />
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
