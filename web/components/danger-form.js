"use client";

import { useI18n } from "../lib/use-i18n";

/**
 * The only way the console performs a destructive action.
 *
 * Deleting a device group or a model provider used to submit on the first
 * click — no confirmation anywhere, while deleting a config rule right beside
 * them asked. Consistency here is not cosmetics: an operator learns what a red
 * link costs from the first one they click, and two behaviours teach the wrong
 * lesson. Every destructive action now goes through this component, and a gate
 * forbids wiring one into a bare form.
 *
 * `confirm` is the sentence the operator reads. `name`, when given, is echoed
 * into it, so "delete this?" becomes "delete volcengine-media?".
 */
export function DangerForm({ action, confirm, name = "", className = "inline", children }) {
  const { t } = useI18n();
  const fallback = t?.admin?.confirmDestructive || "This cannot be undone. Continue?";
  const question = confirm || fallback;
  const message = name ? `${question}\n\n${name}` : question;
  return (
    <form
      action={action}
      className={className}
      onSubmit={(event) => {
        if (!window.confirm(message)) event.preventDefault();
      }}
    >
      {children}
    </form>
  );
}
