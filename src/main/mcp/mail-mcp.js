"use strict";

/**
 * Mail connector as a Model Context Protocol server.
 *
 * This is the connector "on MCP rails": instead of a private HTTP side-channel,
 * the engine sees mail as native MCP tools (discovery + JSON schemas), and the
 * engine's tool-permission flow (approval-broker) governs calls — `send_mail` is
 * annotated destructive, so it goes through the same human-in-the-loop
 * confirmation as any other tool.
 *
 * The data access is injected as `run(action, payload)` so the same tool
 * definitions work in two deployments:
 *   - in-process (Electron main): run dispatches via mail-actions (safeStorage).
 *   - stdio proxy (mail-mcp-stdio): run forwards to the connector bridge over HTTP.
 */

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { z } = require("zod");

function asText(value) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] };
}

/**
 * @param {(action: "accounts"|"search"|"read"|"send", payload: object) => Promise<any>} run
 * @returns {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer}
 */
function createMailMcpServer(run) {
  const server = new McpServer({ name: "lily-mail", version: "1.0.0" });

  server.registerTool(
    "list_mail_accounts",
    {
      description: "List the user's connected mail accounts. Returns id, email, provider and status. Call this first to get an accountId.",
      inputSchema: {},
    },
    async () => asText(await run("accounts", {})),
  );

  server.registerTool(
    "search_mail",
    {
      description: "Search a connected mailbox and return recent message envelopes (uid, subject, from, date). Use the uid with read_mail.",
      inputSchema: {
        accountId: z.string().describe("account id from list_mail_accounts"),
        subject: z.string().optional().describe("filter: subject contains"),
        from: z.string().optional().describe("filter: sender contains"),
        unread: z.boolean().optional().describe("only unread messages"),
        limit: z.number().int().min(1).max(50).optional().describe("max results (default 10)"),
        mailbox: z.string().optional().describe("mailbox/folder, default INBOX"),
      },
    },
    async ({ accountId, subject, from, unread, limit, mailbox }) =>
      asText(await run("search", { accountId, query: { subject, from, unread, limit, mailbox } })),
  );

  server.registerTool(
    "read_mail",
    {
      description: "Read a single message by uid from a connected mailbox. Returns subject, from, to, date, text/HTML body and attachment list.",
      inputSchema: {
        accountId: z.string().describe("account id from list_mail_accounts"),
        uid: z.number().int().describe("message uid from search_mail"),
        mailbox: z.string().optional().describe("mailbox/folder, default INBOX"),
      },
    },
    async ({ accountId, uid, mailbox }) =>
      asText(await run("read", { accountId, query: { uid, mailbox } })),
  );

  server.registerTool(
    "send_mail",
    {
      description: "Send an email from a connected account. This performs a real send — the user will be asked to confirm.",
      inputSchema: {
        accountId: z.string().describe("account id from list_mail_accounts"),
        to: z.string().describe("recipient(s), comma-separated"),
        cc: z.string().optional().describe("cc recipient(s), comma-separated"),
        bcc: z.string().optional().describe("bcc recipient(s), comma-separated"),
        subject: z.string(),
        text: z.string().describe("plain-text body"),
        html: z.string().optional().describe("optional HTML body (text is kept as the plain-text fallback)"),
        attachments: z
          .array(
            z.object({
              path: z.string().describe("absolute local file path to attach"),
              filename: z.string().optional().describe("display name; defaults to the file's basename"),
            }),
          )
          .optional()
          .describe("files to attach, given by local path (read from disk at send time)"),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ accountId, to, cc, bcc, subject, text, html, attachments }) =>
      asText(await run("send", {
        accountId,
        confirmed: true,
        message: { to, cc, bcc, subject, text, html, attachments },
      })),
  );

  return server;
}

/** In-process run: dispatch via mail-actions (Electron main, secrets available). */
function inProcessRun(mailStore) {
  const { runMailAction } = require("../mail-actions");
  return async (action, payload) => {
    if (action === "accounts") return { ok: true, accounts: mailStore.listAccountsPublic() };
    return runMailAction(mailStore, action, payload);
  };
}

module.exports = { createMailMcpServer, inProcessRun };
