export function promptCard(title, detail) {
  const card = document.createElement("section");
  card.className = "assistant-prompt-card";
  const h = document.createElement("strong");
  h.textContent = title;
  card.appendChild(h);
  if (detail) {
    const p = document.createElement("p");
    p.textContent = detail;
    card.appendChild(p);
  }
  return card;
}

export function actionRow() {
  const row = document.createElement("div");
  row.className = "assistant-prompt-actions";
  return row;
}

export function actionButton(label, action, { showToast, failureText }) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "assistant-action-btn";
  btn.textContent = label;
  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    // Lock sibling actions while the response is in flight; unlock only on failure.
    const row = btn.closest(".assistant-prompt-actions");
    const group = row ? [...row.querySelectorAll("button")] : [btn];
    for (const item of group) item.disabled = true;
    const unlock = () => {
      for (const item of group) item.disabled = false;
    };
    try {
      const result = await action();
      if (!result?.ok) {
        unlock();
        showToast(result?.detail || result?.error || failureText, "warning");
      }
    } catch (err) {
      unlock();
      showToast(err?.message || failureText, "error");
    }
  });
  return btn;
}
