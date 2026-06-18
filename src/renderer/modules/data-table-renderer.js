const TABULATOR_IMPORT_PATH = "../../../node_modules/tabulator-tables/dist/js/tabulator_esm.mjs";

let tabulatorPromise = null;

function loadTabulator() {
  if (!tabulatorPromise) {
    tabulatorPromise = import(TABULATOR_IMPORT_PATH).then((mod) => mod.TabulatorFull || mod.Tabulator || mod.default);
  }
  return tabulatorPromise;
}

function normalizeColumns(columns = [], rows = []) {
  const normalized = (Array.isArray(columns) ? columns : []).map((column) => (
    typeof column === "string"
      ? { key: column, label: column }
      : { key: column?.key || column?.field || column?.label, label: column?.label || column?.title || column?.key || column?.field }
  )).filter((column) => column.key);
  if (normalized.length) return normalized;
  const first = rows.find((row) => row && typeof row === "object" && !Array.isArray(row));
  return Object.keys(first || {}).map((key) => ({ key, label: key }));
}

function normalizeRows(rows = [], columns = []) {
  return (Array.isArray(rows) ? rows : []).map((row, index) => {
    if (!Array.isArray(row)) return { __rowId: index + 1, ...(row || {}) };
    const out = { __rowId: index + 1 };
    columns.forEach((column, columnIndex) => {
      out[column.key] = row[columnIndex];
    });
    return out;
  });
}

function nativeTable(columns, rows) {
  const scroller = document.createElement("div");
  scroller.className = "assistant-renderer-table-scroll";
  const table = document.createElement("table");
  if (columns.length) {
    const thead = document.createElement("thead");
    const tr = document.createElement("tr");
    for (const column of columns) {
      const th = document.createElement("th");
      th.textContent = column.label || column.key;
      tr.appendChild(th);
    }
    thead.appendChild(tr);
    table.appendChild(thead);
  }
  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const column of columns) {
      const td = document.createElement("td");
      const value = row?.[column.key];
      td.textContent = value == null ? "" : String(value);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  scroller.appendChild(table);
  return scroller;
}

export function renderDataTableBlock(block = {}) {
  const wrap = document.createElement("figure");
  wrap.className = "assistant-renderer-block assistant-renderer-table assistant-renderer-data-table";
  if (block.title) {
    const caption = document.createElement("figcaption");
    caption.textContent = block.title;
    wrap.appendChild(caption);
  }

  const rawRows = Array.isArray(block.rows) ? block.rows : [];
  const columns = normalizeColumns(block.columns, rawRows);
  const rows = normalizeRows(rawRows, columns);
  const mount = document.createElement("div");
  mount.className = "assistant-data-table-grid";
  mount.appendChild(nativeTable(columns, rows));
  wrap.appendChild(mount);

  let table = null;
  let disposed = false;
  wrap.__disposeRenderer = () => {
    disposed = true;
    try { table?.destroy?.(); } catch {}
    table = null;
  };

  queueMicrotask(async () => {
    if (disposed || !wrap.isConnected || !rows.length || !columns.length) return;
    try {
      const Tabulator = await loadTabulator();
      if (disposed || !wrap.isConnected || !Tabulator) return;
      mount.replaceChildren();
      table = new Tabulator(mount, {
        data: rows,
        columns: columns.map((column) => ({
          title: column.label || column.key,
          field: column.key,
          sorter: "string",
          headerSort: true,
          minWidth: 120,
        })),
        index: "__rowId",
        layout: "fitDataStretch",
        height: Math.min(420, Math.max(160, rows.length * 40 + 56)),
        placeholder: "No data",
      });
    } catch (error) {
      console.warn("[data-table-renderer] Tabulator render failed", error);
      mount.replaceChildren(nativeTable(columns, rows));
    }
  });

  return wrap;
}
