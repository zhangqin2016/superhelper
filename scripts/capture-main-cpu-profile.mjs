import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const [endpoint, output, seconds = "60"] = process.argv.slice(2);
if (!endpoint?.startsWith("ws://127.0.0.1:") || !output) throw new Error("Usage: node capture-main-cpu-profile.mjs <local inspector ws URL> <new output path> [seconds]");
const target = path.resolve(output);
if (fs.existsSync(target)) throw new Error("Output already exists");
const socket = new WebSocket(endpoint);
const pending = new Map();
let sequence = 0;
socket.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
});
const call = method => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method }));
});
await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
try {
  await call("Profiler.enable");
  await call("Profiler.start");
  console.log("Main-process CPU recording started");
  await delay(Math.max(1, Number(seconds)) * 1000);
  const { profile } = await call("Profiler.stop");
  fs.writeFileSync(target, JSON.stringify(profile), { flag: "wx" });
  const nodes = new Map(profile.nodes.map(n => [n.id, n.callFrame]));
  const times = new Map();
  for (let i = 0; i < profile.samples.length; i++) times.set(profile.samples[i], (times.get(profile.samples[i]) || 0) + profile.timeDeltas[i]);
  console.log(JSON.stringify([...times].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([id, us]) => ({ ms: Math.round(us / 1000), ...nodes.get(id) })), null, 2));
  console.log(target);
} finally { socket.close(); }
