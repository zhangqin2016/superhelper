"use client";

/**
 * One field in an admin form.
 *
 * Four panels each defined their own `Field`/`ConfigField`, so the same form
 * control looked and behaved differently depending on which page you opened:
 * some showed help text, none showed a field-level error, and a required field
 * was only discoverable by submitting and reading a server message.
 *
 * This one renders the label, the optional help, the required marker, and a
 * server- or client-reported error next to the control it belongs to.
 */
export function Field({ label, children, help = "", error = "", required = false, span = "" }) {
  return (
    <label className={`block ${span}`}>
      <span className="mb-1 block text-sm font-medium text-slate-700">
        {label}
        {required ? <span className="ms-1 text-red-600" aria-hidden="true">*</span> : null}
      </span>
      {children}
      {help ? <span className="mt-1 block text-xs text-slate-500">{help}</span> : null}
      {error ? <span className="mt-1 block text-xs font-medium text-red-700" role="alert">{error}</span> : null}
    </label>
  );
}
