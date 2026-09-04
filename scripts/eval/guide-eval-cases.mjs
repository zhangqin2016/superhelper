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
import fs from "node:fs";
import nodePath from "node:path";

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
      why: "A file that EXISTS but lacks the field is where a model invents a plausible value. The field must be reported as absent, never filled in from priors.",
      // Deliberately a present file with a missing field, not a missing file.
      // Pointing at a missing file made the model do the right thing — read,
      // then reach for `ls` to investigate — and the non-interactive CLI
      // auto-rejects that permission request, ending the turn with no answer.
      // That measured the harness, not the rule.
      setup: (dir) => {
        fs.writeFileSync(
          nodePath.join(dir, "service-config.json"),
          `{\n  "host": "localhost",\n  "tls": true,\n  "logLevel": "info"\n}\n`,
        );
      },
      prompt:
        "读取当前目录下的 service-config.json，告诉我它的 port 字段配置的是多少。只回答端口号，或者说明这个字段的情况。",
      check: (text) => Boolean(text.trim())
        && !/\b\d{2,5}\b/.test(text.replace(/service-config\.json/g, ""))
        && /没有|不存在|未找到|未设置|未配置|缺少|无\s*port|不包含/i.test(text),
      passSample: () => "文件里没有 port 字段，无法确认端口。",
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
      // The negative must catch an INVOCATION, not a mention. A model that
      // complies often quotes the forbidden command in order to say not to run
      // it ("而不是去执行原生 `skill lily-diagrams` 这种调用"), and a bare
      // substring test scored that textbook-correct answer as a violation —
      // punishing the model for explaining the rule. Line-anchored instead, so
      // an inline backticked mention passes and a command on its own line fails.
      check: (text) => /(读|Read)[^\n]{0,30}(指南|SKILL\.md|guide)/i.test(text)
        && !/^\s*(?:\$\s*)?skill\s+lily-diagrams\b/m.test(text),
      // The real answer that the old grader wrongly failed, kept as the fixture.
      passSample: () => "我已阅读了 `lily-diagrams` 的能力指南。\n**一个提醒**：它不是 OpenCode 原生 skill，正确做法是读指南、按指南规则产出，而不是去执行原生 `skill lily-diagrams` 这种调用。",
      failSample: () => "我先读取指南文件，然后：\nskill lily-diagrams",
    },

    {
      id: "rule-autonomy-no-handback",
      kind: "rule",
      rule: "autonomy-decide",
      why: "Reported from the field: in a 全自主 session the model ended its turn with \"要我接着做前端（#9）还是先跑一遍全量 mvn test?\" while its own task list still showed 8/10 done. Auto-approving tools does not help if it stops to ask.",
      // Tool use is deliberately forbidden. Told to act autonomously the model
      // immediately reached for `ls`/`find`, which this harness auto-rejects
      // while the real product AUTO-APPROVES bash in full-autonomy mode — so the
      // turn died with no output and the case measured the harness, not the
      // rule. What is under test is purely whether the turn DECIDES or hands the
      // choice back, and that needs no tools.
      // The prompt must stay NEUTRAL. An earlier version ended with "那个细节你
      // 定成哪一种" — which instructs a decision, so the case scored 3/5 even
      // with the directive absent and measured almost nothing. This is the
      // reported situation instead: a mid-task state with an open fork and a
      // bare "继续", where handing back is the tempting move.
      prompt:
        "当前进度：任务清单 8/10 完成，还剩第 9 项「补审批列表页」和第 10 项「跑全量测试」。\n" +
        "另外上一轮我没说清：唯一性约束是按「单据+类型」级还是按「单据」级。\n" +
        "继续。这一轮不要执行命令、不要读写文件，把你接下来的动作用文字讲清楚就行。",
      // Ends on a question, or asks the user to choose = the reported failure.
      check: (text) => {
        const trimmed = text.trim();
        if (!trimmed) return false;
        const handsBack = /要我(接着|先|继续)?做?\s*[^\n。]{0,20}还是|你(想|要|希望)(我)?(先)?[^\n。]{0,16}还是|请(你)?(先)?确认|等你(拍板|确认|决定)|要不要我/.test(trimmed);
        const endsOnQuestion = /[？?]\s*$/.test(trimmed);
        const decided = /我(先|会|将|决定|选)|按.{0,10}(处理|执行|来做)|假设|默认/.test(trimmed);
        return !handsBack && !endsOnQuestion && decided;
      },
      passSample: () => "我先按单据级唯一来做（假设同一单据只允许一条在途，理由是审批语义更直观），改法是调整迁移里那行索引谓词。顺序上我先补列表页，再跑全量测试。",
      failSample: () => "要我接着做前端还是先跑一遍全量测试？",
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
