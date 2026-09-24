// The phone's model of the conversation it drives — pure.
//
//   history  the desktop's conversation, as the desktop shows it (session.context)
//   live     the turn running right now, streamed (turn.* / assistant.*)
//   pending  tasks this phone sent that have not become a turn yet
//
// reduce(state, action) → state; messages(state) → what to render. No I/O, no
// React: the page feeds it relay frames and its own sends, and renders the
// selector. A sent task leaves `pending` by IDENTITY — the turn that starts
// from it names its commandId. (A desktop from before that field falls back to
// first-in-first-out, which is how its queue runs; see `legacyFifo`.)

import { FROM_RELAY, TO_PHONE } from "./protocol.mjs";

export function initialConversation() {
  return {
    session: null, // { id, title, phase, runningTurnId, canInterrupt, truncated }
    history: [],
    live: null, // { turnId, commandId, userText, text, status, tool, steps, todos }
    pending: [], // { commandId, text, files, state: "sending" | "queued" }
    prompts: [], // what the desktop waits on this user for (permission / plan / hook / question cards)
    answering: {}, // requestId → true while this phone's answer is on its way
    projects: [],
    selectedProjectId: "",
    sessions: [],
    selectedSessionId: "",
    desktopOnline: null, // null = not known yet
    // What this desktop understands beyond the original protocol, learned from
    // what it sends (a desktop that sends `prompts` also takes session.create).
    desktopFeatures: { prompts: false },
    notice: null, // { kind: "info" | "error", text, seq } — the latest thing worth a toast
  };
}

let noticeSeq = 0;
function notice(kind, text) {
  noticeSeq += 1;
  return { kind, text, seq: noticeSeq };
}

function dropPending(state, commandId) {
  return commandId ? state.pending.filter((p) => p.commandId !== commandId) : state.pending;
}

// A desktop that predates `commandId` on turn.started runs its queue in order.
function legacyFifo(pending) {
  const index = pending.findIndex((p) => p.state === "queued");
  return index < 0 ? pending : [...pending.slice(0, index), ...pending.slice(index + 1)];
}

const REJECT_TEXT = {
  NO_TARGET_SESSION: "电脑上没有可用的会话，请先在电脑上打开一个会话",
  CLIENT_UPGRADE_REQUIRED: "页面版本过旧，请刷新后再发",
  COMMAND_TEXT_TOO_LARGE: "内容太长了，请分几次发送",
};

