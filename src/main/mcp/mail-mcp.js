"use strict";

/**
 * Mail connector as a Model Context Protocol server.
 *
 * This is the connector "on MCP rails": instead of a private HTTP side-channel,
 * the engine sees mail as native MCP tools (discovery + JSON schemas), and the
 * engine's tool-permission flow (approval-broker) governs calls — `send_mail` is
 * a write tool, so it goes through the same human-in-the-loop confirmation as
 * any other tool. Runs in the Electron main process (where account secrets are
 * available via safeStorage) and dispatches through the shared mail-actions.
 */

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { z } = require("zod");
const { runMailAction } = require("../mail-actions");

function asText(value) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] };
}

/**
 * @param {object} mailStore  the mail account store (listAccountsPublic / getAccountWithSecret / saveOAuthToken)
 * @returns {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer}
 */
function createMailMcpServer(mailStore) {
  const server = new McpServer({ name: "lily-mail", version: "1.0.0" });

  server.registerTool(
    "list_mail_accounts",
    {
      description: "List the user's connected mail accounts. Returns id, email, provider and status. Call this first to get an accountId.",
      inputSchema: {},
    },
    async () => asText(mailStore.listAccountsPublic()),
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
      asText(await runMailAction(mailStore, "search", { accountId, query: { subject, from, unread, limit, mailbox } })),
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
      asText(await runMailAction(mailStore, "read", { accountId, query: { uid, mailbox } })),
  );

  server.registerTool(
    "send_mail",
    {
      description: "Send an email from a connected account. This performs a real send — the user will be asked to confirm.",
      inputSchema: {
        accountId: z.string().describe("account id from list_mail_accounts"),
        to: z.string().describe("recipient(s), comma-separated"),
        subject: z.string(),
        text: z.string().describe("plain-text body"),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ accountId, to, subject, text }) =>
      asText(await runMailAction(mailStore, "send", { accountId, confirmed: true, message: { to, subject, text } })),
  );

  return server;
}

module.exports = { createMailMcpServer };
