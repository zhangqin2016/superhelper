"use strict";

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { z } = require("zod");
const {
  extractPath,
  inspectPath,
  samplePath,
} = require("./file-intelligence-core");
const {
  indexPath,
  queryIndex,
} = require("./file-intelligence-index");

function asTextJson(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function createFileIntelligenceMcpServer() {
  const server = new McpServer({ name: "lily-file-intelligence", version: "1.0.0" });

  server.registerTool(
    "inspect_file",
    {
      description: "Inspect a local file or directory before reading large inputs. Returns compact metadata and recommended next actions without returning full content.",
      inputSchema: {
        path: z.string().describe("Absolute or workspace-relative local file/directory path"),
      },
    },
    async (args) => asTextJson(inspectPath(args || {})),
  );

  server.registerTool(
    "sample_file",
    {
      description: "Sample a local text-like file or directory manifest. Results are explicitly marked as sampled, not full-file coverage.",
      inputSchema: {
        path: z.string().describe("Absolute or workspace-relative local file/directory path"),
        strategy: z.enum(["head", "middle", "tail"]).optional().describe("Sampling strategy for line-oriented files"),
        lines: z.number().int().min(1).max(500).optional().describe("Number of lines to return"),
      },
    },
    async (args) => asTextJson(samplePath(args || {})),
  );

  server.registerTool(
    "extract_file_range",
    {
      description: "Extract an explicit range from a local text-like file. Large files require a range and never silently become full-context reads.",
      inputSchema: {
        path: z.string().describe("Absolute or workspace-relative local file path"),
        range: z.object({
          type: z.enum(["lines"]).describe("Range type"),
          start: z.number().int().min(1).describe("1-based start line"),
          end: z.number().int().min(1).describe("1-based end line"),
        }).optional(),
      },
    },
    async (args) => asTextJson(extractPath(args || {})),
  );

  server.registerTool(
    "index_path",
    {
      description: "Build a reusable local evidence index for a text-like file or bounded directory. Returns an index id; it does not answer the user's question by itself.",
      inputSchema: {
        path: z.string().describe("Absolute or workspace-relative local file/directory path"),
        chunkLineCount: z.number().int().min(1).max(500).optional().describe("Lines per chunk for text-like files"),
        maxFiles: z.number().int().min(1).max(1000).optional().describe("Maximum files to consider in a directory"),
      },
    },
    async (args) => asTextJson(indexPath(args || {})),
  );

  server.registerTool(
    "query_index",
    {
      description: "Query a local file intelligence index and return compact evidence chunks with source ranges. This retrieves evidence; it does not invent answers.",
      inputSchema: {
        indexId: z.string().describe("Index id returned by index_path"),
        query: z.string().describe("Natural-language or keyword query"),
        limit: z.number().int().min(1).max(50).optional().describe("Maximum evidence chunks to return"),
      },
    },
    async (args) => asTextJson(queryIndex(args || {})),
  );

  return server;
}

module.exports = {
  asTextJson,
  createFileIntelligenceMcpServer,
};
