#!/usr/bin/env node
/**
 * Minimal mock of an OpenAI-compatible chat endpoint (like DeepSeek's), so we can
 * prove end-to-end that OpenCode, configured by our OPENCODE_CONFIG_CONTENT,
 * actually routes to our baseURL with our bearer token and streams a reply —
 * without any real provider credentials.
 *
 * Logs each request (path, Authorization, model) and returns a streamed
 * OpenAI-style completion so the OpenCode turn can complete.
 */
import http from "node:http";

const reply = (process.argv[2] || "hi from mock").trim();

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed = {};
    try { parsed = JSON.parse(body || "{}"); } catch { /* ignore */ }
    console.error(`[mock] ${req.method} ${req.url} auth=${req.headers.authorization || "(none)"} model=${parsed.model || "?"} stream=${!!parsed.stream}`);

    if (!req.url.includes("chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    const id = "chatcmpl-mock";
    const model = parsed.model || "mock";
    if (parsed.stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      // role chunk, then content chunks, then finish.
      send({ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
      for (const piece of reply.match(/.{1,4}/g) || [reply]) {
        send({ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
      }
      send({ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } });
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id, object: "chat.completion", model,
        choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
      }));
    }
  });
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  console.log(`MOCK_PORT=${port}`);
});
