/**
 * Right-hand preview pane: the same previews the app already had (image
 * lightbox, PDF reader, HTML and Markdown artifacts), shown beside the chat in
 * tabs instead of over it. One tab per file; reopening a file selects its tab.
 *
 * It shares the right column with the collaboration panel: whichever opens
 * announces `lily:right-panel-open`, and the other steps aside. Below the
 * docking width it floats over the workbench, as the collaboration panel does.
 * When the pane is unavailable (the standalone collaboration window has none)
 * `tryOpenInPreviewPane` returns false and the caller keeps its old modal.
 */

import { t } from "../i18n/index.js";
import { openLocalFile, revealLocalFileInFolder } from "./file-reveal.js";
import { iconButton } from "./ui-icons.js";

export const RIGHT_PANEL_EVENT = "lily:right-panel-open";
const OWNER = "preview";
const STORAGE_KEY = "lily.preview.paneWidth";
const DOCK_MIN_WINDOW = 1120;
const MIN_WIDTH = 360;
const CHAT_MIN = 480;
const MAX_TABS = 8;

let pane = null;

function tr(key, fallback) {
  const value = t(key);
  return value === key ? fallback : value;
}

function tabKey(item) {
  return `${item.kind}:${item.path || item.src || item.title || ""}`;
}

function tabTitle(item) {
  const raw = item.title || item.path || item.src || "";
  return String(raw).split(/[\\/]/).pop() || tr("artifact.untitled", "Artifact");
}

// Each kind renders into `body` with the renderer the chat already uses, and
// returns its own cleanup.
const RENDERERS = {
  async image(body, item) {
    const wrap = document.createElement("div");
    wrap.className = "preview-pane-image";
    const img = document.createElement("img");
    img.src = item.src;
    img.alt = item.title || "";
    // Full size on demand: the modal the pane replaced.
    img.addEventListener("click", () => { void import("./image-viewer.js").then((mod) => mod.openImageViewer(item.src, item.title, { modal: true })); });
    wrap.appendChild(img);
    body.appendChild(wrap);
    return null;
  },
  async pdf(body, item) {
    const { openPdfViewer } = await import("./pdf-viewer.js");
    const viewer = openPdfViewer(item.block || { path: item.path, title: item.title }, { container: body });
    return () => viewer?.close?.();
  },
  async html(body, item) {
    const { createHtmlPreviewFrame } = await import("./html-renderer.js");
    body.appendChild(createHtmlPreviewFrame(item.block || { path: item.path, title: item.title }));
    return null;
  },
  async markdown(body, item) {
    const { loadMarkdownPreview } = await import("./turn-block-renderers.js");
    const preview = document.createElement("div");
    preview.className = "preview-pane-markdown assistant-turn-final markdown-body";
    body.appendChild(preview);
    await loadMarkdownPreview(preview, item.block || { path: item.path });
    return null;
  },
};

