import { t } from "../i18n/index.js";
import { TURN_VIEW_SLOT_ORDER } from "./turn-view-model.js";
import { buildLiveStatusText } from "./turn-view-status.js";

export function createLiveTurnArticleShell(liveTurn, {
  statusText = (turn) => buildLiveStatusText(turn, t),
  slotOrder = TURN_VIEW_SLOT_ORDER,
} = {}) {
  const article = document.createElement("article");
  article.className = "assistant-turn-article is-live";
  article.dataset.turnId = liveTurn.turnId || "";

  const header = document.createElement("header");
  header.className = "assistant-turn-header";
  header.dataset.role = "header";

  const status = document.createElement("div");
  status.className = "assistant-turn-status is-live-status";
  status.dataset.role = "status";
  status.textContent = statusText(liveTurn);

  header.append(status);

  const narrative = document.createElement("div");
  narrative.className = "assistant-turn-narrative markdown-body";
  narrative.dataset.role = "narrative";

  const process = document.createElement("div");
  process.className = "assistant-turn-process";
  process.dataset.role = "process";

  const taskRun = document.createElement("div");
  taskRun.className = "assistant-turn-taskrun";
  taskRun.dataset.role = "taskrun";
  taskRun.hidden = true;

  const artifacts = document.createElement("div");
  artifacts.className = "assistant-turn-artifacts";
  artifacts.dataset.role = "artifacts";
  artifacts.hidden = true;

  const footer = document.createElement("div");
  footer.className = "assistant-turn-footer";
  footer.dataset.role = "footer";
  footer.hidden = true;

  const prompts = document.createElement("div");
  prompts.className = "assistant-turn-prompts";
  prompts.dataset.role = "prompts";

  const roleNodes = { header, process, taskrun: taskRun, narrative, artifacts, footer, prompts };
  article.append(...slotOrder.map((role) => roleNodes[role]).filter(Boolean));
  return article;
}
