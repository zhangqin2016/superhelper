"use client";

// The phone page's one piece of state wiring: the relay client (connection)
// feeds the conversation reducer (content); the page renders both and calls
// the actions. Neither module knows about the other or about React.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { initialConversation, isBusy, messages, reduce } from "../../lib/mobile/conversation.mjs";
import { toDesktop } from "../../lib/mobile/protocol.mjs";
import { createRelayClient, parseScanHash } from "../../lib/mobile/relay-client.mjs";

function ensureDeviceId() {
  try {
    let id = localStorage.getItem("lily_m_device_id");
    if (!id) {
      id = `mweb_${(crypto.randomUUID?.() || String(Math.random()).slice(2)).replace(/-/g, "")}`;
      localStorage.setItem("lily_m_device_id", id);
    }
    return id;
  } catch {
    return `mweb_${Date.now()}`;
  }
}

export function useMobileCommand() {
  const [conversation, dispatch] = useReducer(reduce, undefined, initialConversation);
  const [status, setStatus] = useState({ phase: "idle", message: "" });
  const [scanned, setScanned] = useState(null); // { url, token } from a QR deep link
  const [deviceId, setDeviceId] = useState("");
  const clientRef = useRef(null);

  useEffect(() => {
    const id = ensureDeviceId();
    setDeviceId(id);
    const origin = window.location.origin;
    const client = createRelayClient({
      deviceId: id,
      pageOrigin: origin,
      onFrame: (frame) => dispatch({ type: "frame", frame }),
      onStatus: (next) => {
        setStatus(next);
        if (next.phase === "online") {
          // What this phone drives, and the conversation as the desktop shows it.
          client.send(toDesktop.projectsRequest());
          client.send(toDesktop.sessionsRequest());
          client.send(toDesktop.sessionRequest());
        } else {
          dispatch({ type: "disconnected" });
        }
      },
    });
    clientRef.current = client;
    const scan = parseScanHash(window.location.hash, origin);
    if (scan) {
      setScanned(scan);
      // The one-time token is spent by pairing; take it out of the address bar.
      try { window.history.replaceState(null, "", window.location.pathname); } catch { /* noop */ }
      void client.pair(`${scan.url}#${scan.token}`);
    } else {
      client.resume();
    }
    const onVisible = () => { if (document.visibilityState === "visible") client.reconnectNow(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      client.stop();
    };
  }, []);

  const send = useCallback(({ text, attachment }) => {
    const client = clientRef.current;
    const frame = toDesktop.command({
      text: String(text || "").trim(),
      attachments: attachment ? [{ name: attachment.name, mimeType: attachment.mimeType, dataBase64: attachment.dataBase64 }] : [],
      mobileDeviceId: deviceId,
      lilySessionId: conversation.selectedSessionId,
    });
    if (!client?.send(frame)) return false;
    dispatch({ type: "sent", commandId: frame.commandId, text: frame.text || "（图片）", files: attachment ? 1 : 0 });
    return true;
  }, [deviceId, conversation.selectedSessionId]);

  const actions = useMemo(() => ({
    pair: (code) => clientRef.current?.pair(code),
    directConnect: (code, password) => clientRef.current?.directConnect(code, password),
    send,
    stop: () => clientRef.current?.send(toDesktop.interrupt()),
    selectSession: (sessionId) => {
      dispatch({ type: "switching", sessionId });
      clientRef.current?.send(toDesktop.selectSession(sessionId));
    },
    selectProject: (projectId) => {
      dispatch({ type: "switching", projectId });
      clientRef.current?.send(toDesktop.selectProject(projectId));
    },
    /** A new conversation in the workspace this phone drives. */
    newSession: () => {
      if (!clientRef.current?.send(toDesktop.createSession())) return false;
      dispatch({ type: "switching" });
      return true;
    },
    /** Answer a desktop prompt; false when the phone is not connected. */
    respondPrompt: (answer) => {
      if (!clientRef.current?.send(toDesktop.respondPrompt(answer))) return false;
      dispatch({ type: "answering", requestId: answer.requestId });
      return true;
    },
  }), [send]);

  return {
    status,
    conversation,
    messages: messages(conversation),
    busy: isBusy(conversation),
    scanned,
    client: clientRef.current,
    actions,
  };
}
