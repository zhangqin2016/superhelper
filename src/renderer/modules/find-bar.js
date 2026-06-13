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

const ICONS = {
  search:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="m13.5 13.5-3.2-3.2"/></svg>',
  up: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m4 9.5 4-4 4 4"/></svg>',
  down: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m4 6.5 4 4 4-4"/></svg>',
  close:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="m4.5 4.5 7 7m0-7-7 7"/></svg>',
};

function iconButton(icon, title, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "find-btn";
  btn.title = title;
  btn.innerHTML = ICONS[icon];
  btn.addEventListener("click", onClick);
  return btn;
}

function buildBar() {
  bar = document.createElement("div");
  bar.className = "conversation-find-bar";
  bar.hidden = true;

  const searchIcon = document.createElement("span");
  searchIcon.className = "find-search-icon";
  searchIcon.innerHTML = ICONS.search;

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

  const divider = document.createElement("span");
  divider.className = "find-divider";

  const prev = iconButton("up", t("find.prev"), () => jumpTo(current - 1));
  const next = iconButton("down", t("find.next"), () => jumpTo(current + 1));
  const close = iconButton("close", t("find.close"), closeFindBar);

  bar.append(searchIcon, input, counter, divider, prev, next, close);
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
