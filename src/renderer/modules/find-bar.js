import store from "./state.js";
import { t } from "../i18n/index.js";

// In-conversation find (⌘F / Ctrl+F): matches whole message articles in the
// active session panel and steps through them. Article-level highlighting —
// not per-word — keeps it cheap and predictable on huge transcripts.

let bar = null;
let input = null;
let counter = null;
let matches = [];
let current = -1;

function activePanel() {
  const sid = store.get("activeSessionId");
  if (!sid) return null;
  return document.querySelector(`.session-messages[data-session-id="${CSS.escape(sid)}"]`);
}

function clearHighlight() {
  for (const el of matches) el.classList.remove("find-match-current");
  matches = [];
  current = -1;
}

function runSearch() {
  clearHighlight();
  const query = input.value.trim().toLowerCase();
  const panel = activePanel();
  if (!query || !panel) {
    counter.textContent = "";
    return;
  }
  const articles = panel.querySelectorAll(".runtime-messages > *");
  matches = [...articles].filter((el) => (el.textContent || "").toLowerCase().includes(query));
  if (matches.length) jumpTo(0);
  else counter.textContent = t("find.none");
}

function jumpTo(index) {
  if (!matches.length) return;
  if (current >= 0) matches[current].classList.remove("find-match-current");
  current = (index + matches.length) % matches.length;
  const el = matches[current];
  el.classList.add("find-match-current");
  el.scrollIntoView({ block: "center" });
  counter.textContent = t("find.counter", { current: current + 1, total: matches.length });
}

function closeFindBar() {
  if (!bar) return;
  clearHighlight();
  bar.hidden = true;
  document.getElementById("promptInput")?.focus();
}

function openFindBar() {
  if (!bar) buildBar();
  bar.hidden = false;
  input.focus();
  input.select();
  if (input.value) runSearch();
}

function buildBar() {
  bar = document.createElement("div");
  bar.className = "conversation-find-bar";
  bar.hidden = true;

  input = document.createElement("input");
  input.type = "text";
  input.className = "conversation-find-input";
  input.placeholder = t("find.placeholder");
  let timer = null;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(runSearch, 150);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      jumpTo(e.shiftKey ? current - 1 : current + 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeFindBar();
    }
  });

  counter = document.createElement("span");
  counter.className = "conversation-find-counter";

  const prev = document.createElement("button");
  prev.type = "button";
  prev.className = "topbar-btn";
  prev.textContent = "↑";
  prev.addEventListener("click", () => jumpTo(current - 1));

  const next = document.createElement("button");
  next.type = "button";
  next.className = "topbar-btn";
  next.textContent = "↓";
  next.addEventListener("click", () => jumpTo(current + 1));

  const close = document.createElement("button");
  close.type = "button";
  close.className = "topbar-btn";
  close.textContent = "✕";
  close.addEventListener("click", closeFindBar);

  bar.append(input, counter, prev, next, close);
  document.body.appendChild(bar);
}

export function initFindBar() {
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      openFindBar();
    }
  });
}
