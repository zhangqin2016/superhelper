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
const {
  listArchive,
  readArchiveEntry,
} = require("./archive-intelligence");

function asTextJson(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

/** Rebuild the nested range extractPath expects from the flat wire fields.
 *  A legacy nested `range` argument (older callers) still passes through. */
function normalizeExtractRangeArgs(args) {
  const { rangeStart, rangeEnd, ...rest } = args;
  if (rest.range || !(Number(rangeStart) >= 1) || !(Number(rangeEnd) >= 1)) return rest;
  return {
    ...rest,
    range: { type: "lines", start: Math.floor(Number(rangeStart)), end: Math.floor(Number(rangeEnd)) },
  };
}

function createFileIntelligenceMcpServer() {
  const server = new McpServer({ name: "lily-file-intelligence", version: "1.0.0" });

  server.registerTool(
    "inspect_file",
    {
      description: "Inspect a local file or directory before reading large inputs. Returns compact metadata and recommended next actions without returning full content. Example call: {\"path\":\"/data/report.pdf\"}",
      inputSchema: {
        path: z.string().describe("Absolute or workspace-relative local file/directory path"),
      },
    },
    async (args) => asTextJson(inspectPath(args || {})),
  );

  server.registerTool(
    "sample_file",
    {
      description: "Sample a local text-like file or directory manifest. Results are explicitly marked as sampled, not full-file coverage. Example call: {\"path\":\"/data/big.log\",\"strategy\":\"tail\",\"lines\":100}",
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
      description: "Extract an explicit line range from a local text-like file. Large files require a range and never silently become full-context reads. Example call: {\"path\":\"/data/big.log\",\"rangeStart\":1200,\"rangeEnd\":1300}",
      // Flat wire shape: some gateways reject any tool schema with a nested
      // object parameter, so the range travels as two flat integers.
      inputSchema: {
        path: z.string().describe("Absolute or workspace-relative local file path"),
        rangeStart: z.number().int().min(1).optional().describe("1-based start line of the extract range"),
        rangeEnd: z.number().int().min(1).optional().describe("1-based end line of the extract range"),
      },
    },
    async (args) => asTextJson(extractPath(normalizeExtractRangeArgs(args || {}))),
  );

  server.registerTool(
    "list_archive",
    {
      description: "List a bounded local archive manifest without extracting files. Reports encryption, unsafe paths, expansion risk, and sampled/full coverage. Example call: {\"path\":\"/data/customer.zip\",\"maxEntries\":200}",
      inputSchema: {
        path: z.string().describe("Absolute or workspace-relative local archive path"),
        maxEntries: z.number().int().min(1).max(5000).optional().describe("Maximum archive entries returned"),
      },
    },
    async (args) => asTextJson(listArchive(args || {})),
  );

  server.registerTool(
    "read_archive_entry",
    {
      description: "Read one exact safe text entry from a local archive without extracting it to disk. Encrypted, unsafe, binary, or oversized entries are refused. Example call: {\"path\":\"/data/customer.zip\",\"entryPath\":\"docs/readme.txt\"}",
      inputSchema: {
        path: z.string().describe("Absolute or workspace-relative local archive path"),
        entryPath: z.string().describe("Exact entry path returned by list_archive"),
        maxEntryBytes: z.number().int().min(1).max(16 * 1024 * 1024).optional().describe("Maximum uncompressed bytes returned"),
      },
    },
    async (args) => asTextJson(readArchiveEntry(args || {})),
  );

  server.registerTool(
    "index_path",
    {
      description: "Build a reusable local evidence index for a text-like file, metadata-indexable document/media file, or bounded directory. Returns an index id; it does not answer the user's question by itself. Example call: {\"path\":\"/data/contracts\"}",
      inputSchema: {
        path: z.string().describe("Absolute or workspace-relative local file/directory path"),
        workspacePath: z.string().optional().describe("Current workspace root for workspace-scoped index partitioning"),
        chunkLineCount: z.number().int().min(1).max(500).optional().describe("Lines per chunk for text-like files"),
        maxFiles: z.number().int().min(1).max(1000).optional().describe("Maximum files to consider in a directory"),
        maxArchives: z.number().int().min(1).max(100).optional().describe("Maximum archives to inspect during one directory index build"),
      },
    },
    async (args) => asTextJson(indexPath(args || {})),
  );

  server.registerTool(
    "query_index",
    {
      description: "Query a local file intelligence index and return compact evidence chunks with source ranges. This retrieves evidence; it does not invent answers. Example call: {\"indexId\":\"idx_abc123\",\"query\":\"termination clause\",\"limit\":5}",
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
