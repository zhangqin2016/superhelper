import { t } from "../i18n/index.js";
import { showToast } from "./toast.js";

function listText(items = [], formatter) {
  const ul = document.createElement("ul");
  ul.className = "evidence-graph-list";
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = formatter(item);
    ul.appendChild(li);
  }
  return ul;
}

function graphReplayText(graph = {}, bundle = null) {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const items = Array.isArray(bundle?.items) ? bundle.items : [];
  return [
    "Evidence Graph Replay",
    "",
    "Nodes:",
    ...nodes.map((node) => `- ${node.type || "node"}:${node.id || ""} ${node.label || node.name || ""}`.trim()),
    "",
    "Edges:",
    ...edges.map((edge) => `- ${edge.from || ""} -> ${edge.to || ""} ${edge.label || edge.type || ""}`.trim()),
    "",
    "Replay Bundle:",
    ...items.map((item) => `- ${item.kind || "item"}:${item.id || ""} ${item.title || ""}`.trim()),
  ].join("\n");
}

export function openEvidenceGraphViewer(graph = {}, bundle = null) {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const bundleItems = Array.isArray(bundle?.items) ? bundle.items : [];
  const overlay = document.createElement("div");
  overlay.className = "modal-panel evidence-graph-panel";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");

  const card = document.createElement("div");
  card.className = "modal-card evidence-graph-card";

  const header = document.createElement("header");
  header.className = "modal-header";
  const heading = document.createElement("div");
  const title = document.createElement("h2");
  title.textContent = t("evidence.title");
  const subtitle = document.createElement("p");
  subtitle.textContent = t("evidence.subtitle", { nodes: nodes.length, edges: edges.length });
  heading.append(title, subtitle);

  const headerActions = document.createElement("div");
  headerActions.className = "evidence-graph-header-actions";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "topbar-btn";
  copy.textContent = t("evidence.copyReplay");
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(graphReplayText(graph, bundle));
      showToast(t("evidence.copyDone"), "success");
    } catch {
      showToast(t("common.copyFailed"), "warning");
    }
  });
  const close = document.createElement("button");
  close.type = "button";
  close.className = "modal-close-btn";
  close.setAttribute("aria-label", t("composer.close"));
  close.textContent = "×";
  headerActions.append(copy, close);
  header.append(heading, headerActions);

  const body = document.createElement("div");
  body.className = "evidence-graph-body";
  const nodeSection = document.createElement("section");
  const nodeTitle = document.createElement("h3");
  nodeTitle.textContent = t("evidence.nodes");
  nodeSection.append(nodeTitle, nodes.length
    ? listText(nodes, (node) => `${node.type || "node"} · ${node.label || node.name || node.id || ""}`)
    : Object.assign(document.createElement("p"), { textContent: t("evidence.empty") }));

  const edgeSection = document.createElement("section");
  const edgeTitle = document.createElement("h3");
  edgeTitle.textContent = t("evidence.edges");
  edgeSection.append(edgeTitle, edges.length
    ? listText(edges, (edge) => `${edge.from || ""} → ${edge.to || ""}${edge.label || edge.type ? ` · ${edge.label || edge.type}` : ""}`)
    : Object.assign(document.createElement("p"), { textContent: t("evidence.empty") }));
  body.append(nodeSection, edgeSection);
  if (bundleItems.length) {
    const replaySection = document.createElement("section");
    replaySection.className = "evidence-graph-replay-section";
    const replayTitle = document.createElement("h3");
    replayTitle.textContent = t("evidence.replayBundle");
    replaySection.append(replayTitle, listText(bundleItems, (item) => `${item.kind || "item"} · ${item.title || item.id || ""}`));
    body.append(replaySection);
  }
  card.append(header, body);
  overlay.append(card);

  const finish = () => {
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
  };
  function onKey(event) {
    if (event.key === "Escape") finish();
  }
  close.addEventListener("click", finish);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) finish();
  });
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(overlay);
  close.focus();
}
