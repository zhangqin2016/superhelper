/**
 * Progressive enhancement for visible select controls.
 *
 * The native select remains the source of truth so existing change handlers keep
 * working. The custom shell only replaces the browser/OS dropdown chrome.
 */

const enhanced = new WeakMap();
let activeState = null;
let bodyObserver = null;

function selectedOption(select) {
  return select.selectedOptions?.[0] || Array.from(select.options || []).find((option) => option.selected) || select.options?.[0] || null;
}

function optionText(option) {
  return option?.textContent?.trim() || option?.label || option?.value || "";
}

function closeSelect(state) {
  if (!state) return;
  state.menu.hidden = true;
  state.button.setAttribute("aria-expanded", "false");
  state.wrapper.classList.remove("is-open");
  if (activeState === state) activeState = null;
}

function closeActive(except = null) {
  if (activeState && activeState !== except) closeSelect(activeState);
}

function focusOption(state, delta) {
  const options = Array.from(state.menu.querySelectorAll(".lily-select-option:not(:disabled)"));
  if (!options.length) return;
  const current = options.indexOf(document.activeElement);
  const next = current < 0 ? 0 : (current + delta + options.length) % options.length;
  options[next]?.focus();
}

function focusSelected(state) {
  const value = state.select.value;
  const selected = value
    ? state.menu.querySelector(`.lily-select-option[data-value="${CSS.escape(value)}"]`)
    : state.menu.querySelector(".lily-select-option[aria-selected=\"true\"]");
  requestAnimationFrame(() => (selected || state.menu.querySelector(".lily-select-option"))?.focus());
}

function openSelect(state) {
  if (!state || state.select.disabled) return;
  syncCustomSelect(state.select);
  closeActive(state);
  state.menu.hidden = false;
  state.button.setAttribute("aria-expanded", "true");
  state.wrapper.classList.add("is-open");
  activeState = state;
  focusSelected(state);
}

function chooseOption(state, value) {
  if (!state || state.select.disabled) return;
  state.select.value = value;
  closeSelect(state);
  syncCustomSelect(state.select);
  state.select.dispatchEvent(new Event("change", { bubbles: true }));
  state.button.focus();
}

function renderOptions(state) {
  const { select, menu } = state;
  menu.replaceChildren();
  for (const option of Array.from(select.options || [])) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "lily-select-option";
    item.dataset.value = option.value;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", option.selected ? "true" : "false");
    item.disabled = option.disabled;
    item.title = option.title || optionText(option);
    const label = document.createElement("span");
    label.className = "lily-select-option-label";
    label.textContent = optionText(option);
    item.appendChild(label);
    item.addEventListener("click", () => chooseOption(state, option.value));
    menu.appendChild(item);
  }
}

export function syncCustomSelect(select) {
  const state = enhanced.get(select);
  if (!state) return;
  const option = selectedOption(select);
  const label = optionText(option);
  state.label.textContent = label;
  state.button.title = option?.title || select.title || label;
  state.button.disabled = select.disabled;
  state.button.setAttribute("aria-disabled", select.disabled ? "true" : "false");
  state.wrapper.classList.toggle("is-disabled", select.disabled);
  renderOptions(state);
  if (select.disabled) closeSelect(state);
}

export function syncCustomSelects(root = document) {
  for (const select of root.querySelectorAll?.("select.settings-select") || []) {
    syncCustomSelect(select);
  }
}

function enhanceSelect(select) {
  if (!(select instanceof HTMLSelectElement)) return;
  if (!select.classList.contains("settings-select")) return;
  if (enhanced.has(select)) {
    syncCustomSelect(select);
    return;
  }

  const wrapper = document.createElement("span");
  wrapper.className = "lily-select";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "lily-select-button";
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  if (select.id) button.id = `${select.id}CustomButton`;
  const ariaLabel = select.getAttribute("aria-label");
  if (ariaLabel) button.setAttribute("aria-label", ariaLabel);
  const label = document.createElement("span");
  label.className = "lily-select-label";
  button.appendChild(label);

  const menu = document.createElement("div");
  menu.className = "lily-select-menu";
  menu.setAttribute("role", "listbox");
  if (ariaLabel) menu.setAttribute("aria-label", ariaLabel);
  menu.hidden = true;

  wrapper.append(button, menu);
  select.insertAdjacentElement("afterend", wrapper);
  select.classList.add("lily-select-source");
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");

  const state = { select, wrapper, button, label, menu, observer: null };
  enhanced.set(select, state);

  button.addEventListener("click", (event) => {
    event.preventDefault();
    if (menu.hidden) openSelect(state);
    else closeSelect(state);
  });
  button.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openSelect(state);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      openSelect(state);
      focusOption(state, -1);
    }
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSelect(state);
      button.focus();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      focusOption(state, 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusOption(state, -1);
    } else if (event.key === "Home") {
      event.preventDefault();
      menu.querySelector(".lily-select-option:not(:disabled)")?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      const options = menu.querySelectorAll(".lily-select-option:not(:disabled)");
      options[options.length - 1]?.focus();
    } else if (event.key === "Enter" || event.key === " ") {
      const target = event.target?.closest?.(".lily-select-option");
      if (target && !target.disabled) {
        event.preventDefault();
        chooseOption(state, target.dataset.value || "");
      }
    }
  });
  select.addEventListener("change", () => syncCustomSelect(select));
  select.addEventListener("focus", () => button.focus());

  state.observer = new MutationObserver(() => syncCustomSelect(select));
  state.observer.observe(select, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["disabled", "label", "selected", "title", "value"],
  });
  syncCustomSelect(select);
}

export function enhanceCustomSelects(root = document) {
  for (const select of root.querySelectorAll?.("select.settings-select") || []) {
    enhanceSelect(select);
  }
  if (root.matches?.("select.settings-select")) enhanceSelect(root);
}

export function initCustomSelects() {
  enhanceCustomSelects(document);
  if (bodyObserver) return;
  bodyObserver = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes || []) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        enhanceCustomSelects(node);
      }
    }
  });
  bodyObserver.observe(document.body, { childList: true, subtree: true });
  document.addEventListener("pointerdown", (event) => {
    if (activeState && !activeState.wrapper.contains(event.target)) closeSelect(activeState);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeActive();
  });
}
