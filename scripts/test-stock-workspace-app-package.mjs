#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { assert } from "./lib/test-assert.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-stock-app-"));

try {
  execFileSync(
    process.execPath,
    [
      path.join(root, "scripts/build-stock-workspace-app.mjs"),
      "--out",
      tmpDir,
      "--version",
      "test-platform-env",
      "--exported-at",
      "2026-06-16T00:00:00.000Z",
    ],
    { cwd: root, stdio: "pipe" },
  );

  const artifact = path.join(tmpDir, "daily-stock-analysis-test-platform-env.lilyspace.zip");
  assert(fs.existsSync(artifact), "stock app package is built");

  const zip = await JSZip.loadAsync(fs.readFileSync(artifact));
  const rawManifest = JSON.parse(await zip.file("lily-workspace.json").async("string"));
  const appManifest = JSON.parse(await zip.file("files/lily-app.json").async("string"));
  const mainPy = await zip.file("files/source/main.py").async("string");
  const appRunner = await zip.file("files/source/lily_app_runner.py").async("string");
  const lilyRun = await zip.file("files/source/lily_run.py").async("string");
  const lilyAdapter = await zip.file("files/source/lily_adapter.py").async("string");
  const dataflowInterface = await zip.file("files/source/tradingagents/dataflows/interface.py").async("string");
  const lilySearch = await zip.file("files/source/tradingagents/dataflows/lily_search.py").async("string");
  const agentsMd = await zip.file("files/AGENTS.md").async("string");
  const readme = await zip.file("files/README.md").async("string");
  const platformGuide = await zip.file("files/source/LILY_PLATFORM.md").async("string");

  assert(rawManifest.appId === "daily-stock-analysis", "raw manifest has stable app id");
  assert(rawManifest.folderName === "daily-stock-analysis", "raw manifest has stable English folder name");
  assert(rawManifest.appRuntime?.defaultEntrypoint === "analyze_stock", "workspace manifest exposes default app entrypoint");
  assert(rawManifest.appRuntime?.resultPath === "source/reports/lily-result.json", "workspace manifest exposes result path");
  assert(appManifest.appId === "daily-stock-analysis", "app manifest has stable app id");
  assert(appManifest.type === "workspace_app", "app manifest marks workspace app type");
  assert(appManifest.dataPolicy?.userSuppliedKeysRequired === false, "app manifest does not require user-supplied keys");
  assert(appManifest.entrypoints?.analyze_stock?.args?.includes("source/lily_app_runner.py"), "app manifest routes through Lily app runner");
  assert(appManifest.entrypoints?.analyze_stock?.stageEventType === "lily.app.stage", "app manifest declares stage event protocol");
  assert(appManifest.resultProtocol?.resultPath === "source/reports/lily-result.json", "app manifest declares result protocol");
  assert(mainPy.includes("from lily_run import main"), "packaged main.py delegates to Lily runner");
  assert(!mainPy.includes("TradingAgentsGraph"), "packaged main.py does not run upstream OpenAI-default demo");
  assert(appRunner.includes('"type": "lily.app.stage"'), "app runner emits stage events");
  assert(appRunner.includes('RESULT_PATH = REPORTS_DIR / "lily-result.json"'), "app runner writes machine-readable result");
  assert(appRunner.includes('env["PYTHONPATH"] = str(ROOT)'), "app runner makes local adapter imports explicit");
  assert(appRunner.includes('os.environ.get("LILY_RUNTIME_ROOT"'), "app runner can discover the bundled Lily runtime root");
  assert(appRunner.includes("def resolve_uv()"), "app runner resolves uv beyond ambient PATH");
  assert(appRunner.includes('"--python", str(venv_python)'), "app runner installs into the intended workspace venv");
  assert(appRunner.includes("REPORT_NOT_GENERATED"), "app runner validates report artifacts");
  assert(appRunner.includes("TIMEOUT"), "app runner handles engine timeout");
  assert(lilySearch.includes("WEBSEARCH_IQS_API_KEY"), "package includes Lily platform search vendor");
  assert(lilySearch.includes("get_news_lily_search"), "Lily search vendor implements ticker news");
  assert(dataflowInterface.includes('"lily_search": get_news_lily_search'), "TradingAgents news router includes Lily search vendor");
  assert(dataflowInterface.includes('"lily_search": get_global_news_lily_search'), "TradingAgents global news router includes Lily search vendor");
  assert(lilyAdapter.includes('TRADINGAGENTS_LILY_NEWS_VENDOR", "lily_search,yfinance"'), "adapter defaults news to Lily platform search first");
  assert(lilyAdapter.includes('"search_key_set"'), "adapter reports whether platform search key is injected");
  assert(lilyRun.includes("apply_lily_data_config"), "runner applies Lily data vendor config");
  assert(lilyRun.includes('"get_news": config.get("tool_vendors", {}).get("get_news")'), "runner prints active news vendor");
  assert(agentsMd.includes("Do not ask ordinary users to configure upstream OpenAI/Anthropic/search keys"), "AGENTS forbids upstream key setup");
  assert(!agentsMd.includes("ask only for stock/data-provider keys"), "AGENTS no longer suggests key setup as normal flow");
  assert(agentsMd.includes("source/lily_app_runner.py"), "AGENTS documents preferred Lily app runner");
  assert(readme.includes("python lily_app_runner.py --stocks"), "README documents preferred Lily app runner");
  assert(platformGuide.includes("source/main.py` is packaged as a Lily compatibility wrapper"), "platform guide documents wrapper");
  assert(platformGuide.includes("source/lily_app_runner.py"), "platform guide documents app runner");
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log("PASS: test-stock-workspace-app-package");