function onFrame(state, frame) {
  switch (frame.type) {
    case FROM_RELAY.PRESENCE:
      return typeof frame.desktopOnline === "boolean" ? { ...state, desktopOnline: frame.desktopOnline } : state;

    case FROM_RELAY.PEER_OFFLINE:
      return {
        ...state,
        desktopOnline: false,
        pending: dropPending(state, frame.commandId),
        notice: notice("error", "电脑不在线，这条任务没有送达"),
      };

    case TO_PHONE.COMMAND_ADMITTED: {
      const note = frame.attachmentStatus === "dropped" ? "图片没能送达，任务只带了文字"
        : frame.attachmentStatus === "partial" ? "部分图片没能送达" : "";
      return {
        ...state,
        pending: state.pending.map((p) => (p.commandId === frame.commandId ? { ...p, state: "queued" } : p)),
        ...(note ? { notice: notice("error", note) } : {}),
      };
    }

    case TO_PHONE.COMMAND_REJECTED:
      return {
        ...state,
        pending: dropPending(state, frame.commandId),
        notice: notice("error", REJECT_TEXT[frame.code] || `电脑没有接受这条任务（${frame.code || "未知原因"}）`),
      };

    case TO_PHONE.TURN_STARTED:
      return {
        ...state,
        live: { turnId: frame.turnId || "", commandId: frame.commandId || "", userText: frame.userText || "", text: "", status: "running", tool: "", steps: 0, todos: [] },
        pending: frame.commandId ? dropPending(state, frame.commandId) : ("commandId" in frame ? state.pending : legacyFifo(state.pending)),
      };

    case TO_PHONE.ASSISTANT_DELTA:
      if (!state.live || state.live.turnId !== (frame.turnId || "")) return state;
      return { ...state, live: { ...state.live, text: state.live.text + String(frame.text || "") } };

    case TO_PHONE.ASSISTANT_FINAL:
      // Authoritative: the desktop may have rewritten what streamed.
      if (!state.live || !frame.text) return state;
      return { ...state, live: { ...state.live, text: String(frame.text) } };

    case TO_PHONE.TOOL_STARTED:
      return state.live ? { ...state, live: { ...state.live, tool: String(frame.tool || ""), steps: (state.live.steps || 0) + 1 } } : state;

    case TO_PHONE.TODOS_UPDATED:
      if (!state.live || (frame.turnId && state.live.turnId && frame.turnId !== state.live.turnId)) return state;
      return { ...state, live: { ...state.live, todos: Array.isArray(frame.todos) ? frame.todos : [] } };

    case TO_PHONE.TURN_ENDED:
      if (!state.live) return state;
      return { ...state, live: { ...state.live, status: frame.status || "completed", tool: "", ...(frame.text ? { text: String(frame.text) } : {}) } };

    case TO_PHONE.SESSION_CONTEXT: {
      const history = Array.isArray(frame.recent) ? frame.recent : [];
      const switched = state.session && state.session.id !== frame.sessionId;
      let live = switched ? null : state.live;
      let pending = switched ? [] : state.pending;
      // The desktop's history now holds the finished turn: stop showing the copy.
      if (live && history.some((m) => m.role === "assistant" && m.turnId === live.turnId && m.status !== "running")) live = null;
      // The snapshot is the desktop's word on whether anything runs. A phone
      // that slept through turn.ended (a locked screen drops the socket) must
      // not keep "处理中" forever: a desktop that says it is idle has finished
      // this turn, and its history already holds the answer. That word is
      // `runningTurnId` (present while a turn runs), or — from a desktop that
      // predates it and sends no turn ids — its phase.
      const idle = !frame.runningTurnId && frame.phase === "idle";
      if (idle) {
        live = null;
        // Nothing waits on an idle desktop: what it admitted has already run.
        if (!Number(frame.queueLength)) pending = pending.filter((p) => p.state !== "queued");
      }
      // Joined mid-turn (reopened the page): pick the running turn up from history.
      if (!live && frame.runningTurnId) {
        const partial = history.find((m) => m.role === "assistant" && m.turnId === frame.runningTurnId);
        live = { turnId: frame.runningTurnId, commandId: "", userText: "", text: partial?.text || "", status: "running", tool: "", steps: 0, todos: [] };
      }
      return {
        ...state,
        session: {
          id: frame.sessionId || "",
          title: frame.title || "",
          phase: frame.phase || "",
          runningTurnId: frame.runningTurnId || "",
          canInterrupt: Boolean(frame.canInterrupt),
          truncated: Boolean(frame.truncated),
        },
        selectedSessionId: frame.sessionId || state.selectedSessionId,
        history,
        live,
        pending,
        // A desktop that predates prompts sends none: keep nothing it cannot confirm.
        prompts: Array.isArray(frame.prompts) ? frame.prompts : [],
        answering: switched ? {} : state.answering,
        desktopFeatures: { ...state.desktopFeatures, prompts: Array.isArray(frame.prompts) },
      };
    }

    case TO_PHONE.SESSIONS_LIST:
      return {
        ...state,
        sessions: Array.isArray(frame.sessions) ? frame.sessions : [],
        selectedSessionId: frame.selectedSessionId || frame.activeSessionId || state.selectedSessionId,
        selectedProjectId: frame.projectId || state.selectedProjectId,
      };

    case TO_PHONE.PROJECTS_LIST:
      return {
        ...state,
        projects: Array.isArray(frame.projects) ? frame.projects : [],
        selectedProjectId: frame.selectedProjectId || frame.activeProjectId || state.selectedProjectId,
      };

    case TO_PHONE.PROMPTS_UPDATED:
      if (state.session && frame.sessionId && frame.sessionId !== state.session.id) return state;
      return { ...state, prompts: Array.isArray(frame.prompts) ? frame.prompts : [] };

    case TO_PHONE.PROMPT_ACK: {
      const answering = { ...state.answering };
      delete answering[frame.requestId];
      if (frame.ok) return { ...state, answering, prompts: state.prompts.filter((p) => p.requestId !== frame.requestId) };
      const gone = frame.code === "NOT_PENDING";
      return {
        ...state,
        answering,
        // Answered elsewhere (on the desktop) or no longer asked: drop the card.
        prompts: gone ? state.prompts.filter((p) => p.requestId !== frame.requestId) : state.prompts,
        notice: notice("error", gone ? "这个请求已经在电脑上处理过了" : "没能提交，请重试或在电脑上处理"),
      };
    }

    case TO_PHONE.SESSION_SELECT_ACK:
    case TO_PHONE.PROJECT_SELECT_ACK:
      return frame.ok === false ? { ...state, notice: notice("error", "切换失败，请在电脑上确认该会话还在") } : state;

    case TO_PHONE.INTERRUPT_ACK:
      return frame.ok ? state : { ...state, notice: notice("error", "没能停止，请在电脑上操作") };

    default:
      return state;
  }
}

