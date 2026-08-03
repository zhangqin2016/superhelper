#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertEqual, finish } from "./lib/test-assert.mjs";
import {
  WORKSPACE_APP_BUILDERS,
  appUploadFields,
  extendedDescription,
  localSkillDirs,
  registryMetadataUploadFields,
  resolveWorkspaceAppVersion,
  skillArtifactObjectKey,
  skillUploadFields,
  skillManifestVersion,
  withCacheBuster,
  workspaceAppBuildArgs,
  workspaceAppArtifactPath,
} from "./publish-local-catalog-server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillNames = localSkillDirs().map((item) => path.basename(item));

assert(skillNames.includes("lily-mail-assistant"), "local catalog should include mail assistant skill");
assert(skillNames.includes("lily-web-system-learning"), "local catalog should include web system learning skill");
assert(skillNames.includes("anthropics-docx"), "local catalog should publish curated Word skill overrides");
assert(skillNames.includes("anthropics-pdf"), "local catalog should publish curated PDF skill overrides");
assert(skillNames.includes("anthropics-pptx"), "local catalog should publish curated PPT skill overrides");
assert(skillNames.includes("anthropics-xlsx"), "local catalog should publish curated spreadsheet skill overrides");
assert(
  skillNames.every((item) => item.startsWith("lily-") || ["anthropics-docx", "anthropics-pdf", "anthropics-pptx", "anthropics-xlsx"].includes(item)),
  "local catalog publisher must only select product-maintained skills and curated Office overrides",
);

const mailFields = skillUploadFields({
  pack: {
    skillId: "lily-mail-assistant",
    name: "Mail Assistant",
    version: "1.0.0",
  },
  skillDir: path.join(ROOT, "resources", "skills-catalog", "lily-mail-assistant"),
  channel: "stable",
});
assertEqual(mailFields.channel, "stable", "skill channel");
assertEqual(mailFields.riskLevel, "high", "mail skill risk");
assertEqual(mailFields.defaultEligible, "false", "high-risk skill should not be default eligible");
assertEqual(mailFields.featured, "false", "high-risk skill should not be featured by automatic publish");
assert(mailFields.description.length >= 80, "skill description should satisfy server quality gate");
assertEqual(
  JSON.parse(mailFields.nameI18n).en,
  "Mail Assistant",
  "skill publisher should send localized names to the server",
);
assert(
  JSON.parse(mailFields.descriptionI18n).en.includes("email"),
  "skill publisher should send localized descriptions to the server",
);
assertEqual(
  JSON.parse(mailFields.categoryLabelI18n).en,
  "Automation",
  "skill publisher should send localized category labels to the server",
);
assertEqual(mailFields.displayInCatalog, "true", "regular skills should stay visible in the catalog");
assertEqual(
  skillArtifactObjectKey({
    skillId: "anthropics-pptx",
    version: "1.0.1",
    sha256: "a".repeat(64),
    filePath: "/tmp/anthropics-pptx-1.0.1.skillpack.zip",
  }),
  "skill-packages/anthropics-pptx/1.0.1/aaaaaaaaaaaaaaaa-anthropics-pptx-1.0.1.skillpack.zip",
  "direct skill uploads should use immutable content-addressed object keys",
);

const engineeringFields = skillUploadFields({
  pack: {
    skillId: "lily-engineering-rules",
    name: "Engineering Rules",
    version: "1.0.0",
  },
  skillDir: path.join(ROOT, "resources", "skills-catalog", "lily-engineering-rules"),
  channel: "stable",
});
assertEqual(engineeringFields.displayInCatalog, "false", "platform rule bundles should sync but stay hidden from the user-facing catalog");

