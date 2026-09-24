"use client";

// The phone page's one piece of state wiring: the relay client (connection)
// feeds the conversation reducer (content); the page renders both and calls
// the actions. Neither module knows about the other or about React.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { initialConversation, isBusy, messages, reduce } from "../../lib/mobile/conversation.mjs";
import { toDesktop } from "../../lib/mobile/protocol.mjs";
import { createRelayClient, parseScanHash } from "../../lib/mobile/relay-client.mjs";
import { createFileReceiver } from "../../lib/mobile/file-receive.mjs";

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

// Hand a received file to the phone: an image or PDF opens in a new tab (where
// the browser shows it, and offers to save), anything else downloads.
function saveFile({ name, mimeType, bytes }) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType || "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  if (/^image\/|^application\/pdf$/.test(mimeType || "")) a.target = "_blank";
  else a.download = name || "file";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function useMobileCommand() {
  const [conversation, dispatch] = useReducer(reduce, undefined, initialConversation);
  const [status, setStatus] = useState({ phase: "idle", message: "" });
  // Files being fetched from the desktop: artifactId → { progress, error }.
  const [downloads, setDownloads] = useState({});
  const receiverRef = useRef(createFileReceiver());
  const requestsRef = useRef(new Map()); // requestId → artifactId
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
      onFrame: (frame) => {
        if (typeof frame?.type === "string" && frame.type.startsWith("file.")) { void onFileFrame(frame); return; }
        dispatch({ type: "frame", frame });
      },
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

  async function onFileFrame(frame) {
    const result = await receiverRef.current.onFrame(frame);
    const artifactId = requestsRef.current.get(frame.requestId);
    if (!result || !artifactId) return;
    if (result.error) {
      requestsRef.current.delete(frame.requestId);
      setDownloads((d) => ({ ...d, [artifactId]: { error: result.error } }));
      return;
    }
    setDownloads((d) => ({ ...d, [artifactId]: { progress: result.progress || 0 } }));
    if (result.done) {
      requestsRef.current.delete(frame.requestId);
      saveFile(result.done);
      setDownloads((d) => ({ ...d, [artifactId]: { progress: 1, done: true } }));
    }
  }

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
    /** Fetch a file the task produced; false when the phone is not connected. */
    requestFile: (artifactId) => {
      const frame = toDesktop.requestFile(artifactId);
      if (!clientRef.current?.send(frame)) return false;
      requestsRef.current.set(frame.requestId, artifactId);
      setDownloads((d) => ({ ...d, [artifactId]: { progress: 0 } }));
      return true;
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
    downloads,
    scanned,
    client: clientRef.current,
    actions,
  };
}