/**
 * @param {object} state
 * @param {object} action
 *   { type: "frame", frame }                    a frame from the relay
 *   { type: "sent", commandId, text, files }    this phone sent a task
 *   { type: "switching" , sessionId?, projectId? }  the phone picked another target
 *   { type: "disconnected" }                    the relay connection dropped
 */
export function reduce(state, action) {
  switch (action?.type) {
    case "frame":
      return action.frame && typeof action.frame.type === "string" ? onFrame(state, action.frame) : state;
    case "sent":
      return { ...state, pending: [...state.pending, { commandId: action.commandId, text: action.text || "", files: action.files || 0, state: "sending" }] };
    case "switching":
      return {
        ...state,
        session: null,
        history: [],
        live: null,
        pending: [],
        prompts: [],
        answering: {},
        ...(action.projectId ? { selectedProjectId: action.projectId, sessions: [], selectedSessionId: "" } : {}),
        ...(action.sessionId ? { selectedSessionId: action.sessionId } : {}),
      };
    case "answering":
      return { ...state, answering: { ...state.answering, [action.requestId]: true } };
    case "disconnected":
      return { ...state, desktopOnline: null };
    default:
      return state;
  }
}

/** The messages to render, in order: history, the running turn, then what is waiting. */
export function messages(state) {
  const { history, live, pending } = state;
  const out = [];
  for (const m of history) {
    if (live && m.role === "assistant" && m.turnId === live.turnId) continue; // shown live below
    out.push({ key: m.id || `${m.role}:${m.turnId}:${out.length}`, role: m.role, text: m.text, files: m.files || 0, status: m.status || "", artifacts: Array.isArray(m.artifacts) ? m.artifacts : [] });
  }
  if (live) {
    const asked = live.userText && !history.some((m) => m.role === "user" && (m.turnId === live.turnId));
    if (asked) out.push({ key: `live-user:${live.turnId}`, role: "user", text: live.userText, files: 0, status: "" });
    out.push({ key: `live:${live.turnId}`, role: "assistant", text: live.text, status: live.status, tool: live.tool, steps: live.steps || 0, todos: live.todos || [], live: true });
  }
  for (const p of pending) out.push({ key: `pending:${p.commandId}`, role: "user", text: p.text, files: p.files, status: p.state, pending: true });
  return out;
}

export function isBusy(state) {
  return Boolean(state.live && state.live.status === "running") || state.pending.length > 0;
}
