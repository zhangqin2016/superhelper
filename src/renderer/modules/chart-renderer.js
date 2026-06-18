const ECHARTS_IMPORT_PATH = "../../../node_modules/echarts/dist/echarts.esm.js";

let echartsPromise = null;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function loadECharts() {
  if (!echartsPromise) {
    echartsPromise = import(ECHARTS_IMPORT_PATH).then((mod) => mod.default || mod);
  }
  return echartsPromise;
}

function firstPresent(row, keys) {
  if (Array.isArray(row)) return row[0];
  for (const key of keys) {
    if (row && row[key] != null) return row[key];
  }
  return "";
}

function secondPresent(row, keys) {
  if (Array.isArray(row)) return row[1];
  for (const key of keys) {
    if (row && row[key] != null) return row[key];
  }
  return 0;
}

function numberValue(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeRows(block = {}) {
  const rows = asArray(block.rows).length ? block.rows : asArray(block.data);
  const columns = asArray(block.columns).map((column) => (
    typeof column === "string" ? { key: column, label: column } : column
  ));
  return { rows, columns };
}

function optionFromPie(block = {}) {
  const { rows, columns } = normalizeRows(block);
  const nameKeys = [columns[0]?.key, "name", "label", "category", "title"].filter(Boolean);
  const valueKeys = [columns[1]?.key, "value", "count", "total", "amount"].filter(Boolean);
  const data = rows.map((row) => ({
    name: String(firstPresent(row, nameKeys) || ""),
    value: numberValue(secondPresent(row, valueKeys)),
  })).filter((item) => item.name || item.value);
  return {
    title: block.title ? { text: block.title, left: "center" } : undefined,
    tooltip: { trigger: "item" },
    legend: { type: "scroll", bottom: 0 },
    series: [{
      type: "pie",
      radius: ["42%", "72%"],
      center: ["50%", "45%"],
      avoidLabelOverlap: true,
      label: { formatter: "{b}: {d}%" },
      data,
    }],
  };
}

function optionFromAxisChart(block = {}, type = "bar") {
  const { rows, columns } = normalizeRows(block);
  const nameKeys = [columns[0]?.key, "name", "label", "category", "date", "x"].filter(Boolean);
  const valueKeys = [columns[1]?.key, "value", "count", "total", "amount", "y"].filter(Boolean);
  const names = rows.map((row) => String(firstPresent(row, nameKeys) || ""));
  const values = rows.map((row) => numberValue(secondPresent(row, valueKeys)));
  return {
    title: block.title ? { text: block.title } : undefined,
    tooltip: { trigger: "axis" },
    grid: { left: 48, right: 24, top: block.title ? 52 : 28, bottom: 48 },
    xAxis: { type: "category", data: names, axisLabel: { interval: 0, rotate: names.some((name) => name.length > 8) ? 24 : 0 } },
    yAxis: { type: "value" },
    series: [{ type, data: values, smooth: type === "line" }],
  };
}

function compactOption(option) {
  return JSON.parse(JSON.stringify(option, (_key, value) => value === undefined ? undefined : value));
}

export function isEChartsBlock(block = {}) {
  const chartType = String(block.chartType || block.kind || block.variant || "").toLowerCase();
  if (!chartType || chartType === "mermaid") return false;
  return true;
}

export function normalizeEChartsOption(block = {}) {
  if (block.option && typeof block.option === "object") return block.option;
  if (block.spec?.series || block.spec?.xAxis || block.spec?.yAxis) return block.spec;
  const chartType = String(block.chartType || block.kind || block.variant || "").toLowerCase();
  if (chartType === "pie" || chartType === "donut") return compactOption(optionFromPie(block));
  if (chartType === "line") return compactOption(optionFromAxisChart(block, "line"));
  if (chartType === "scatter") return compactOption(optionFromAxisChart(block, "scatter"));
  return compactOption(optionFromAxisChart(block, "bar"));
}

export function renderEChartsBlock(block = {}) {
  const node = document.createElement("section");
  node.className = "assistant-renderer-block assistant-renderer-chart assistant-renderer-echarts";

  const header = document.createElement("div");
  header.className = "assistant-renderer-chart-header";
  const title = document.createElement("div");
  title.className = "assistant-renderer-label";
  title.textContent = block.title || "Chart";
  const actions = document.createElement("div");
  actions.className = "assistant-renderer-chart-actions";
  header.append(title, actions);

  const canvas = document.createElement("div");
  canvas.className = "assistant-echarts-canvas";
  canvas.textContent = "Rendering chart...";

  node.append(header, canvas);

  let chart = null;
  let resizeObserver = null;
  let disposed = false;

  node.__disposeRenderer = () => {
    disposed = true;
    try { resizeObserver?.disconnect?.(); } catch {}
    try { chart?.dispose?.(); } catch {}
    chart = null;
  };

  queueMicrotask(async () => {
    try {
      const echarts = await loadECharts();
      if (disposed || !node.isConnected) return;
      const option = normalizeEChartsOption(block);
      canvas.textContent = "";
      chart = echarts.init(canvas, null, { renderer: "canvas" });
      chart.setOption(option, true);
      const download = document.createElement("button");
      download.type = "button";
      download.className = "assistant-renderer-action";
      download.textContent = "PNG";
      download.addEventListener("click", () => {
        try {
          const a = document.createElement("a");
          a.href = chart.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: "#fff" });
          a.download = `${block.fileName || block.title || "chart"}.png`;
          a.click();
        } catch {}
      });
      actions.appendChild(download);
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => chart?.resize?.());
        resizeObserver.observe(canvas);
      } else {
        window.addEventListener("resize", () => chart?.resize?.(), { passive: true });
      }
    } catch (error) {
      canvas.classList.add("assistant-echarts-error");
      canvas.textContent = JSON.stringify(block.spec || block.data || block, null, 2);
      console.warn("[chart-renderer] ECharts render failed", error);
    }
  });

  return node;
}
