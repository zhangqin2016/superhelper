"use client";

import { useFormStatus } from "react-dom";

export function AccountSubmitButton({
  children,
  pendingChildren = "处理中...",
  className = "",
  disabled = false,
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={className}
      disabled={disabled || pending}
      aria-busy={pending ? "true" : "false"}
    >
      {pending ? pendingChildren : children}
    </button>
  );
}