function createPane(shell, root) {
  const tabs = new Map();
  let activeKey = "";
  let open = false;
  let dragging = false;
  let width = Number(window.localStorage?.getItem?.(STORAGE_KEY)) || 0;

  const bar = document.createElement("div");
  bar.className = "preview-pane-bar";
  const tabList = document.createElement("div");
  tabList.className = "preview-pane-tabs";
  tabList.setAttribute("role", "tablist");
  const actions = document.createElement("div");
  actions.className = "preview-pane-actions";
  const openBtn = iconButton("preview-pane-action", "openExternal", tr("file.open", "Open"), { onClick: () => { const tab = tabs.get(activeKey); if (tab?.item.path) void openLocalFile(tab.item.path); } });
  const revealBtn = iconButton("preview-pane-action", "reveal", t("file.reveal"), { onClick: () => { const tab = tabs.get(activeKey); if (tab?.item.path) void revealLocalFileInFolder(tab.item.path); } });
  const closeBtn = iconButton("preview-pane-action preview-pane-close", "close", tr("preview.close", "Close preview"), { align: "end", onClick: () => closePane() });
  actions.append(openBtn, revealBtn, closeBtn);
  bar.append(tabList, actions);
  const bodies = document.createElement("div");
  bodies.className = "preview-pane-bodies";
  root.replaceChildren(bar, bodies);

  const handle = document.getElementById("previewResizeHandle");

  const mode = () => ((Number(window.innerWidth) || 0) >= DOCK_MIN_WINDOW ? "docked" : "overlay");
  const clamp = (value) => {
    const available = Number(window.innerWidth) || 0;
    const fallback = Math.round(available * 0.45) || 560;
    const ceiling = Math.max(MIN_WIDTH, available - CHAT_MIN);
    return Math.min(ceiling, Math.max(MIN_WIDTH, Number(value) || fallback));
  };

  function apply() {
    const current = mode();
    shell.dataset.previewMode = current;
    shell.classList.toggle("preview-pane-open", open);
    shell.style.setProperty("--preview-pane-w", `${clamp(width)}px`);
    root.hidden = !open;
    root.setAttribute("role", current === "overlay" ? "dialog" : "complementary");
    if (handle) handle.hidden = !open || current !== "docked";
    const tab = tabs.get(activeKey);
    openBtn.disabled = !tab?.item.path;
    revealBtn.disabled = !tab?.item.path;
  }

  function select(key) {
    activeKey = key;
    for (const [k, tab] of tabs) {
      const active = k === key;
      tab.head.classList.toggle("is-active", active);
      tab.head.setAttribute("aria-selected", String(active));
      tab.body.hidden = !active;
    }
    tabs.get(key)?.head.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    apply();
  }

  function closeTab(key) {
    const tab = tabs.get(key);
    if (!tab) return;
    try { tab.dispose?.(); } catch (error) { console.warn("[preview-pane] tab dispose failed", error); }
    tab.head.remove();
    tab.body.remove();
    tabs.delete(key);
    if (activeKey === key) {
      const next = [...tabs.keys()].pop();
      if (next) select(next);
      else closePane();
    }
    apply();
  }

  function closePane() {
    if (!open) return;
    for (const key of [...tabs.keys()]) {
      const tab = tabs.get(key);
      try { tab.dispose?.(); } catch (error) { console.warn("[preview-pane] tab dispose failed", error); }
      tab.head.remove();
      tab.body.remove();
      tabs.delete(key);
    }
    activeKey = "";
    open = false;
    apply();
  }

  function openItem(item) {
    const key = tabKey(item);
    if (!tabs.has(key)) {
      if (tabs.size >= MAX_TABS) closeTab(tabs.keys().next().value);
      const head = document.createElement("div");
      head.className = "preview-pane-tab";
      head.setAttribute("role", "tab");
      head.title = item.path || item.title || "";
      const label = document.createElement("button");
      label.type = "button";
      label.className = "preview-pane-tab-label";
      label.textContent = tabTitle(item);
      label.addEventListener("click", () => select(key));
      label.addEventListener("auxclick", (event) => { if (event.button === 1) closeTab(key); });
      const x = iconButton("preview-pane-tab-close", "close", tr("preview.closeTab", "Close tab"), { onClick: (event) => { event.stopPropagation(); closeTab(key); } });
      head.append(label, x);
      tabList.appendChild(head);
      const body = document.createElement("div");
      body.className = `preview-pane-body is-${item.kind}`;
      body.setAttribute("role", "tabpanel");
      bodies.appendChild(body);
      const tab = { item, head, body, dispose: null };
      tabs.set(key, tab);
      RENDERERS[item.kind](body, item).then((dispose) => {
        if (tabs.get(key) === tab) tab.dispose = dispose; else dispose?.();
      }).catch((error) => {
        console.warn(`[preview-pane] ${item.kind} preview failed`, error);
        body.textContent = tr("preview.failed", "This preview is unavailable. Open the file to view it.");
      });
    }
    if (!open) {
      open = true;
      window.dispatchEvent(new CustomEvent(RIGHT_PANEL_EVENT, { detail: { owner: OWNER } }));
    }
    select(key);
  }

  window.addEventListener(RIGHT_PANEL_EVENT, (event) => { if (event.detail?.owner !== OWNER) closePane(); });
  window.addEventListener("resize", apply);
  root.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); closePane(); } });
  handle?.addEventListener("pointerdown", (event) => { dragging = true; handle.classList.add("active"); event.preventDefault(); });
  window.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    width = clamp(document.documentElement.dir === "rtl" ? event.clientX : window.innerWidth - event.clientX);
    apply();
  });
  window.addEventListener("pointerup", () => {
    if (!dragging) return;
    dragging = false;
    handle?.classList.remove("active");
    try { window.localStorage?.setItem?.(STORAGE_KEY, String(width)); } catch { /* per-viewer convenience only */ }
  });
  apply();

  return {
    openItem,
    closePane,
    isOpen: () => open,
    tabKeys: () => [...tabs.keys()],
    activeKey: () => activeKey,
  };
}

function ensurePane() {
  if (pane) return pane;
  const shell = document.getElementById("appShell");
  const root = document.getElementById("previewPane");
  if (!shell || !root || shell.dataset.appView === "collaboration") return null;
  pane = createPane(shell, root);
  return pane;
}

/**
 * Open `item` in the pane. Returns false when there is no pane here (or it
 * failed), so the caller shows its previous modal instead.
 * @param {{kind: "image"|"pdf"|"html"|"markdown", path?: string, src?: string, title?: string, block?: object}} item
 */
export function tryOpenInPreviewPane(item = {}) {
  if (!RENDERERS[item.kind] || !(item.path || item.src || item.block)) return false;
  try {
    const current = ensurePane();
    if (!current) return false;
    current.openItem(item);
    return true;
  } catch (error) {
    console.warn("[preview-pane] open failed; falling back to the modal", error);
    return false;
  }
}

export function previewPaneState() {
  return pane ? { open: pane.isOpen(), tabs: pane.tabKeys(), active: pane.activeKey() } : { open: false, tabs: [], active: "" };
}

export function closePreviewPane() {
  pane?.closePane();
}
