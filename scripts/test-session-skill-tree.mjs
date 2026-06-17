#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const {
  groupSkillsForTree,
  resolveSkillTreeCategory,
  shouldExpandTreeGroup,
} = await import(path.join(ROOT, "src/renderer/modules/session-skill-tree.js"));

if (resolveSkillTreeCategory({ id: "lily-vision" }) !== "tools") {
  throw new Error("bundled vision should map to tools");
}
if (resolveSkillTreeCategory({ id: "lily-image-generation" }) !== "tools") {
  throw new Error("bundled media generation should map to tools");
}
if (resolveSkillTreeCategory({ id: "anthropics-docx", category: "office" }) !== "office") {
  throw new Error("registry category should be used");
}
if (resolveSkillTreeCategory({ id: "learned-demo-oa", source: "learned", category: "dev" }) !== "workspace") {
  throw new Error("learned skills should be grouped as workspace skills");
}
if (resolveSkillTreeCategory({ id: "demo-oa", origin: "workspace", category: "dev" }) !== "workspace") {
  throw new Error("workspace-origin skills should be grouped as workspace skills");
}

const groups = groupSkillsForTree([
  { id: "anthropics-pdf", name: "Pdf", category: "office", sessionEnabled: true },
  { id: "learned-demo-oa", name: "Demo OA", source: "learned", category: "dev", sessionEnabled: true },
  { id: "lily-vision", name: "Vision", sessionEnabled: false },
  { id: "superpowers-systematic-debugging", name: "Debug", category: "dev", sessionEnabled: false },
]);

if (groups.length !== 4) {
  throw new Error(`expected 4 groups, got ${groups.length}`);
}
if (groups[0].id !== "workspace" || groups[0].enabledCount !== 1) {
  throw new Error("workspace group should be first with one enabled workspace skill");
}
if (groups[1].id !== "office" || groups[1].enabledCount !== 1) {
  throw new Error("office group should follow workspace with one enabled");
}
if (groups[2].id !== "tools") {
  throw new Error("tools group should follow workspace and office");
}

const collapsed = shouldExpandTreeGroup(
  { id: "dev", enabledCount: 0, skills: [{}, {}, {}] },
  { totalSkills: 20 },
);
if (collapsed) {
  throw new Error("dev group should collapse when many skills and none enabled");
}

const expanded = shouldExpandTreeGroup(
  { id: "dev", enabledCount: 1, skills: [{}] },
  { totalSkills: 20 },
);
if (!expanded) {
  throw new Error("dev group with selection should expand");
}

console.log("session-skill-tree: ok");
