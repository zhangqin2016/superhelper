import { t } from "../i18n/index.js";
import { revealLocalFileInFolder } from "./file-reveal.js";
import { showToast } from "./toast.js";

let pdfjsPromise = null;

function tr(key, fallback, params) {
  const value = t(key, params);
  return value === key ? fallback : value;
}

function fileUrlFromPath(filePath = "") {
  const value = String(filePath || "");
  if (/^(https?:|file:|blob:|data:)/i.test(value)) return value;
  if (/^[A-Za-z]:[\\/]/.test(value)) return `file:///${value.replace(/\\/g, "/")}`;
  if (value.startsWith("/")) return `file://${value}`;
  return value;
}

function displayName(block = {}) {
  return block.title || block.relativePath || block.fileName || block.path || tr("artifact.untitled", "Artifact");
}

function bytesText(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function base64ToBytes(value = "") {
  const raw = atob(String(value || ""));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function ensureSumPrecisePolyfill() {
  if (typeof Math.sumPrecise !== "function") {
    Math.sumPrecise = (values) => {
      let sum = 0;
      for (const value of values) sum += Number(value);
      return sum;
    };
  }
}

async function loadPdfjs() {
  ensureSumPrecisePolyfill(); // main thread
  if (!pdfjsPromise) {
    pdfjsPromise = import("../../../node_modules/pdfjs-dist/build/pdf.mjs").then((pdfjs) => {
      // Load the worker through a shim that polyfills Math.sumPrecise in the
      // worker context before pdf.worker.mjs runs.
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("./pdf-worker-shim.mjs", import.meta.url).href;
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

// Without these, CJK text renders as garbage glyphs (no character maps) and
// scanned PDFs (JBIG2/JPEG2000) fail to decode. pdfjs-dist ships them and
// build.files packages them, so point getDocument at the bundled copies.
function pdfResourceOptions() {
  const base = "../../../node_modules/pdfjs-dist/";
  return {
    cMapUrl: new URL(`${base}cmaps/`, import.meta.url).href,
    cMapPacked: true,
    standardFontDataUrl: new URL(`${base}standard_fonts/`, import.meta.url).href,
    wasmUrl: new URL(`${base}wasm/`, import.meta.url).href,
  };
}

function makeAction(label, disabled, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "assistant-renderer-action";
  button.textContent = label;
  button.disabled = Boolean(disabled);
  if (!disabled) button.addEventListener("click", handler);
  return button;
}

export function renderPdfBlock(block = {}) {
  const section = document.createElement("section");
  section.className = "assistant-renderer-block assistant-renderer-pdf";

  const header = document.createElement("div");
  header.className = "assistant-renderer-artifact-header";

  const titleWrap = document.createElement("div");
  titleWrap.className = "assistant-renderer-artifact-title";
  const title = document.createElement("strong");
  title.textContent = displayName(block);
  titleWrap.appendChild(title);
  const metaText = bytesText(block.bytes);
  if (metaText) {
    const meta = document.createElement("span");
    meta.className = "assistant-renderer-meta";
    meta.textContent = metaText;
    titleWrap.appendChild(meta);
  }

  const actions = document.createElement("div");
  actions.className = "assistant-renderer-chart-actions";
  actions.appendChild(makeAction(t("file.reveal"), !block.path, () => void revealLocalFileInFolder(block.path)));
  actions.appendChild(makeAction(t("common.copy"), false, async () => {
    try {
      await navigator.clipboard.writeText(String(block.path || block.relativePath || block.fileName || ""));
      showToast(t("common.copied"), "success");
    } catch {
      showToast(t("common.copyFailed"), "warning");
    }
  }));

  header.append(titleWrap, actions);

  const viewport = document.createElement("div");
  viewport.className = "assistant-pdf-viewport";
  const canvas = document.createElement("canvas");
  canvas.className = "assistant-pdf-canvas";
  viewport.appendChild(canvas);

  const controls = document.createElement("div");
  controls.className = "assistant-pdf-controls";
  const prev = makeAction("‹", true, () => {});
  const next = makeAction("›", true, () => {});
  const pageLabel = document.createElement("span");
  pageLabel.className = "assistant-renderer-meta";
  pageLabel.textContent = tr("renderer.pdfLoading", "Loading PDF...");
  controls.append(prev, pageLabel, next);

  section.append(header, viewport, controls);

  let loadingTask = null;
  let renderTask = null;
  let disposed = false;
  const state = { pdf: null, page: 1, scale: 1.15 };

  async function paint() {
    if (disposed || !state.pdf) return;
    if (renderTask?.cancel) {
      try {
        renderTask.cancel();
      } catch {
        // Ignore cancellation races from quick page switches.
      }
    }
    const page = await state.pdf.getPage(state.page);
    if (disposed) return;
    const ratio = window.devicePixelRatio || 1;
    const available = Math.max(280, viewport.clientWidth || 640);
    const initial = page.getViewport({ scale: 1 });
    state.scale = Math.min(1.8, Math.max(0.6, available / Math.max(1, initial.width)));
    const scaled = page.getViewport({ scale: state.scale * ratio });
    const cssViewport = page.getViewport({ scale: state.scale });
    canvas.width = Math.floor(scaled.width);
    canvas.height = Math.floor(scaled.height);
    canvas.style.width = `${Math.floor(cssViewport.width)}px`;
    canvas.style.height = `${Math.floor(cssViewport.height)}px`;
    const context = canvas.getContext("2d");
    renderTask = page.render({ canvasContext: context, viewport: scaled });
    await renderTask.promise;
    if (disposed) return;
    pageLabel.textContent = `${state.page} / ${state.pdf.numPages}`;
    prev.disabled = state.page <= 1;
    next.disabled = state.page >= state.pdf.numPages;
  }

  prev.addEventListener("click", () => {
    if (!state.pdf || state.page <= 1) return;
    state.page -= 1;
    void paint();
  });
  next.addEventListener("click", () => {
    if (!state.pdf || state.page >= state.pdf.numPages) return;
    state.page += 1;
    void paint();
  });

  queueMicrotask(async () => {
    try {
      const pdfjs = await loadPdfjs();
      // pdf.js v6's getDocument reads src.url / src.data — it no longer accepts
      // a bare string URL, so a path-based PDF must be passed as { url }.
      let source = null;
      if (block.data) {
        source = { data: base64ToBytes(block.data) };
      } else {
        const url = fileUrlFromPath(block.path || block.url || "");
        if (url) source = { url };
      }
      if (!source) throw new Error("no PDF source (missing path/data)");
      loadingTask = pdfjs.getDocument({ ...source, ...pdfResourceOptions() });
      state.pdf = await loadingTask.promise;
      await paint();
    } catch (error) {
      if (disposed) return;
      viewport.classList.add("is-error");
      viewport.textContent = tr("renderer.pdfPreviewFailed", "PDF preview is unavailable. Open the file to view it.");
      console.warn("[pdf-renderer] preview failed", error);
    }
  });

  section.__disposeRenderer = () => {
    disposed = true;
    try {
      renderTask?.cancel?.();
    } catch {
      // Ignore renderer cleanup races.
    }
    void loadingTask?.destroy?.();
  };

  return section;
}
