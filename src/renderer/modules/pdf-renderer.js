import { t } from "../i18n/index.js";
import { openLocalFile, revealLocalFileInFolder } from "./file-reveal.js";
import { loadPdfjs, pdfResourceOptions, pdfSourceFromBlock } from "./pdf-core.js";
import { showToast } from "./toast.js";

const MIN_SCALE = 0.5;
const MAX_SCALE = 2.2;
const ZOOM_STEP = 0.15;

function tr(key, fallback, params) {
  const value = t(key, params);
  return value === key ? fallback : value;
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
  const readAction = makeAction(tr("renderer.pdfOpenViewer", "Read"), false, async () => {
    const { openPdfViewer } = await import("./pdf-viewer.js");
    openPdfViewer(block);
  });
  readAction.classList.add("assistant-pdf-open-viewer");
  actions.appendChild(readAction);
  actions.appendChild(makeAction(tr("file.open", "Open"), !block.path, () => void openLocalFile(block.path)));
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
  const pagesEl = document.createElement("div");
  pagesEl.className = "assistant-pdf-pages";
  viewport.appendChild(pagesEl);

  const controls = document.createElement("div");
  controls.className = "assistant-pdf-controls";
  const zoomOut = makeAction("−", true, () => {});
  const fit = makeAction(tr("renderer.pdfFitWidth", "Fit"), true, () => {});
  const zoomIn = makeAction("+", true, () => {});
  const pageLabel = document.createElement("span");
  pageLabel.className = "assistant-renderer-meta assistant-pdf-page-label";
  pageLabel.textContent = tr("renderer.pdfLoading", "Loading PDF...");
  controls.append(zoomOut, fit, zoomIn, pageLabel);

  section.append(header, viewport, controls);

  let loadingTask = null;
  let observer = null;
  let disposed = false;
  const renderTasks = new Map();
  const state = {
    pdf: null,
    scale: 1,
    zoom: 1,
    fitWidth: true,
    currentPage: 1,
    renderedPages: new Set(),
  };

  function baseScaleFor(page) {
    const available = Math.max(280, viewport.clientWidth || 640) - 28;
    const initial = page.getViewport({ scale: 1 });
    const fitScale = available / Math.max(1, initial.width);
    const manual = state.fitWidth ? fitScale : state.scale;
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, manual * state.zoom));
  }

  function syncControls() {
    const total = state.pdf?.numPages || 0;
    const loaded = Boolean(state.pdf);
    zoomOut.disabled = !loaded || state.zoom <= 0.7;
    zoomIn.disabled = !loaded || state.zoom >= 1.6;
    fit.disabled = !loaded;
    pageLabel.textContent = loaded
      ? `${state.currentPage} / ${total}`
      : tr("renderer.pdfLoading", "Loading PDF...");
  }

  function pageShell(pageNumber) {
    return pagesEl.querySelector(`[data-page="${pageNumber}"]`);
  }

  async function renderPage(pageNumber, { force = false } = {}) {
    if (disposed || !state.pdf) return;
    const shell = pageShell(pageNumber);
    if (!shell) return;
    if (!force && state.renderedPages.has(pageNumber)) return;
    if (renderTasks.has(pageNumber)) return;

    shell.classList.add("is-rendering");
    const canvas = shell.querySelector("canvas");
    const page = await state.pdf.getPage(pageNumber);
    if (disposed) return;
    const ratio = window.devicePixelRatio || 1;
    const scale = baseScaleFor(page);
    state.scale = scale / Math.max(0.1, state.zoom);
    const scaled = page.getViewport({ scale: scale * ratio });
    const cssViewport = page.getViewport({ scale });
    canvas.width = Math.floor(scaled.width);
    canvas.height = Math.floor(scaled.height);
    canvas.style.width = `${Math.floor(cssViewport.width)}px`;
    canvas.style.height = `${Math.floor(cssViewport.height)}px`;
    const context = canvas.getContext("2d");
    const task = page.render({ canvasContext: context, viewport: scaled });
    renderTasks.set(pageNumber, task);
    try {
      await task.promise;
      if (disposed) return;
      shell.classList.remove("is-rendering");
      shell.classList.add("is-rendered");
      state.renderedPages.add(pageNumber);
    } catch (error) {
      if (error?.name !== "RenderingCancelledException") {
        shell.classList.add("is-error");
        shell.querySelector(".assistant-pdf-page-placeholder").textContent =
          tr("renderer.pdfPageFailed", "Page failed to render.");
      }
    } finally {
      renderTasks.delete(pageNumber);
    }
  }

  function rerenderVisiblePages() {
    for (const task of renderTasks.values()) {
      try { task.cancel(); } catch { /* ignore cancellation races */ }
    }
    renderTasks.clear();
    const visible = [...pagesEl.querySelectorAll(".assistant-pdf-page")]
      .filter((shell) => {
        const rect = shell.getBoundingClientRect();
        const bounds = viewport.getBoundingClientRect();
        return rect.bottom >= bounds.top - 240 && rect.top <= bounds.bottom + 240;
      })
      .map((shell) => Number(shell.dataset.page || 0))
      .filter(Boolean);
    for (const pageNumber of visible.length ? visible : [state.currentPage]) {
      state.renderedPages.delete(pageNumber);
      void renderPage(pageNumber, { force: true });
    }
    syncControls();
  }

  function updateCurrentPage() {
    const bounds = viewport.getBoundingClientRect();
    const centerY = bounds.top + bounds.height / 2;
    let best = state.currentPage;
    let bestDistance = Infinity;
    for (const shell of pagesEl.querySelectorAll(".assistant-pdf-page")) {
      const rect = shell.getBoundingClientRect();
      const distance = Math.abs((rect.top + rect.bottom) / 2 - centerY);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = Number(shell.dataset.page || best);
      }
    }
    if (best !== state.currentPage) {
      state.currentPage = best;
      syncControls();
    }
  }

  zoomOut.addEventListener("click", () => {
    state.fitWidth = true;
    state.zoom = Math.max(0.7, Number((state.zoom - ZOOM_STEP).toFixed(2)));
    rerenderVisiblePages();
  });
  zoomIn.addEventListener("click", () => {
    state.fitWidth = true;
    state.zoom = Math.min(1.6, Number((state.zoom + ZOOM_STEP).toFixed(2)));
    rerenderVisiblePages();
  });
  fit.addEventListener("click", () => {
    state.fitWidth = true;
    state.zoom = 1;
    rerenderVisiblePages();
  });
  viewport.addEventListener("scroll", updateCurrentPage, { passive: true });

  queueMicrotask(async () => {
    try {
      const pdfjs = await loadPdfjs();
      // pdf.js v6's getDocument reads src.url / src.data — it no longer accepts
      // a bare string URL, so a path-based PDF must be passed as { url }.
      const source = pdfSourceFromBlock(block);
      if (!source) throw new Error("no PDF source (missing path/data)");
      loadingTask = pdfjs.getDocument({ ...source, ...pdfResourceOptions() });
      state.pdf = await loadingTask.promise;
      pagesEl.replaceChildren();
      for (let pageNumber = 1; pageNumber <= state.pdf.numPages; pageNumber += 1) {
        const page = document.createElement("figure");
        page.className = "assistant-pdf-page";
        page.dataset.page = String(pageNumber);
        page.innerHTML = `
          <div class="assistant-pdf-page-placeholder">${tr("renderer.pdfPageLoading", "Rendering page...")}</div>
          <canvas class="assistant-pdf-canvas"></canvas>
          <figcaption>${pageNumber}</figcaption>
        `;
        pagesEl.appendChild(page);
      }
      if (typeof IntersectionObserver === "function") {
        observer = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              const pageNumber = Number(entry.target.dataset.page || 0);
              if (pageNumber) void renderPage(pageNumber);
            }
          }
        }, { root: viewport, rootMargin: "600px 0px" });
        for (const page of pagesEl.querySelectorAll(".assistant-pdf-page")) observer.observe(page);
      } else {
        for (let pageNumber = 1; pageNumber <= Math.min(3, state.pdf.numPages); pageNumber += 1) {
          void renderPage(pageNumber);
        }
      }
      syncControls();
      await renderPage(1);
      requestAnimationFrame(updateCurrentPage);
    } catch (error) {
      if (disposed) return;
      viewport.classList.add("is-error");
      viewport.textContent = tr("renderer.pdfPreviewFailed", "PDF preview is unavailable. Open the file to view it.");
      console.warn("[pdf-renderer] preview failed", error);
    }
  });

  section.__disposeRenderer = () => {
    disposed = true;
    observer?.disconnect?.();
    try {
      for (const task of renderTasks.values()) task?.cancel?.();
    } catch {
      // Ignore renderer cleanup races.
    }
    void loadingTask?.destroy?.();
  };

  return section;
}
