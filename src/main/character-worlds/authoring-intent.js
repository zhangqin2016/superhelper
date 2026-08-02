"use strict";

const CREATE_WORDS = /(创建|新建|设计|生成|定制|做一个|打造|create|design|build|make)/i;
const WORLD_BOOK_WORDS = /(世界书|世界观|设定集|world\s*book|lore\s*book)/i;
const PERSONA_WORDS = /(人设|用户画像|persona)/i;
const CHARACTER_WORDS = /(角色卡|角色|人物|character)/i;
const DOCUMENT_WORDS = /(报告|文档|文章|方案|说明|教程|\.md\b|\.docx?\b|\.pdf\b)/i;
const NON_LIBRARY_CHARACTER_CONTEXT = /(角色管理|角色权限|角色扮演游戏|游戏角色系统|character\s+(management|permission|system|feature)|role[- ]?playing\s+game)/i;

function inferCharacterAuthoringIntent(text) {
  const input = String(text || "").trim();
  if (!input || !CREATE_WORDS.test(input)) return { active: false, kind: null };
  if (DOCUMENT_WORDS.test(input) && !WORLD_BOOK_WORDS.test(input)) {
    return { active: false, kind: null };
  }
  if (NON_LIBRARY_CHARACTER_CONTEXT.test(input)) return { active: false, kind: null };
  if (WORLD_BOOK_WORDS.test(input)) return { active: true, kind: "worldBook" };
  if (PERSONA_WORDS.test(input)) return { active: true, kind: "persona" };
  if (CHARACTER_WORDS.test(input)) return { active: true, kind: "character" };
  return { active: false, kind: null };
}

function buildCharacterAuthoringEngineText(text, intent) {
  const kind = intent?.active ? intent.kind : null;
  if (!kind) return String(text || "");
  const revise = intent.action === "revise" && typeof intent.targetReceiptId === "string";
  return [
    "[LILY CHARACTER AUTHORING WORKFLOW]",
    `kind=${kind}`,
    revise
      ? "This is a persistent Character Worlds library refinement request."
      : "This is a persistent Character Worlds library creation request.",
    revise
      ? `You must call lily_character_draft with action=revise, kind=${kind}, and targetReceiptId=${intent.targetReceiptId}.`
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
  buildCharacterAuthoringEngineText,
  inferCharacterAuthoringIntent,
};
