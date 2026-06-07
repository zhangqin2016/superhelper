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

const groups = groupSkillsForTree([
  { id: "anthropics-pdf", name: "Pdf", category: "office", sessionEnabled: true },
  { id: "lily-vision", name: "Vision", sessionEnabled: false },
  { id: "superpowers-systematic-debugging", name: "Debug", category: "dev", sessionEnabled: false },
]);

if (groups.length !== 3) {
  throw new Error(`expected 3 groups, got ${groups.length}`);
}
if (groups[0].id !== "office" || groups[0].enabledCount !== 1) {
  throw new Error("office group should be first with one enabled");
}
if (groups[1].id !== "tools") {
  throw new Error("tools group should be second");
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