const webApp = WORKSPACE_APP_BUILDERS.find((item) => item.appId === "web-system-learning");
assert(webApp, "workspace app builders should include web system learning");
const stockApp = WORKSPACE_APP_BUILDERS.find((item) => item.appId === "daily-stock-analysis");
assertEqual(stockApp?.version, "1.0.6", "stock workspace app should publish the runtime-repair package version");
const webAppFields = appUploadFields({
  app: webApp,
  artifact: {
    appId: "web-system-learning",
    version: "9.9.9",
  },
  channel: "stable",
});
assertEqual(webAppFields.version, "9.9.9", "app version");
assertEqual(webAppFields.riskLevel, "high", "web learning app risk");
assertEqual(webAppFields.featured, "false", "high-risk app should not be featured by automatic publish");
assert(
  webAppFields.requiredSkillPackages.includes("lily-web-system-learning"),
  "web learning app should declare its required skill package",
);
assert(
  workspaceAppBuildArgs(webApp, { version: "0.1.57" }).includes(skillManifestVersion("lily-web-system-learning")),
  "workspace app publisher should version web learning from its required skill package",
);
assertEqual(
  resolveWorkspaceAppVersion(webApp, { version: "0.1.57" }),
  skillManifestVersion("lily-web-system-learning"),
  "web learning app should not drift behind its local skill manifest version",
);

assertEqual(
  workspaceAppArtifactPath({ artifactPath: "/tmp/app.lilyspace.zip" }),
  "/tmp/app.lilyspace.zip",
  "workspace app publisher should accept artifactPath returned by stock app builder",
);
assertEqual(
  workspaceAppArtifactPath({ path: "/tmp/app.zip" }),
  "/tmp/app.zip",
  "workspace app publisher should accept path returned by mail/web app builders",
);

const bustedUrl = withCacheBuster("https://cdn.example.com/workspace-app.zip?existing=1", {
  lily_sha: "abc123",
  lily_attempt: 2,
});
assertEqual(
  bustedUrl,
  "https://cdn.example.com/workspace-app.zip?existing=1&lily_sha=abc123&lily_attempt=2",
  "large workspace app publisher should preserve existing query params while adding cache-busting verification params",
);

const shortDescription = extendedDescription({}, { description: "short" });
assert(shortDescription.length >= 80, "short manifest descriptions should be expanded for publish");

const metadataFields = registryMetadataUploadFields({
  entry: {
    id: "anthropics-xlsx",
    name: "Excel 表格",
    description: "创建、读取、编辑或修复 Excel/CSV/TSV 表格。",
    latestVersion: "1.0.0",
    category: "office",
    categoryLabel: "办公文档",
    capabilityLayer: "tool",
    publisher: "Lily Workbench",
    sourceKind: "lily",
    sourceRepo: "anthropics/skills",
    minAppVersion: "0.1.0",
    riskLevel: "low",
    defaultEligible: true,
    featured: true,
    name_i18n: { en: "Spreadsheets", ar: "جداول البيانات" },
    description_i18n: { en: "Creates and edits spreadsheets.", ar: "ينشئ ويحرر جداول البيانات." },
    categoryLabel_i18n: { en: "Office Documents", ar: "مستندات المكتب" },
  },
  existing: {
    version: "1.0.0",
    artifact_url: "https://cdn.example.com/anthropics-xlsx.skillpack.zip",
    sha256: "a".repeat(64),
    size_bytes: 1234,
    enabled: true,
  },
  channel: "stable",
});
assertEqual(metadataFields.artifactUrl, "https://cdn.example.com/anthropics-xlsx.skillpack.zip", "metadata sync should preserve artifact URL");
assertEqual(metadataFields.sha256, "a".repeat(64), "metadata sync should preserve artifact checksum");
assertEqual(metadataFields.sizeBytes, 1234, "metadata sync should preserve artifact size");
assertEqual(JSON.parse(metadataFields.nameI18n).en, "Spreadsheets", "metadata sync should include localized names");
assertEqual(JSON.parse(metadataFields.categoryLabelI18n).en, "Office Documents", "metadata sync should include localized category label");
assertEqual(metadataFields.displayInCatalog, "true", "metadata sync should keep registry entries catalog-visible by default");

finish("publish-local-catalog-server", 30);
