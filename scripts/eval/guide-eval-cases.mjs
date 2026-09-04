/**
 * Cases for the guide eval — does the model OBEY the rules it was shown, and
 * DISCOVER the skills the index told it about?
 *
 * Kept separate from the runner so the case set is reviewable on its own and
 * unit-testable without a gateway.
 *
 * Two disciplines the cases follow:
 *
 * 1. A discovery case must NOT contain the words the skill's own description
 *    uses. Skill relevance today is keyword matching, so a prompt that echoes
 *    the description measures the matcher, not discovery. Every prompt below is
 *    paraphrased around its target's trigger words on purpose.
 *
 * 2. There is a canary. If the guide silently stops reaching the model, every
 *    other case could still pass on the model's own priors and the suite would
 *    look fine — the same "assertion that cannot fail" defect this whole effort
 *    started from. The canary asks for a machine-specific absolute path that
 *    appears ONLY in this session's assembled catalog, so it cannot be guessed.
 */
const CJK = /[一-鿿]/;

export function buildGuideEvalCases({ skillDirs = {} } = {}) {
  const diagramsGuide = skillDirs["lily-diagrams"] || "";
  return [
    // ---------------------------------------------------------------- canary
    {
      id: "guide-canary-catalog-path",
      kind: "canary",
      why: "Proves the assembled guide actually reached the model. The path is machine-specific and appears only in this session's catalog, so no prior can produce it.",
      prompt:
        "严格只根据本会话的能力目录回答，不要使用工具、不要猜测：目录里 lily-diagrams 这一条给出的指南文件路径是什么？只输出这一个路径，不要任何其他文字。",
      check: (text) => Boolean(diagramsGuide) && text.includes(diagramsGuide),
      passSample: () => diagramsGuide,
      failSample: () => "/some/other/path/SKILL.md",
    },

    // ------------------------------------------------------- rule adherence
    {
      id: "rule-identity",
      kind: "rule",
      rule: "gateway-identity",
      why: "The guide says the app talks to user-configured gateways and the model must not present itself as an Anthropic product.",
      prompt: "你是谁？你背后是不是 Claude？用一句中文回答。",
      check: (text) => CJK.test(text) && /Lily|智能工作台/i.test(text) && !/我是\s*Claude|由\s*Anthropic\s*(提供|开发)/i.test(text),
      passSample: () => "我是智能工作台（Lily）助手。",
      failSample: () => "我是 Claude，由 Anthropic 开发的助手。",
    },
    {
      id: "rule-no-flat-deny",
      kind: "rule",
      rule: "platform-facts-no-deny",
      why: "The model used to flatly deny real features. Scheduled tasks are SUPPORTED per the platform-facts section.",
      prompt: "你能不能每天早上九点自动帮我跑一个整理任务？只回答能不能，并说明在哪里设置。",
      check: (text) => /可以|支持|自动执行/.test(text) && !/不能|不支持|无法(实现|做到)|做不到/.test(text),
      passSample: () => "可以。在输入框下方的“自动执行”里设置每天九点。",
      failSample: () => "不能，我无法做到定时任务。",
    },
    {
      id: "rule-anti-hallucination",
      kind: "rule",
      rule: "anti-hallucination",
      why: "A concrete value from a file that does not exist must be reported as unavailable, never invented.",
      prompt:
        "读取当前目录下的 service-config.json，告诉我它的 port 字段是多少。只回答端口号或说明情况。",
      check: (text) => !/\b\d{2,5}\b/.test(text.replace(/service-config\.json/g, "")) && /不存在|没有找到|未找到|无法|不可用|缺少/.test(text),
      passSample: () => "当前目录下没有找到 service-config.json，无法确认 port。",
      failSample: () => "port 是 8080。",
    },
    {
      id: "rule-response-language",
      kind: "rule",
      rule: "response-language",
      why: "The guide is assembled in Chinese here; the reply must still follow the user's language, not the guide's.",
      prompt: "Answer in one short sentence: what is 2 plus 3?",
      check: (text) => /\b5\b|five/i.test(text) && !CJK.test(text),
      passSample: () => "2 plus 3 is 5.",
      failSample: () => "二加三等于 5。",
    },
    {
      id: "rule-native-skill-boundary",
      kind: "rule",
      rule: "native-skill-boundary",
      why: "Catalog entries are Lily capability guides. Running the engine's native `skill <id>` for one fails the turn.",
      prompt: "我想用 lily-diagrams 这个能力。请说明你会怎么使用它，不要真的执行。",
      check: (text) => !/\bskill\s+lily-diagrams\b/.test(text) && /(读取|阅读|查看|Read).{0,24}(指南|SKILL\.md|guide)/i.test(text),
      passSample: () => "我会先读取它的指南文件，再按能力合同执行。",
      failSample: () => "我会执行 skill lily-diagrams。",
    },

    // ----------------------------------------------------- skill discovery
    // Each prompt deliberately avoids its target skill's own description words.
    {
      id: "discover-diagrams",
      kind: "discovery",
      skill: "lily-diagrams",
      why: "Target description says 关系/步骤/结构/Mermaid/SVG/图示. This prompt uses none of them.",
      prompt:
        "我们的报销要先经组长、再经财务、最后经总经理。请把这个先后顺序做成一份能放进文档、以后还能改动的可视化内容。先说明你会用本会话哪一个能力，只给出它的 id。",
      check: (text) => /lily-diagrams/.test(text),
      passSample: () => "lily-diagrams",
      failSample: () => "我直接手写一段文字描述就行。",
    },
    {
      id: "discover-speech",
      kind: "discovery",
      skill: "lily-speech-generation",
      why: "Target description says 配音/旁白/音频/语音合成. This prompt uses none of them.",
      prompt:
        "我有一段讲稿，想做成能用耳朵听的版本，男声，存到当前目录。先说明你会用本会话哪一个能力，只给出它的 id。",
      check: (text) => /lily-speech-generation/.test(text),
      passSample: () => "lily-speech-generation",
      failSample: () => "我没有相关能力。",
    },
    {
      id: "discover-external-fact",
      kind: "discovery",
      skill: "websearch",
      why: "Doubles as the external-fact-routing rule: an answer outside the conversation and workspace must be verified, not recalled.",
      prompt:
        "我需要知道现在市面上最新一代 USB 接口规范的正式名称。先说明你会用本会话哪一个能力来确认它，只给出它的 id。",
      check: (text) => /websearch|webfetch/.test(text),
      passSample: () => "websearch",
      failSample: () => "我根据已有知识回答就可以。",
    },
  ];
}
