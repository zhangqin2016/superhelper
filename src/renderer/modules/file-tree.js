/**
 * File tree panel rendering (left panel).
 */

import store from "./state.js";
import { $ } from "./dom.js";

const container = () => $("fileTree");

export async function loadFileTree() {
  const result = await window.assistantClient.getFileTree();
  if (result.ok) {
    store.set("fileTree", result.tree);
    renderFileTree();
  }
}

export function renderFileTree() {
  const el = container();
  if (!el) return;
  el.textContent = "";

  const tree = store.get("fileTree") || [];
  for (const node of tree) {
    el.appendChild(renderTreeNode(node, 0));
  }
}

function renderTreeNode(node, depth) {
  const item = document.createElement("div");
  item.className = "file-tree-item";
  item.style.paddingLeft = `${12 + depth * 16}px`;

  const icon = document.createElement("span");
  icon.className = "ft-icon";
  icon.textContent = node.type === "directory" ? "▸" : getFileIcon(node.ext);
  item.appendChild(icon);

  const name = document.createElement("span");
  name.className = "ft-name";
  name.textContent = node.name;
  if (node.status && node.status !== "unchanged") {
    name.className += ` ft-${node.status}`;
  }
  item.appendChild(name);

  item.addEventListener("click", () => {
    if (node.type === "directory") {
      // Toggle children
      const next = item.nextElementSibling;
      const children = [];
      let sibling = item.nextElementSibling;
      while (sibling && parseInt(sibling.style.paddingLeft) > parseInt(item.style.paddingLeft)) {
        children.push(sibling);
        sibling = sibling.nextElementSibling;
      }
      const hidden = children.length > 0 && children[0].style.display !== "none";
      for (const c of children) c.style.display = hidden ? "none" : "";
      icon.textContent = hidden ? "▸" : "▾";
    }
  });

  const frag = document.createDocumentFragment();
  frag.appendChild(item);
  if (node.children && node.type === "directory") {
    for (const child of node.children) {
      frag.appendChild(renderTreeNode(child, depth + 1));
    }
  }
  return frag;
}

function getFileIcon(ext) {
  const map = {
    ".js": "JS", ".ts": "TS", ".jsx": "⚛", ".tsx": "⚛",
    ".py": "🐍", ".go": "🔷", ".rs": "🦀", ".java": "☕",
    ".html": "🌐", ".css": "🎨", ".json": "{}", ".md": "📝",
    ".yml": "📋", ".yaml": "📋", ".toml": "⚙", ".sh": ">_",
    ".gitignore": "⚙",
  };
  return map[ext] || "·";
}

// Listen for file changes from main process
window.assistantClient.onFileChange?.((_payload) => {
  // Debounce reload
  clearTimeout(window._ftTimer);
  window._ftTimer = setTimeout(() => loadFileTree(), 300);
});
