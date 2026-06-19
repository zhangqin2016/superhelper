#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertEqual, finish } from "./lib/test-assert.mjs";
import {
  WORKSPACE_APP_BUILDERS,
  appUploadFields,
  extendedDescription,
  localSkillDirs,
  skillUploadFields,
  workspaceAppArtifactPath,
} from "./publish-local-catalog-server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillNames = localSkillDirs().map((item) => path.basename(item));

assert(skillNames.includes("lily-mail-assistant"), "local catalog should include mail assistant skill");
assert(skillNames.includes("lily-web-system-learning"), "local catalog should include web system learning skill");
assert(
  skillNames.every((item) => item.startsWith("lily-")),
  "local catalog publisher must only select product-maintained lily-* skills",
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

const webApp = WORKSPACE_APP_BUILDERS.find((item) => item.appId === "web-system-learning");
assert(webApp, "workspace app builders should include web system learning");
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

const shortDescription = extendedDescription({}, { description: "short" });
assert(shortDescription.length >= 80, "short manifest descriptions should be expanded for publish");

finish("publish-local-catalog-server", 15);
