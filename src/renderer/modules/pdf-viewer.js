import { t } from "../i18n/index.js";
import { openLocalFile, revealLocalFileInFolder } from "./file-reveal.js";
import { loadPdfjs, pdfResourceOptions, pdfSourceFromBlock } from "./pdf-core.js";

const MIN_SCALE = 0.55;
const MAX_SCALE = 2.4;
const ZOOM_STEP = 0.15;

let activeViewer = null;

function tr(key, fallback, params) {
  const value = t(key, params);
  return value === key ? fallback : value;
}

function displayName(block = {}) {
  return block.title || block.relativePath || block.fileName || block.path || tr("artifact.untitled", "Artifact");
}

function makeButton(label, className, disabled = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.disabled = Boolean(disabled);
  return button;
}

function scaleForPage(page, container, zoom) {
  const available = Math.max(320, container.clientWidth || 820) - 56;
  const base = page.getViewport({ scale: 1 });
  const fit = available / Math.max(1, base.width);
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, fit * zoom));
}

export function openPdfViewer(block = {}) {
  activeViewer?.close?.();

  const overlay = document.createElement("section");
  overlay.className = "pdf-viewer";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");

  const shell = document.createElement("div");
  shell.className = "pdf-viewer-shell";

  const toolbar = document.createElement("div");
  toolbar.className = "pdf-viewer-toolbar";

  const titleWrap = document.createElement("div");
  titleWrap.className = "pdf-viewer-title";
  const title = document.createElement("strong");
  title.textContent = displayName(block);
  const pageCounter = document.createElement("span");
  pageCounter.textContent = tr("renderer.pdfLoading", "Loading PDF...");
  titleWrap.append(title, pageCounter);

  const searchWrap = document.createElement("div");
  searchWrap.className = "pdf-viewer-search";
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = tr("renderer.pdfSearchPlaceholder", "Search PDF...");
  search.autocomplete = "off";
  const matchLabel = document.createElement("span");
  matchLabel.textContent = "";
  const prevMatch = makeButton("↑", "pdf-viewer-icon-button", true);
  const nextMatch = makeButton("↓", "pdf-viewer-icon-button", true);
  searchWrap.append(search, matchLabel, prevMatch, nextMatch);

  const zoomWrap = document.createElement("div");
  zoomWrap.className = "pdf-viewer-actions";
  const zoomOut = makeButton("−", "pdf-viewer-icon-button", true);
  const fit = makeButton(tr("renderer.pdfFitWidth", "Fit"), "pdf-viewer-button", true);
  const zoomIn = makeButton("+", "pdf-viewer-icon-button", true);
  const open = makeButton(tr("file.open", "Open"), "pdf-viewer-button", !block.path);
  const reveal = makeButton(t("file.reveal"), "pdf-viewer-button", !block.path);
  const close = makeButton("×", "pdf-viewer-close");
  close.setAttribute("aria-label", tr("common.close", "Close"));
  zoomWrap.append(zoomOut, fit, zoomIn, open, reveal, close);

  toolbar.append(titleWrap, searchWrap, zoomWrap);

  const body = document.createElement("div");
  body.className = "pdf-viewer-body";
  const thumbs = document.createElement("aside");
  thumbs.className = "pdf-viewer-thumbs";
  thumbs.setAttribute("aria-label", tr("renderer.pdfThumbnails", "Pages"));
  const scroll = document.createElement("main");
  scroll.className = "pdf-viewer-scroll";
  const pages = document.createElement("div");
  pages.className = "pdf-viewer-pages";
  scroll.appendChild(pages);
  body.append(thumbs, scroll);
  shell.append(toolbar, body);
  overlay.appendChild(shell);
  document.body.appendChild(overlay);

  let loadingTask = null;
  let pdf = null;
  let pageObserver = null;
  let thumbObserver = null;
  let disposed = false;
  let zoom = 1;
  let currentPage = 1;
  let activeMatchIndex = -1;
  const renderedPages = new Set();
  const renderTasks = new Map();
  const textCache = new Map();
  const matches = [];

  function syncControls() {
    const total = pdf?.numPages || 0;
    pageCounter.textContent = total ? `${currentPage} / ${total}` : tr("renderer.pdfLoading", "Loading PDF...");
    zoomOut.disabled = !pdf || zoom <= 0.7;
    zoomIn.disabled = !pdf || zoom >= 1.8;
    fit.disabled = !pdf || zoom === 1;
    prevMatch.disabled = !matches.length;
    nextMatch.disabled = !matches.length;
    matchLabel.textContent = search.value.trim()
      ? (matches.length
        ? `${Math.max(1, activeMatchIndex + 1)} / ${matches.length}`
        : tr("renderer.pdfNoMatches", "No matches"))
      : "";
    for (const button of thumbs.querySelectorAll(".pdf-viewer-thumb")) {
      button.classList.toggle("is-active", Number(button.dataset.page || 0) === currentPage);
      button.classList.toggle("has-match", matches.some((match) => match.pageNumber === Number(button.dataset.page || 0)));
    }
  }

  function pageShell(pageNumber) {
    return pages.querySelector(`[data-page="${pageNumber}"]`);
  }

  async function renderPage(pageNumber, { force = false } = {}) {
    if (disposed || !pdf) return;
    if (!force && renderedPages.has(pageNumber)) return;
    if (renderTasks.has(pageNumber)) return;
    const shellEl = pageShell(pageNumber);
    const canvas = shellEl?.querySelector("canvas");
    if (!shellEl || !canvas) return;
    shellEl.classList.add("is-rendering");
    const page = await pdf.getPage(pageNumber);
    if (disposed) return;
    const scale = scaleForPage(page, scroll, zoom);
    const ratio = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: scale * ratio });
    const cssViewport = page.getViewport({ scale });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${Math.floor(cssViewport.width)}px`;
    canvas.style.height = `${Math.floor(cssViewport.height)}px`;
    const task = page.render({ canvasContext: canvas.getContext("2d"), viewport });
    renderTasks.set(pageNumber, task);
    try {
      await task.promise;
      shellEl.classList.remove("is-rendering");
      shellEl.classList.add("is-rendered");
      renderedPages.add(pageNumber);
    } finally {
      renderTasks.delete(pageNumber);
    }
  }

  async function renderThumb(pageNumber) {
    if (disposed || !pdf) return;
    const button = thumbs.querySelector(`[data-page="${pageNumber}"]`);
    const canvas = button?.querySelector("canvas");
    if (!button || !canvas || button.classList.contains("is-rendered")) return;
    const page = await pdf.getPage(pageNumber);
    if (disposed) return;
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(0.22, 108 / Math.max(1, base.width));
    const viewport = page.getViewport({ scale });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    button.classList.add("is-rendered");
  }

  function rerenderVisiblePages() {
    for (const task of renderTasks.values()) {
      try { task.cancel(); } catch { /* ignore cancellation races */ }
    }
    renderTasks.clear();
    const bounds = scroll.getBoundingClientRect();
    const visible = [...pages.querySelectorAll(".pdf-viewer-page")]
      .filter((page) => {
        const rect = page.getBoundingClientRect();
        return rect.bottom >= bounds.top - 480 && rect.top <= bounds.bottom + 480;
      })
      .map((page) => Number(page.dataset.page || 0))
      .filter(Boolean);
    for (const pageNumber of visible.length ? visible : [currentPage]) {
      renderedPages.delete(pageNumber);
      void renderPage(pageNumber, { force: true });
    }
    syncControls();
  }

  function scrollToPage(pageNumber) {
    const target = pageShell(pageNumber);
    if (!target) return;
    currentPage = pageNumber;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    void renderPage(pageNumber);
    syncControls();
  }

  function updateCurrentPage() {
    const bounds = scroll.getBoundingClientRect();
    const centerY = bounds.top + bounds.height / 2;
    let best = currentPage;
    let bestDistance = Infinity;
    for (const page of pages.querySelectorAll(".pdf-viewer-page")) {
      const rect = page.getBoundingClientRect();
      const distance = Math.abs((rect.top + rect.bottom) / 2 - centerY);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = Number(page.dataset.page || best);
      }
    }
    if (best !== currentPage) {
      currentPage = best;
      syncControls();
    }
  }

  async function extractText(pageNumber) {
    if (textCache.has(pageNumber)) return textCache.get(pageNumber);
    const page = await pdf.getPage(pageNumber);
    const text = await page.getTextContent();
    const value = text.items.map((item) => item.str || "").join(" ");
    textCache.set(pageNumber, value);
    return value;
  }

  async function runSearch() {
    matches.length = 0;
    activeMatchIndex = -1;
    const query = search.value.trim().toLowerCase();
    if (!query || !pdf) {
      syncControls();
      return;
    }
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      if (disposed || search.value.trim().toLowerCase() !== query) return;
      const text = (await extractText(pageNumber)).toLowerCase();
      const count = text.split(query).length - 1;
      for (let i = 0; i < count; i += 1) matches.push({ pageNumber });
    }
    activeMatchIndex = matches.length ? 0 : -1;
    if (matches.length) scrollToPage(matches[0].pageNumber);
    syncControls();
  }

  function jumpMatch(delta) {
    if (!matches.length) return;
    activeMatchIndex = (activeMatchIndex + delta + matches.length) % matches.length;
    scrollToPage(matches[activeMatchIndex].pageNumber);
    syncControls();
  }

  function closeViewer() {
    disposed = true;
    pageObserver?.disconnect?.();
    thumbObserver?.disconnect?.();
    for (const task of renderTasks.values()) {
      try { task.cancel(); } catch { /* ignore cancellation races */ }
    }
    void loadingTask?.destroy?.();
    overlay.remove();
    if (activeViewer?.overlay === overlay) activeViewer = null;
    document.removeEventListener("keydown", onKeyDown);
  }

  function onKeyDown(event) {
    if (event.key === "Escape") closeViewer();
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      search.focus();
      search.select();
    }
  }

  let searchTimer = null;
  search.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => void runSearch(), 180);
  });
  prevMatch.addEventListener("click", () => jumpMatch(-1));
  nextMatch.addEventListener("click", () => jumpMatch(1));
  zoomOut.addEventListener("click", () => {
    zoom = Math.max(0.7, Number((zoom - ZOOM_STEP).toFixed(2)));
    rerenderVisiblePages();
  });
  zoomIn.addEventListener("click", () => {
    zoom = Math.min(1.8, Number((zoom + ZOOM_STEP).toFixed(2)));
    rerenderVisiblePages();
  });
  fit.addEventListener("click", () => {
    zoom = 1;
    rerenderVisiblePages();
  });
  open.addEventListener("click", () => void openLocalFile(block.path));
  reveal.addEventListener("click", () => void revealLocalFileInFolder(block.path));
  close.addEventListener("click", closeViewer);
  scroll.addEventListener("scroll", updateCurrentPage, { passive: true });
  document.addEventListener("keydown", onKeyDown);

  activeViewer = { overlay, close: closeViewer };

  queueMicrotask(async () => {
    try {
      const pdfjs = await loadPdfjs();
      const source = pdfSourceFromBlock(block);
      if (!source) throw new Error("no PDF source (missing path/data)");
      loadingTask = pdfjs.getDocument({ ...source, ...pdfResourceOptions() });
      pdf = await loadingTask.promise;
      pages.replaceChildren();
      thumbs.replaceChildren();
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = document.createElement("figure");
        page.className = "pdf-viewer-page";
        page.dataset.page = String(pageNumber);
        page.innerHTML = `
          <div class="pdf-viewer-page-placeholder">${tr("renderer.pdfPageLoading", "Rendering page...")}</div>
          <canvas></canvas>
          <figcaption>${pageNumber}</figcaption>
        `;
        pages.appendChild(page);

        const thumb = document.createElement("button");
        thumb.type = "button";
        thumb.className = "pdf-viewer-thumb";
        thumb.dataset.page = String(pageNumber);
        thumb.innerHTML = `<canvas></canvas><span>${pageNumber}</span>`;
        thumb.addEventListener("click", () => scrollToPage(pageNumber));
        thumbs.appendChild(thumb);
      }
      if (typeof IntersectionObserver === "function") {
        pageObserver = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) void renderPage(Number(entry.target.dataset.page || 0));
          }
        }, { root: scroll, rootMargin: "700px 0px" });
        for (const page of pages.querySelectorAll(".pdf-viewer-page")) pageObserver.observe(page);
        thumbObserver = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) void renderThumb(Number(entry.target.dataset.page || 0));
          }
        }, { root: thumbs, rootMargin: "260px 0px" });
        for (const thumb of thumbs.querySelectorAll(".pdf-viewer-thumb")) thumbObserver.observe(thumb);
      }
      syncControls();
      await renderPage(1);
      void renderThumb(1);
      requestAnimationFrame(updateCurrentPage);
    } catch (error) {
      pages.textContent = tr("renderer.pdfPreviewFailed", "PDF preview is unavailable. Open the file to view it.");
      console.warn("[pdf-viewer] open failed", error);
    }
  });

  return activeViewer;
}
