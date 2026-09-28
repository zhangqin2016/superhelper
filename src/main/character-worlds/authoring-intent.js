"use strict";

const CREATE_WORDS = /(创建|新建|设计|生成|定制|做一个|打造|create|design|build|make)/i;
// 智能体 (agent bundle) intents win over role intents: "做一个审合同的智能体，
// 角色是律师" is an agent request whose role is one of its dimensions.
const AGENT_WORDS = /(智能体|数字员工|数字同事|\bagents?\b)/i;
const WORLD_BOOK_WORDS = /(世界书|世界观|设定集|world\s*book|lore\s*book)/i;
const PERSONA_WORDS = /(人设|用户画像|persona)/i;
const CHARACTER_WORDS = /(角色卡|角色|人物|character)/i;
const DOCUMENT_WORDS = /(报告|文档|文章|方案|说明|教程|\.md\b|\.docx?\b|\.pdf\b)/i;
const NON_LIBRARY_CHARACTER_CONTEXT = /(角色管理|角色权限|角色扮演游戏|游戏角色系统|character\s+(management|permission|system|feature)|role[- ]?playing\s+game)/i;
// "agent" as an engineering term (the coding agent, agent framework…) is not
// a library creation request.
const NON_LIBRARY_AGENT_CONTEXT = /(智能体管理|智能体系统|智能体平台|agent\s+(framework|sdk|system|platform|management|loop)|user[- ]agent|multi[- ]agent)/i;

function inferCharacterAuthoringIntent(text) {
  const input = String(text || "").trim();
  if (!input || !CREATE_WORDS.test(input)) return { active: false, kind: null };
  if (DOCUMENT_WORDS.test(input) && !WORLD_BOOK_WORDS.test(input)) {
    return { active: false, kind: null };
  }
  if (AGENT_WORDS.test(input) && !NON_LIBRARY_AGENT_CONTEXT.test(input)) {
    return { active: true, kind: "agent" };
  }
  if (NON_LIBRARY_CHARACTER_CONTEXT.test(input)) return { active: false, kind: null };
  if (WORLD_BOOK_WORDS.test(input)) return { active: true, kind: "worldBook" };
  if (PERSONA_WORDS.test(input)) return { active: true, kind: "persona" };
  if (CHARACTER_WORDS.test(input)) return { active: true, kind: "character" };
  return { active: false, kind: null };
}

// `conditional`: the host only GUESSED a library request from wording, so the
// workflow applies if the user wants the entity saved, and the model decides.
function buildAgentAuthoringEngineText(text, { conditional = false } = {}) {
  return [
    "[LILY AGENT AUTHORING WORKFLOW]",
    conditional
      ? "The user may want a 智能体 (agent bundle) saved in the library, or may only want content (a script, a document, advice). Decide from the request and the conversation; if they only want content, answer directly and ignore this workflow."
      : "This is a persistent 智能体 (agent bundle) library creation request.",
    conditional
      ? "If they want it saved, call lily_agent_draft with action=create and a complete definition:"
      : "You must call lily_agent_draft with action=create and a complete definition:",
    "name, description, 3-5 starters in the user's language, skills (real installed skill ids only),",
    "knowledge.guidance as concrete working rules, knowledge.packs only from the known pack ids,",
    "tools.mcpAllow for tools it should prefer, autonomy.permissionModeId, and a role —",
    "either role.officialCharacterId for a matching official character, or roleCard with a",
    "complete character canonical (name, description, personality, scenario, firstMessage, creatorNotes).",
    "Ask at most one focused question if a critical preference is truly missing; otherwise design the whole bundle.",
    "Do not create a Markdown, text, JSON, or workspace file as a substitute for the library entity.",
    "Do not claim that creation or saving succeeded unless lily_agent_draft returns ok:true.",
    "If validation fails, repair the named field and retry.",
    "After ok:true, explain what was designed in plain language and tell the user it is available in the 智能体 library to try and enable in a conversation — activation is human-only.",
    "[/LILY AGENT AUTHORING WORKFLOW]",
    "",
    String(text || ""),
  ].join("\n");
}

function buildCharacterAuthoringEngineText(text, intent, { conditional = false } = {}) {
  const kind = intent?.active ? intent.kind : null;
  if (!kind) return String(text || "");
  if (kind === "agent") return buildAgentAuthoringEngineText(text, { conditional });
  const revise = intent.action === "revise" && typeof intent.targetReceiptId === "string";
  return [
    "[LILY CHARACTER AUTHORING WORKFLOW]",
    `kind=${kind}`,
    conditional
      ? `The user may want this ${kind} saved in the Character Worlds library, or may only want the content itself (a story, a description, a design). Decide from the request and the conversation; if they only want content, answer directly and ignore this workflow.`
      : revise
        ? "This is a persistent Character Worlds library refinement request."
        : "This is a persistent Character Worlds library creation request.",
    revise
      ? `You must call lily_character_draft with action=revise, kind=${kind}, and targetReceiptId=${intent.targetReceiptId}.`
      : conditional
        ? "If they want it saved, call lily_character_draft with action=create and the exact kind above."
        : "You must call lily_character_draft with action=create and the exact kind above.",
    "Design a complete, coherent canonical from the user's natural-language intent.",
    "Do not create a Markdown, text, JSON, or workspace file as a substitute for the library entity.",
    "Do not claim that creation or saving succeeded unless lily_character_draft returns ok:true.",
    "If validation fails, repair the canonical and retry. If one critical preference is truly missing, ask one focused question.",
    "After ok:true, explain the designed result naturally and tell the user it is available in the character library for review and selection.",
    "[/LILY CHARACTER AUTHORING WORKFLOW]",
    "",
    String(text || ""),
  ].join("\n");
}

module.exports = {
  buildAgentAuthoringEngineText,
  buildCharacterAuthoringEngineText,
  inferCharacterAuthoringIntent,
};
