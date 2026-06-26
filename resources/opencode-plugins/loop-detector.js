// Result-aware doom-loop detection inside the OpenCode (Bun) serve process.
// After each tool runs, track a per-session window of (tool, argsHash, resultHash)
// signatures. If the SAME signature repeats N times (no progress), or two
// signatures ping-pong with no change, the agent is spinning — append a
// corrective [loop] note to the tool output so the model breaks out ITSELF.
// The step budget + turn watchdog remain the hard backstops; this is the gentle
// first nudge (no hard-kill), so a false positive costs at most a harmless hint.
//
// RESULT-AWARE: the result hash is part of the signature, so changing output
// (genuine progress) resets the run — legitimate long work never triggers. This
// directly addresses the "subtask spins for 10 minutes" incident without touching
// healthy tasks. FAIL OPEN: this runs on every tool call and must never throw.
//
// Tunable (0 disables that check): LILY_LOOP_NO_PROGRESS (default 3),
// LILY_LOOP_PING_PONG cycles (default 2). LILY_LOOP_DETECT=0 disables entirely.

const WINDOW = 16; // signatures kept per session
const MAX_SESSIONS = 200; // bound memory in the long-lived serve

function envInt(name, dflt) {
  const raw = process.env[name];
  if (raw == null || raw === "") return dflt;
  const v = Number.parseInt(raw, 10);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

function hash(value) {
  const s = String(value || "");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// Pull a stable text view of a tool result across the shapes the engine passes
// ({output:string}, {content:[{type:"text",text}]}, or a raw value).
function resultText(output) {
  if (output == null) return "";
  if (typeof output === "string") return output;
  if (typeof output.output === "string") return output.output;
  try {
    if (Array.isArray(output.content)) {
      return output.content.map((c) => (c && c.type === "text" ? c.text : "")).join("");
    }
  } catch {
    /* ignore */
  }
  try {
    return JSON.stringify(output);
  } catch {
    return "";
  }
}

// Detect a loop in the ordered signature window. Pure.
//  - no_progress: the last `noProgress` signatures are all identical.
//  - ping_pong: the last 2*cycles entries strictly alternate between two signatures.
function detectLoop(sigs, noProgress, pingPong) {
  const n = sigs.length;
  if (noProgress > 0 && n >= noProgress) {
    const last = sigs[n - 1];
    if (sigs.slice(n - noProgress).every((s) => s === last)) return "no_progress";
  }
  if (pingPong > 0) {
    const span = pingPong * 2;
    if (n >= span) {
      const w = sigs.slice(n - span);
      const a = w[0];
      const b = w[1];
      if (a !== b && w.every((s, i) => s === (i % 2 === 0 ? a : b))) return "ping_pong";
    }
  }
  return "";
}

const sessions = new Map(); // sessionID -> { sigs: string[] }  (insertion order = LRU)

function track(sessionID, sig) {
  let entry = sessions.get(sessionID);
  if (entry) {
    sessions.delete(sessionID); // refresh LRU position
  } else {
    if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    entry = { sigs: [] };
  }
  sessions.set(sessionID, entry);
  entry.sigs.push(sig);
  if (entry.sigs.length > WINDOW) entry.sigs.shift();
  return entry.sigs;
}

function noteFor(kind, count) {
  const what = kind === "ping_pong" ? "两个操作来回切换、结果不变" : `同一操作连续 ${count} 次、结果完全相同`;
  return (
    `[loop] 检测到无进展的重复（${what}）。不要再重复这个调用——` +
    "换一种方法、检查前提假设,或停下来说明你卡在哪里、还需要什么。"
  );
}

export const LoopDetectorPlugin = async () => ({
  "tool.execute.after": async (input, output) => {
    try {
      if (process.env.LILY_LOOP_DETECT === "0") return;
      const noProgress = envInt("LILY_LOOP_NO_PROGRESS", 3);
      const pingPong = envInt("LILY_LOOP_PING_PONG", 2);
      if (noProgress === 0 && pingPong === 0) return;

      const tool = String((input && input.tool) || "");
      if (!tool) return;
      let argsStr = "";
      try {
        argsStr = JSON.stringify((input && input.args) ?? null);
      } catch {
        argsStr = "";
      }
      // Signature computed from the RAW result BEFORE we append any note, so our
      // own note can never pollute the signature on the next iteration.
      const sig = `${tool}|${hash(argsStr)}|${hash(resultText(output))}`;
      const sigs = track(String((input && input.sessionID) || "default"), sig);

      const kind = detectLoop(sigs, noProgress, pingPong);
      if (!kind) return;

      let count = 0;
      for (let i = sigs.length - 1; i >= 0 && sigs[i] === sig; i--) count++;
      const note = noteFor(kind, count);
      if (output && typeof output === "object") {
        if (typeof output.output === "string") output.output = `${output.output}\n\n${note}`;
        else if (Array.isArray(output.content)) output.content.push({ type: "text", text: note });
      }
    } catch {
      /* fail open — detection must never break a turn */
    }
  },
});

export default LoopDetectorPlugin;
