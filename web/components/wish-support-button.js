"use client";

import { useState } from "react";
import { Heart } from "lucide-react";
import { toggleWishSupportAction } from "../app/wishes/actions";

export function WishSupportButton({ wishId, label, initialSupported = false }) {
  const [supported, setSupported] = useState(initialSupported);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function toggle() {
    if (pending) return;
    const previous = supported;
    setSupported(!previous);
    setPending(true);
    setError("");
    const result = await toggleWishSupportAction({ wishId, supported: previous });
    setPending(false);
    if (result.loginRequired) {
      window.location.assign("/account/login?next=/wishes");
      return;
    }
    if (!result.ok) {
      setSupported(previous);
      setError(result.message || "Unable to update wish");
      return;
    }
    setSupported(Boolean(result.supported));
  }

  return (
    <div className="wish-support-wrap">
      <button type="button" className={`wish-support-button ${supported ? "is-supported" : ""}`} disabled={pending} aria-pressed={supported} onClick={toggle}>
        <Heart size={15} fill={supported ? "currentColor" : "none"} />
        {pending ? "…" : label}
      </button>
      {error ? <span role="alert">{error}</span> : null}
    </div>
  );
}
