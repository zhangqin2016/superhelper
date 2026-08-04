"use strict";

const PERSONA_TEMPLATES = Object.freeze([
  {
    id: "persona-project-lead",
    version: 1,
    categoryId: "work-identities",
    locales: {
      "zh-CN": {
        name: "项目负责人",
        tagline: "目标清楚、重视落地和风险",
        summary: "适合需要把复杂事情拆成目标、优先级和下一步行动的工作方式。",
        canonical: {
          name: "项目负责人",
          description: "我负责推动项目向前，需要清晰的判断、可执行的计划和对风险的提前提醒。",
          identity: "项目负责人或核心推进者",
          background: "同时处理目标、资源、协作和交付压力。",
          expertise: ["目标拆解", "优先级", "项目推进"],
          communicationStyle: "先给结论，再给依据、风险和下一步；避免空泛表达。",
          goals: ["推进关键事项", "减少返工", "及时暴露风险"],
          preferences: ["结构化信息", "明确取舍", "短而具体的行动清单"],
          constraints: ["不要把猜测说成事实", "重大取舍先说明假设"],
        },
      },
      en: {
        name: "Project Lead",
        tagline: "Clear goals, practical delivery, visible risks",
        summary: "For turning complex work into goals, priorities, decisions, and next actions.",
        canonical: {
          name: "Project Lead",
          description: "I move projects forward and need clear judgment, executable plans, and early risk signals.",
          identity: "A project owner or core driver",
          background: "Balancing goals, resources, collaboration, and delivery pressure.",
          expertise: ["goal setting", "prioritization", "project delivery"],
          communicationStyle: "Lead with the conclusion, then evidence, risks, and next actions.",
          goals: ["Move critical work forward", "Reduce rework", "Surface risks early"],
          preferences: ["Structured information", "Explicit trade-offs", "Short action lists"],
          constraints: ["Do not present guesses as facts", "State assumptions before major trade-offs"],
        },
      },
      ar: {
        name: "قائد مشروع",
        tagline: "أهداف واضحة وتنفيذ عملي ومخاطر ظاهرة",
        summary: "لتحويل العمل المعقد إلى أهداف وأولويات وقرارات وخطوات تالية.",
        canonical: {
          name: "قائد مشروع",
          description: "أدفع المشاريع إلى الأمام وأحتاج إلى حكم واضح وخطط قابلة للتنفيذ وتنبيهات مبكرة للمخاطر.",
          identity: "مالك مشروع أو قائد أساسي",
          background: "أوازن بين الأهداف والموارد والتعاون وضغط التسليم.",
          expertise: ["تحديد الأهداف", "ترتيب الأولويات", "تنفيذ المشاريع"],
          communicationStyle: "ابدأ بالخلاصة ثم الأدلة والمخاطر والخطوات التالية.",
          goals: ["دفع العمل المهم", "تقليل إعادة العمل", "كشف المخاطر مبكرا"],
          preferences: ["معلومات منظمة", "مفاضلات واضحة", "قوائم إجراءات قصيرة"],
          constraints: ["لا تقدم التخمين كحقيقة", "اذكر الافتراضات قبل المفاضلات الكبيرة"],
        },
      },
    },
  },
  {
    id: "persona-learning-builder",
    version: 1,
    categoryId: "research-learning",
    locales: {
      "zh-CN": {
        name: "学习与成长者",
        tagline: "把理解变成练习和稳定进步",
        summary: "适合希望解释清楚、练习充分，并持续看到自己进步的人。",
        canonical: {
          name: "学习与成长者",
          description: "我希望真正理解并掌握新知识，而不是只得到一个看似正确的答案。",
          identity: "主动学习和持续成长的人",
          background: "会在工作和生活中学习新技能，需要兼顾时间和实际应用。",
          expertise: ["目标学习", "实践反馈", "知识整理"],
          communicationStyle: "先判断基础，再分步解释；用例子和练习确认理解。",
          goals: ["掌握核心概念", "建立可迁移的能力", "持续复盘"],
          preferences: ["循序渐进", "及时纠错", "把抽象内容联系到实际"],
          constraints: ["不要跳过关键前提", "不把一次答对当作已经掌握"],
        },
      },
      en: {
        name: "Learning Builder",
        tagline: "Turn understanding into practice and steady progress",
        summary: "For people who want clear explanations, useful practice, and visible improvement.",
        canonical: {
          name: "Learning Builder",
          description: "I want to genuinely understand and use new knowledge, not just receive a plausible answer.",
          identity: "An active learner building durable skills",
          background: "Learning new skills alongside work and life, with limited time and a need for application.",
          expertise: ["goal-based learning", "practice feedback", "knowledge organization"],
          communicationStyle: "Check the baseline, explain step by step, and verify with examples and practice.",
          goals: ["Master core concepts", "Build transferable skills", "Review progress regularly"],
          preferences: ["Progressive difficulty", "Fast correction", "Practical connections"],
          constraints: ["Do not skip key prerequisites", "Do not equate one correct answer with mastery"],
        },
      },
      ar: {
        name: "باني التعلم",
        tagline: "تحويل الفهم إلى ممارسة وتقدم ثابت",
        summary: "لمن يريد شرحا واضحا وتدريبا مفيدا وتحسنا يمكن رؤيته.",
        canonical: {
          name: "باني التعلم",
          description: "أريد فهم المعرفة الجديدة واستخدامها فعلا لا مجرد الحصول على إجابة تبدو صحيحة.",
          identity: "متعلم نشط يبني مهارات دائمة",
          background: "أتعلم مهارات جديدة إلى جانب العمل والحياة مع وقت محدود وحاجة للتطبيق.",
          expertise: ["التعلم الموجه", "ملاحظات التدريب", "تنظيم المعرفة"],
          communicationStyle: "تحقق من الأساس ثم اشرح خطوة بخطوة واختبر الفهم بالأمثلة والتدريب.",
          goals: ["إتقان المفاهيم الأساسية", "بناء مهارات قابلة للنقل", "مراجعة التقدم"],
          preferences: ["صعوبة متدرجة", "تصحيح سريع", "ربط عملي"],
          constraints: ["لا تتجاوز المتطلبات الأساسية", "لا تعتبر إجابة واحدة إتقانا"],
        },
      },
    },
  },
  {
    id: "persona-creative-maker",
    version: 1,
    categoryId: "creative-identities",
    locales: {
      "zh-CN": {
        name: "创作者",
        tagline: "保留灵感，也把作品做完整",
        summary: "适合写作、策划和内容创作，需要灵感发散与结构收束并存的工作方式。",
        canonical: {
          name: "创作者",
          description: "我希望保留自己的表达，同时把想法发展成完整、清楚、有感染力的作品。",
          identity: "写作者、策划者或内容创作者",
          background: "经常在灵感、修改、截止时间和受众需求之间切换。",
          expertise: ["创意发散", "结构设计", "内容打磨"],
          communicationStyle: "先允许提出多个方向，再帮助比较并收束成可执行版本。",
          goals: ["形成独特表达", "完成作品", "持续迭代质量"],
          preferences: ["具体反馈", "保留选择权", "兼顾创意和完成度"],
          constraints: ["不要未经同意替换核心意图", "批评要指向作品而不是人"],
        },
      },
      en: {
        name: "Creative Maker",
        tagline: "Keep the spark and finish the work",
        summary: "For writing, planning, and content work that needs both exploration and structure.",
        canonical: {
          name: "Creative Maker",
          description: "I want to keep my voice while turning ideas into complete, clear, engaging work.",
          identity: "A writer, planner, or content creator",
          background: "Moving between inspiration, revision, deadlines, and audience needs.",
          expertise: ["creative exploration", "structure", "content refinement"],
          communicationStyle: "Explore several directions first, then compare and shape an executable version.",
          goals: ["Develop a distinct voice", "Finish the work", "Iterate quality"],
          preferences: ["Specific feedback", "Keep agency", "Balance creativity and completion"],
          constraints: ["Do not replace the core intent without consent", "Critique the work, not the person"],
        },
      },
      ar: {
        name: "صانع إبداعي",
        tagline: "الحفاظ على الشرارة وإنهاء العمل",
        summary: "للكتابة والتخطيط وصناعة المحتوى التي تحتاج إلى الاستكشاف والبنية معا.",
        canonical: {
          name: "صانع إبداعي",
          description: "أريد الحفاظ على صوتي وتحويل الأفكار إلى عمل كامل وواضح ومؤثر.",
          identity: "كاتب أو مخطط أو صانع محتوى",
          background: "أتنقل بين الإلهام والمراجعة والمواعيد واحتياجات الجمهور.",
          expertise: ["استكشاف إبداعي", "البنية", "صقل المحتوى"],
          communicationStyle: "استكشف عدة اتجاهات أولا ثم قارن وشكل نسخة قابلة للتنفيذ.",
          goals: ["تطوير صوت مميز", "إنهاء العمل", "تحسين الجودة باستمرار"],
          preferences: ["ملاحظات محددة", "الحفاظ على الاختيار", "التوازن بين الإبداع والإنجاز"],
          constraints: ["لا تستبدل النية الأساسية دون موافقة", "انتقد العمل لا الشخص"],
        },
      },
    },
  },
]);

const ADDITIONAL_PERSONA_TEMPLATES = Object.freeze([
  {
    id: "persona-work-owner",
    version: 1,
    categoryId: "work-identities",
    locales: {
      "zh-CN": {
        name: "工作推进者",
        tagline: "把重要工作推进到明确完成",
        summary: "适合同时面对多项任务、协作依赖和临近截止时间，需要稳定推进而不是堆积待办的人。",
        canonical: {
          name: "工作推进者",
          description: "我希望把有限时间投入最重要的结果，知道现在该做什么、等谁、卡在哪里，以及什么才算完成。",
          identity: "负责多个工作结果的专业人士",
          background: "在会议、消息、深度工作和临时事项之间切换，需要管理注意力与承诺。",
          expertise: ["任务排序", "依赖管理", "交付检查"],
          communicationStyle: "先区分紧急和重要，再给出今天、这周和等待他人的具体动作；发现冲突就提前提醒。",
          goals: ["完成关键结果", "减少遗漏和反复切换", "让承诺有负责人和截止时间"],
          preferences: ["少量明确优先级", "下一步动作可直接执行", "用事实更新进度"],
          constraints: ["不要把忙碌等同于进展", "不要替我承诺他人或假设任务已完成"],
        },
      },
      en: {
        name: "Work Owner",
        tagline: "Move important work to a clear finish",
        summary: "For managing several commitments, dependencies, and deadlines without turning the day into an endless task list.",
        canonical: {
          name: "Work Owner",
          description: "I want to spend limited time on the most important outcomes and know what to do, who I am waiting on, and what done means.",
          identity: "A professional accountable for multiple outcomes",
          background: "Switching between meetings, messages, focused work, and interruptions while protecting attention and commitments.",
          expertise: ["task ordering", "dependency management", "delivery checks"],
          communicationStyle: "Separate urgent from important, then give actions for today, this week, and dependencies; flag conflicts early.",
          goals: ["Finish critical outcomes", "Reduce omissions and context switching", "Give commitments owners and dates"],
          preferences: ["Few clear priorities", "Immediately executable next actions", "Fact-based progress updates"],
          constraints: ["Do not equate busyness with progress", "Do not commit other people or assume work is done"],
        },
      },
    },
  },
  {
    id: "persona-life-manager",
    version: 1,
    categoryId: "life-support",
    locales: {
      "zh-CN": {
        name: "生活管理者",
        tagline: "让生活安排可持续，而不是更忙",
        summary: "适合整理日常事务、预算、预约、家务和个人计划，同时尊重精力、隐私与现实限制的人。",
        canonical: {
          name: "生活管理者",
          description: "我希望生活中的重要事情有秩序，但计划必须适应真实的时间、精力、预算和突发变化。",
          identity: "管理个人生活系统的成年人",
          background: "需要在工作、休息、家务、财务和个人需求之间做现实的取舍。",
          expertise: ["生活规划", "事务整理", "可持续习惯"],
          communicationStyle: "给出轻量、分优先级的安排，先处理影响最大的事项，不用完美主义增加压力。",
          goals: ["降低生活摩擦", "守住关键承诺", "保留休息和缓冲时间"],
          preferences: ["一页式总览", "低维护的流程", "提前看到成本和冲突"],
          constraints: ["不要擅自假设我的收入、健康或家庭情况", "不要把自律建议变成道德评判"],
        },
      },
      en: {
        name: "Life Manager",
        tagline: "Make life sustainable, not busier",
        summary: "For organizing daily administration, budgets, appointments, chores, and personal plans around real energy and constraints.",
        canonical: {
          name: "Life Manager",
          description: "I want order in important parts of life, but plans must fit real time, energy, budget, and unexpected changes.",
          identity: "An adult managing a personal life system",
          background: "Making practical trade-offs across work, rest, home administration, money, and personal needs.",
          expertise: ["life planning", "personal administration", "sustainable habits"],
          communicationStyle: "Offer lightweight, prioritized plans; handle the highest-impact item first without adding perfectionist pressure.",
          goals: ["Reduce daily friction", "Keep important commitments", "Protect rest and buffer time"],
          preferences: ["One-page overviews", "Low-maintenance systems", "Early visibility into cost and conflict"],
          constraints: ["Do not assume my income, health, or family situation", "Do not turn discipline advice into moral judgment"],
        },
      },
    },
  },
  {
    id: "persona-career-transition",
    version: 1,
    categoryId: "career-development",
    locales: {
      "zh-CN": {
        name: "职业转型者",
        tagline: "用小实验验证下一条路",
        summary: "适合探索换行业、换岗位、重返职场或建立副业，需要把愿望转成证据和选择的人。",
        canonical: {
          name: "职业转型者",
          description: "我正在探索下一阶段职业方向，希望用真实信息和小成本实验减少盲目选择。",
          identity: "处于职业探索或转型阶段的行动者",
          background: "已有经历和可迁移能力，但目标、市场、收入和学习成本之间存在不确定性。",
          expertise: ["能力迁移", "方向比较", "求职实验"],
          communicationStyle: "把建议拆成假设、证据和下一步实验，明确哪些只是推测，避免过早下结论。",
          goals: ["找到可行方向", "形成可信的能力证据", "控制转型风险"],
          preferences: ["多方案比较", "真实岗位和行业信息", "每周可完成的验证动作"],
          constraints: ["不要承诺录用或收入结果", "不要忽略家庭、签证、地域和现金流约束"],
        },
      },
      en: {
        name: "Career Transitioner",
        tagline: "Use small experiments to test the next path",
        summary: "For changing industries, returning to work, changing roles, or building a side path with evidence instead of guesswork.",
        canonical: {
          name: "Career Transitioner",
          description: "I am exploring the next stage of my career and want real information and low-cost experiments before committing.",
          identity: "An active person exploring or changing careers",
          background: "Bringing experience and transferable skills into uncertainty about market fit, income, and learning cost.",
          expertise: ["skill transfer", "direction comparison", "job-search experiments"],
          communicationStyle: "Frame advice as hypotheses, evidence, and next experiments; label guesses and avoid premature certainty.",
          goals: ["Find a viable direction", "Build credible evidence of ability", "Control transition risk"],
          preferences: ["Compare multiple options", "Real role and industry information", "Weekly validation actions"],
          constraints: ["Do not promise hiring or income outcomes", "Do not ignore family, visa, location, or cash-flow constraints"],
        },
      },
    },
  },
  {
    id: "persona-family-coordinator",
    version: 1,
    categoryId: "life-support",
    locales: {
      "zh-CN": {
        name: "家庭事务协调者",
        tagline: "把家庭责任分清楚，也把关系照顾好",
        summary: "适合协调家庭日程、采购、照护、出行和重要决定，需要事实清楚、分工公平、沟通不升级的人。",
        canonical: {
          name: "家庭事务协调者",
          description: "我希望家庭事务有清晰的安排和责任，但协调不能只追求效率，也要尊重每个人的感受和边界。",
          identity: "承担家庭组织与协调责任的人",
          background: "在多个家庭成员、时间表、预算和照护需求之间保持信息同步。",
          expertise: ["家庭日程", "责任分工", "共识沟通"],
          communicationStyle: "先把事实、需求和选择分开，再明确谁负责什么；敏感问题先确认感受和边界。",
          goals: ["减少重复沟通", "让责任透明可调整", "在冲突前形成共识"],
          preferences: ["共享清单", "明确但不强硬的措辞", "保留个人隐私"],
          constraints: ["不要替家庭成员表达未确认的意见", "健康、法律和财务重大事项需要专业人士或共同确认"],
        },
      },
      en: {
        name: "Family Coordinator",
        tagline: "Clarify responsibilities while protecting relationships",
        summary: "For coordinating family schedules, errands, care, travel, and decisions with clear facts, fair ownership, and calm communication.",
        canonical: {
          name: "Family Coordinator",
          description: "I want family responsibilities organized, but coordination must respect feelings and boundaries, not only efficiency.",
          identity: "A person carrying family organization and coordination work",
          background: "Keeping information aligned across people, schedules, budgets, and care needs.",
          expertise: ["family scheduling", "responsibility sharing", "consensus communication"],
          communicationStyle: "Separate facts, needs, and options, then name ownership; confirm feelings and boundaries around sensitive topics.",
          goals: ["Reduce repeated coordination", "Make ownership visible and adjustable", "Build agreement before conflict escalates"],
          preferences: ["Shared checklists", "Clear but non-coercive wording", "Respect for personal privacy"],
          constraints: ["Do not speak for family members without confirmation", "Major health, legal, and financial matters need professionals or shared confirmation"],
        },
      },
    },
  },
]);

const ALL_PERSONA_TEMPLATES = Object.freeze([
  ...PERSONA_TEMPLATES,
  ...ADDITIONAL_PERSONA_TEMPLATES,
]);

function bookEntry({ id, title, content, primaryKeys = [], secondaryKeys = [], constant = false, position = "before_character" }) {
  return {
    id,
    title,
    enabled: true,
    content,
    activation: {
      constant,
      primaryKeys: [...primaryKeys],
      secondaryKeys: [...secondaryKeys],
      selective: false,
      probability: 100,
    },
    insertion: { position, order: 100 },
  };
}

const WORLD_BOOK_TEMPLATES = Object.freeze([
  {
    id: "world-book-project-knowledge",
    version: 1,
    categoryId: "project-knowledge",
    locales: {
      "zh-CN": {
        name: "项目知识库",
        tagline: "让项目事实有出处、可复用、不过度脑补",
        summary: "适合长期项目协作，保存目标、范围、决策、术语和已确认事实。",
        canonical: {
          name: "项目知识库",
          entries: [
            bookEntry({ id: "source-of-truth", title: "事实与来源", constant: true, content: "项目事实必须以用户提供的文件、明确确认的消息或已保存的项目资料为准。资料没有覆盖时要明确说未知，不要为了让答案完整而补写项目事实。" }),
            bookEntry({ id: "project-scope", title: "项目目标与范围", content: "记录项目要解决的问题、目标用户、交付边界和明确不做的事情。回答项目问题时，先检查建议是否仍在这个范围内。", primaryKeys: ["项目目标", "项目范围", "目标用户"], secondaryKeys: ["边界", "不做什么"] }),
            bookEntry({ id: "decisions", title: "已确认决策", content: "记录已经确认的方案、决策日期、决策理由和替代方案。新建议与既有决策冲突时，先指出冲突，再请求确认是否更新决策。", primaryKeys: ["决策", "已确认", "方案"], secondaryKeys: ["为什么", "替代方案"] }),
            bookEntry({ id: "project-terms", title: "项目术语", content: "项目内部术语应优先使用团队已确认的写法；遇到同义词或缩写，先采用本条目定义，不要擅自创造新的同义表达。", primaryKeys: ["术语", "定义", "缩写"], secondaryKeys: ["叫法", "含义"] }),
          ],
          scanPolicy: { scanDepthMessages: 12, includeParticipantNames: true, tokenBudget: 1800, recursive: true, maxRecursionSteps: 3 },
        },
      },
      en: {
        name: "Project Knowledge Base",
        tagline: "Reusable project facts with sources and clear boundaries",
        summary: "For long-running projects: goals, scope, decisions, terms, and confirmed facts.",
        canonical: {
          name: "Project Knowledge Base",
          entries: [
            bookEntry({ id: "source-of-truth", title: "Facts and sources", constant: true, content: "Project facts must come from user-provided files, explicitly confirmed messages, or saved project material. When the material is silent, say that it is unknown instead of inventing a fact." }),
            bookEntry({ id: "project-scope", title: "Project goals and scope", content: "Record the problem, target users, delivery boundary, and explicit non-goals. Check that project advice still fits this scope.", primaryKeys: ["project goal", "project scope", "target user"], secondaryKeys: ["boundary", "non-goal"] }),
            bookEntry({ id: "decisions", title: "Confirmed decisions", content: "Record approved options, dates, reasons, and alternatives. When a new suggestion conflicts with a decision, surface the conflict before changing it.", primaryKeys: ["decision", "approved", "proposal"], secondaryKeys: ["reason", "alternative"] }),
            bookEntry({ id: "project-terms", title: "Project terms", content: "Prefer the team's confirmed spelling and definitions for internal terms. Do not invent a new synonym for an existing term.", primaryKeys: ["term", "definition", "abbreviation"], secondaryKeys: ["meaning", "naming"] }),
          ],
          scanPolicy: { scanDepthMessages: 12, includeParticipantNames: true, tokenBudget: 1800, recursive: true, maxRecursionSteps: 3 },
        },
      },
    },
  },
  {
    id: "world-book-research-evidence",
    version: 1,
    categoryId: "research-analysis",
    locales: {
      "zh-CN": {
        name: "研究与证据规范",
        tagline: "让结论、证据和不确定性分得开",
        summary: "适合调研、竞品分析和事实核查，减少把推测写成结论。",
        canonical: {
          name: "研究与证据规范",
          entries: [
            bookEntry({ id: "claim-evidence", title: "结论必须对应证据", constant: true, content: "每个重要结论都要能追溯到具体来源或明确推理。区分事实、推断、观点和待验证假设，不能用语气掩盖证据不足。" }),
            bookEntry({ id: "source-quality", title: "来源质量", content: "优先使用一手资料、原始数据、官方文档和可复核的研究。来源之间冲突时同时呈现冲突，不要只选择更符合预期的一方。", primaryKeys: ["来源", "证据", "数据质量"], secondaryKeys: ["官方", "原始资料"] }),
            bookEntry({ id: "uncertainty", title: "不确定性表达", content: "结论应说明适用范围、时间点和置信程度。无法确认时给出需要补充的证据，而不是直接给出确定答案。", primaryKeys: ["不确定", "置信度", "待验证"], secondaryKeys: ["假设", "限制"] }),
          ],
          scanPolicy: { scanDepthMessages: 10, includeParticipantNames: true, tokenBudget: 1600, recursive: true, maxRecursionSteps: 2 },
        },
      },
      en: {
        name: "Research and Evidence Rules",
        tagline: "Keep claims, evidence, and uncertainty separate",
        summary: "For research, competitive analysis, and fact checking without turning guesses into conclusions.",
        canonical: {
          name: "Research and Evidence Rules",
          entries: [
            bookEntry({ id: "claim-evidence", title: "Claims need evidence", constant: true, content: "Every important claim should trace to a source or explicit reasoning. Separate facts, inferences, opinions, and hypotheses; do not hide weak evidence behind confident wording." }),
            bookEntry({ id: "source-quality", title: "Source quality", content: "Prefer primary material, original data, official documentation, and reproducible research. When sources conflict, show the conflict instead of choosing the convenient side.", primaryKeys: ["source", "evidence", "data quality"], secondaryKeys: ["official", "primary material"] }),
            bookEntry({ id: "uncertainty", title: "Expressing uncertainty", content: "State scope, date, and confidence. When the evidence is insufficient, name what would resolve the uncertainty instead of pretending to know.", primaryKeys: ["uncertain", "confidence", "to verify"], secondaryKeys: ["hypothesis", "limitation"] }),
          ],
          scanPolicy: { scanDepthMessages: 10, includeParticipantNames: true, tokenBudget: 1600, recursive: true, maxRecursionSteps: 2 },
        },
      },
    },
  },
  {
    id: "world-book-story-bible",
    version: 1,
    categoryId: "story-worlds",
    locales: {
      "zh-CN": {
        name: "故事世界圣经",
        tagline: "人物、规则、时间线和伏笔保持一致",
        summary: "适合长篇写作和连续剧情，集中维护世界规则与已发生事实。",
        canonical: {
          name: "故事世界圣经",
          entries: [
            bookEntry({ id: "canon-rule", title: "正史优先", constant: true, content: "已经写入正史的事实优先于临时灵感。新内容不能无提示地改写角色经历、世界规则或已发生事件；需要改写时明确标注为修订。" }),
            bookEntry({ id: "world-rules", title: "世界规则", content: "记录这个世界中能力、技术、组织、资源和代价的边界。角色行动必须遵守已确认的规则，除非剧情明确展示了规则变化。", primaryKeys: ["世界规则", "能力", "代价"], secondaryKeys: ["限制", "组织"] }),
            bookEntry({ id: "timeline", title: "时间线与关系", content: "记录事件顺序、人物关系和关键伏笔。生成新场景前先检查时间线和角色动机，避免人物同时出现在不可能的地点或状态。", primaryKeys: ["时间线", "关系", "伏笔"], secondaryKeys: ["之前", "之后"] }),
          ],
          scanPolicy: { scanDepthMessages: 16, includeParticipantNames: true, tokenBudget: 2200, recursive: true, maxRecursionSteps: 4 },
        },
      },
      en: {
        name: "Story World Bible",
        tagline: "Keep characters, rules, timelines, and foreshadowing consistent",
        summary: "For long-form fiction and serial stories that need a stable canon and world rules.",
        canonical: {
          name: "Story World Bible",
          entries: [
            bookEntry({ id: "canon-rule", title: "Canon comes first", constant: true, content: "Facts already written into canon outrank temporary inspiration. New material must not silently rewrite character history, world rules, or events; mark revisions explicitly." }),
            bookEntry({ id: "world-rules", title: "World rules", content: "Record limits, costs, technologies, organizations, and resources. Character actions must respect confirmed rules unless the story shows a rule changing.", primaryKeys: ["world rule", "ability", "cost"], secondaryKeys: ["limit", "organization"] }),
            bookEntry({ id: "timeline", title: "Timeline and relationships", content: "Record event order, relationships, and important foreshadowing. Check timeline and motivation before generating a new scene.", primaryKeys: ["timeline", "relationship", "foreshadowing"], secondaryKeys: ["before", "after"] }),
          ],
          scanPolicy: { scanDepthMessages: 16, includeParticipantNames: true, tokenBudget: 2200, recursive: true, maxRecursionSteps: 4 },
        },
      },
    },
  },
]);

const ADDITIONAL_WORLD_BOOK_TEMPLATES = Object.freeze([
  {
    id: "world-book-meeting-operations",
    version: 1,
    categoryId: "work-operations",
    locales: {
      "zh-CN": {
        name: "会议运营系统",
        tagline: "让会议有目标、有决策、有责任人",
        summary: "把会前准备、现场决策和会后执行连成一条可追踪的工作链。",
        canonical: {
          name: "会议运营系统",
          entries: [
            bookEntry({ id: "meeting-purpose", title: "会议必须服务于结果", constant: true, content: "每次会议先明确目的：同步信息、做决定、解决问题或分配行动。若只是传递信息，优先改成书面更新；没有明确目的时，不要用冗长议程制造会议感。" }),
            bookEntry({ id: "decision-record", title: "决策记录", content: "把最终决定、未决问题、决策依据和适用范围分开记录。参与者不同意但被否决的观点也要保留，避免会后重新争论。", primaryKeys: ["决策", "决定", "拍板"], secondaryKeys: ["依据", "未决", "反对意见"] }),
            bookEntry({ id: "action-ownership", title: "行动项必须有负责人和完成标准", content: "每个行动项至少包含负责人、下一步动作、完成标准和截止时间。没有负责人或验收标准的内容只能算讨论结果，不能算执行计划。", primaryKeys: ["行动项", "待办", "负责人", "截止时间"], secondaryKeys: ["完成标准", "跟进"] }),
            bookEntry({ id: "follow-up", title: "会后跟进", content: "跟进时只更新状态：未开始、进行中、阻塞、已完成或取消。发现延期先说明原因和新计划，不把沉默或口头承诺写成已完成。", primaryKeys: ["会后", "跟进", "延期", "状态"], secondaryKeys: ["阻塞", "完成"] }),
          ],
          scanPolicy: { scanDepthMessages: 14, includeParticipantNames: true, tokenBudget: 1900, recursive: true, maxRecursionSteps: 3 },
        },
      },
      en: {
        name: "Meeting Operations System",
        tagline: "Give every meeting a goal, decision, and owner",
        summary: "Connect preparation, decisions, and follow-through into one trackable operating loop.",
        canonical: {
          name: "Meeting Operations System",
          entries: [
            bookEntry({ id: "meeting-purpose", title: "Meetings serve an outcome", constant: true, content: "Start with the purpose: share information, decide, solve a problem, or assign action. If the goal is information transfer, prefer a written update. Do not use a long agenda to compensate for an unclear purpose." }),
            bookEntry({ id: "decision-record", title: "Decision record", content: "Separate the final decision, unresolved questions, rationale, and scope. Preserve dissenting views even when they were not selected so the group does not reopen the same debate without new evidence.", primaryKeys: ["decision", "decide", "approval"], secondaryKeys: ["rationale", "unresolved", "dissent"] }),
            bookEntry({ id: "action-ownership", title: "Actions need an owner and a done definition", content: "Every action needs an owner, next action, done definition, and due date. Without ownership or acceptance criteria, it is a discussion outcome, not an execution plan.", primaryKeys: ["action item", "todo", "owner", "due date"], secondaryKeys: ["done", "follow-up"] }),
            bookEntry({ id: "follow-up", title: "After-meeting follow-up", content: "Update status only: not started, in progress, blocked, done, or cancelled. When something slips, state why and give a new plan; never turn silence or a verbal promise into completed work.", primaryKeys: ["after meeting", "follow-up", "delayed", "status"], secondaryKeys: ["blocked", "done"] }),
          ],
          scanPolicy: { scanDepthMessages: 14, includeParticipantNames: true, tokenBudget: 1900, recursive: true, maxRecursionSteps: 3 },
        },
      },
    },
  },
  {
    id: "world-book-writing-style",
    version: 1,
    categoryId: "writing-communication",
    locales: {
      "zh-CN": {
        name: "写作与表达规范",
        tagline: "让文字准确、顺畅，并且真正服务读者",
        summary: "适合邮件、报告、方案、对外内容和长期文档，稳定控制受众、语气、结构和证据。",
        canonical: {
          name: "写作与表达规范",
          entries: [
            bookEntry({ id: "reader-first", title: "先服务读者任务", constant: true, content: "写作前先确认读者是谁、需要做什么决定以及读完后要采取什么行动。优先给结论和上下文，再补充细节；不要用漂亮措辞掩盖信息缺口。" }),
            bookEntry({ id: "voice-and-tone", title: "语气与边界", content: "根据场景选择专业、直接、友好或谨慎的语气。区分事实、建议、判断和承诺；不使用夸大、威胁、空泛口号或未经授权的代表性表述。", primaryKeys: ["语气", "风格", "读者", "口吻"], secondaryKeys: ["专业", "正式", "友好"] }),
            bookEntry({ id: "structure", title: "结构先于修辞", content: "长文优先使用标题、结论、依据、选项、风险和下一步。每段只承担一个主要任务；重复内容合并，术语保持一致，例子必须解释观点而不是装饰。", primaryKeys: ["结构", "大纲", "报告", "方案"], secondaryKeys: ["标题", "段落", "术语"] }),
            bookEntry({ id: "revision-check", title: "发布前检查", content: "发布前检查事实、数字、链接、名称、受众、语气和行动要求。把无法确认的内容标成待核实，保留原意，不为追求流畅擅自增加事实。", primaryKeys: ["修改", "润色", "发布", "校对"], secondaryKeys: ["检查", "核实", "链接"] }),
          ],
          scanPolicy: { scanDepthMessages: 12, includeParticipantNames: false, tokenBudget: 1800, recursive: true, maxRecursionSteps: 3 },
        },
      },
      en: {
        name: "Writing and Communication Rules",
        tagline: "Make writing accurate, clear, and useful to its reader",
        summary: "For emails, reports, proposals, external content, and durable documents with consistent audience, tone, structure, and evidence.",
        canonical: {
          name: "Writing and Communication Rules",
          entries: [
            bookEntry({ id: "reader-first", title: "Serve the reader's task first", constant: true, content: "Before writing, identify the reader, the decision they need to make, and the action they should take. Lead with the conclusion and context, then details; never use polished wording to hide missing information." }),
            bookEntry({ id: "voice-and-tone", title: "Tone and boundaries", content: "Choose a professional, direct, warm, or cautious tone for the situation. Separate facts, suggestions, judgments, and commitments; avoid hype, threats, empty slogans, or unauthorized claims to represent others.", primaryKeys: ["tone", "style", "reader", "voice"], secondaryKeys: ["professional", "formal", "friendly"] }),
            bookEntry({ id: "structure", title: "Structure before rhetoric", content: "For long writing, use headings, conclusion, evidence, options, risks, and next steps. Give each paragraph one main job; keep terms consistent and make examples explain rather than decorate.", primaryKeys: ["structure", "outline", "report", "proposal"], secondaryKeys: ["heading", "paragraph", "term"] }),
            bookEntry({ id: "revision-check", title: "Pre-publication check", content: "Check facts, numbers, links, names, audience, tone, and requested action before publishing. Mark uncertain material for verification and preserve intent instead of adding facts for fluency.", primaryKeys: ["revise", "edit", "publish", "proofread"], secondaryKeys: ["check", "verify", "link"] }),
          ],
          scanPolicy: { scanDepthMessages: 12, includeParticipantNames: false, tokenBudget: 1800, recursive: true, maxRecursionSteps: 3 },
        },
      },
    },
  },
  {
    id: "world-book-career-search",
    version: 1,
    categoryId: "career-development",
    locales: {
      "zh-CN": {
        name: "求职与职业转型",
        tagline: "用证据匹配岗位，用实验降低转型风险",
        summary: "把经历、能力、岗位要求、简历、面试和投递跟踪放进一个可复盘的求职系统。",
        canonical: {
          name: "求职与职业转型",
          entries: [
            bookEntry({ id: "target-role", title: "先定义目标岗位", constant: true, content: "先明确目标岗位、行业、地点、工作方式、薪资底线和不可接受条件。没有这些约束时，不要把所有职位都视为同一个求职目标。" }),
            bookEntry({ id: "evidence-based-profile", title: "用证据描述能力", content: "能力描述优先使用行动、场景、难点、结果和可验证证据。不要把职责清单当成成就，也不要编造数字、头衔或工具熟练度。", primaryKeys: ["简历", "经历", "能力", "项目成果"], secondaryKeys: ["成就", "证据", "STAR"] }),
            bookEntry({ id: "interview-preparation", title: "面试准备", content: "每个高频问题准备真实案例、关键判断和复盘；回答要说明背景、行动、结果与反思。遇到不知道的问题，说明边界并给出解决路径。", primaryKeys: ["面试", "面试题", "自我介绍"], secondaryKeys: ["案例", "回答", "STAR"] }),
            bookEntry({ id: "application-tracking", title: "投递与复盘", content: "记录岗位、来源、版本、投递日期、阶段、反馈和下一步。按回复率、面试率和反馈类型复盘策略，不用单次拒绝判断全部方向。", primaryKeys: ["投递", "求职进度", "面试进展"], secondaryKeys: ["拒信", "反馈", "复盘"] }),
          ],
          scanPolicy: { scanDepthMessages: 12, includeParticipantNames: true, tokenBudget: 1900, recursive: true, maxRecursionSteps: 3 },
        },
      },
      en: {
        name: "Job Search and Career Transition",
        tagline: "Match roles with evidence and reduce transition risk",
        summary: "Put experience, skills, role requirements, resumes, interviews, and applications into a reviewable job-search system.",
        canonical: {
          name: "Job Search and Career Transition",
          entries: [
            bookEntry({ id: "target-role", title: "Define the target role first", constant: true, content: "Clarify target role, industry, location, work model, minimum compensation, and non-negotiables. Without these constraints, do not treat every opening as the same search target." }),
            bookEntry({ id: "evidence-based-profile", title: "Describe ability with evidence", content: "Describe skills through action, context, challenge, result, and verifiable evidence. A duty list is not an achievement; never invent numbers, titles, or tool proficiency.", primaryKeys: ["resume", "experience", "skill", "project result"], secondaryKeys: ["achievement", "evidence", "STAR"] }),
            bookEntry({ id: "interview-preparation", title: "Interview preparation", content: "Prepare real examples, key judgments, and lessons for common questions. Explain context, action, result, and reflection. When unsure, state the boundary and give a path to resolve it.", primaryKeys: ["interview", "interview question", "introduction"], secondaryKeys: ["example", "answer", "STAR"] }),
            bookEntry({ id: "application-tracking", title: "Applications and review", content: "Track role, source, version, date, stage, feedback, and next action. Review response, interview, and feedback patterns; do not judge the whole direction from one rejection.", primaryKeys: ["application", "job search", "interview status"], secondaryKeys: ["rejection", "feedback", "review"] }),
          ],
          scanPolicy: { scanDepthMessages: 12, includeParticipantNames: true, tokenBudget: 1900, recursive: true, maxRecursionSteps: 3 },
        },
      },
    },
  },
  {
    id: "world-book-personal-planning",
    version: 1,
    categoryId: "life-management",
    locales: {
      "zh-CN": {
        name: "个人生活规划",
        tagline: "在时间、精力、预算和关系之间做现实安排",
        summary: "适合日程、家务、旅行、预算、健康习惯和个人目标的轻量规划，不把生活变成项目管理表。",
        canonical: {
          name: "个人生活规划",
          entries: [
            bookEntry({ id: "real-constraints", title: "先尊重现实约束", constant: true, content: "规划必须明确可用时间、精力、预算、地点、照护责任和不可移动的承诺。信息不足时先询问或标注假设，不要用理想状态安排现实生活。" }),
            bookEntry({ id: "priority-and-buffer", title: "优先级与缓冲", content: "每个周期只保留少量真正重要的结果，给通勤、准备、恢复和突发情况留缓冲。计划排满不代表计划可靠。", primaryKeys: ["计划", "日程", "优先级", "安排"], secondaryKeys: ["时间", "缓冲", "重要"] }),
            bookEntry({ id: "recurring-maintenance", title: "重复事务", content: "把账单、采购、清洁、预约、证件和定期检查等重复事务设计成低维护清单，注明频率、负责人、完成标准和下次时间。", primaryKeys: ["家务", "账单", "采购", "预约"], secondaryKeys: ["重复", "每周", "每月"] }),
            bookEntry({ id: "health-and-money-boundary", title: "健康与财务边界", content: "涉及诊断、用药、投资、借贷、保险或重大支出时，明确风险和信息缺口，必要时交给合格专业人士。规划建议不能替代医疗或财务意见。", primaryKeys: ["健康", "预算", "保险", "投资"], secondaryKeys: ["医生", "财务", "风险"] }),
          ],
          scanPolicy: { scanDepthMessages: 10, includeParticipantNames: false, tokenBudget: 1700, recursive: true, maxRecursionSteps: 2 },
        },
      },
      en: {
        name: "Personal Life Planning",
        tagline: "Plan realistically across time, energy, money, and relationships",
        summary: "For lightweight planning of schedules, home tasks, travel, budgets, health habits, and personal goals without turning life into a project chart.",
        canonical: {
          name: "Personal Life Planning",
          entries: [
            bookEntry({ id: "real-constraints", title: "Respect real constraints first", constant: true, content: "Plans must account for available time, energy, budget, location, care duties, and fixed commitments. When information is missing, ask or label the assumption instead of planning for an ideal life." }),
            bookEntry({ id: "priority-and-buffer", title: "Priorities and buffer", content: "Keep only a few genuinely important outcomes in each period and protect time for travel, preparation, recovery, and surprises. A full calendar is not a reliable plan.", primaryKeys: ["plan", "schedule", "priority", "arrangement"], secondaryKeys: ["time", "buffer", "important"] }),
            bookEntry({ id: "recurring-maintenance", title: "Recurring maintenance", content: "Turn bills, shopping, cleaning, appointments, documents, and periodic checks into low-maintenance lists with frequency, owner, done definition, and next date.", primaryKeys: ["chore", "bill", "shopping", "appointment"], secondaryKeys: ["recurring", "weekly", "monthly"] }),
            bookEntry({ id: "health-and-money-boundary", title: "Health and money boundaries", content: "For diagnosis, medication, investing, borrowing, insurance, or major spending, state risks and missing information and involve a qualified professional when needed. Planning is not medical or financial advice.", primaryKeys: ["health", "budget", "insurance", "investing"], secondaryKeys: ["doctor", "finance", "risk"] }),
          ],
          scanPolicy: { scanDepthMessages: 10, includeParticipantNames: false, tokenBudget: 1700, recursive: true, maxRecursionSteps: 2 },
        },
      },
    },
  },
]);

const INDUSTRY_WORLD_BOOK_TEMPLATES = Object.freeze([
  {
    id: "world-book-hr-recruiting",
    version: 1,
    categoryId: "human-resources",
    locales: {
      "zh-CN": {
        name: "人力与招聘规范",
        tagline: "让人员决策有证据、有边界、有尊重",
        summary: "覆盖岗位画像、面试评价、员工隐私和沟通边界，减少招聘与组织管理中的主观跳跃。",
        canonical: { name: "人力与招聘规范", entries: [
          bookEntry({ id: "role-evidence", title: "岗位和候选人用证据匹配", constant: true, content: "岗位要求分为必须条件、可培养能力和加分项；候选人评价引用具体经历或面试证据，不用气质、年龄、婚育、地域等受保护或无关特征代替能力判断。", primaryKeys: ["岗位", "候选人", "招聘", "面试"], secondaryKeys: ["能力", "证据", "评价"] }),
          bookEntry({ id: "people-privacy", title: "人员信息最小化", content: "只处理完成当前人力任务所需的个人信息。健康、薪资、身份、家庭和投诉信息必须限权、去标识或交由授权人员处理。", primaryKeys: ["员工信息", "隐私", "薪资", "投诉"], secondaryKeys: ["个人资料", "保密"] }),
          bookEntry({ id: "people-communication", title: "沟通不替人下结论", content: "绩效、反馈、冲突和离职沟通要区分已确认事实、影响、期待行为和后续支持；不代替管理者或员工表达未确认的立场。", primaryKeys: ["绩效反馈", "员工冲突", "离职沟通", "员工关系"], secondaryKeys: ["沟通", "改进"] }),
        ], scanPolicy: { scanDepthMessages: 12, includeParticipantNames: true, tokenBudget: 1800, recursive: true, maxRecursionSteps: 3 } },
      },
      en: {
        name: "HR and Recruiting Rules",
        tagline: "Make people decisions evidence-based, bounded, and respectful",
        summary: "Covers role profiles, interview evidence, employee privacy, and communication boundaries without subjective leaps.",
        canonical: { name: "HR and Recruiting Rules", entries: [
          bookEntry({ id: "role-evidence", title: "Match roles and candidates with evidence", constant: true, content: "Separate must-haves, trainable skills, and nice-to-haves. Ground candidate evaluation in specific experience or interview evidence, never in protected or irrelevant traits such as age, family status, region, or personality vibe.", primaryKeys: ["role", "candidate", "recruiting", "interview"], secondaryKeys: ["skill", "evidence", "score"] }),
          bookEntry({ id: "people-privacy", title: "Minimize people data", content: "Use only personal data needed for the current HR task. Health, pay, identity, family, and complaint data require access control, de-identification, or authorized handling.", primaryKeys: ["employee data", "privacy", "salary", "complaint"], secondaryKeys: ["personal data", "confidential"] }),
          bookEntry({ id: "people-communication", title: "Do not speak for people", content: "Performance, feedback, conflict, and exit communication should separate confirmed facts, impact, expected behavior, and support. Do not assign unconfirmed positions to managers or employees.", primaryKeys: ["performance feedback", "employee conflict", "exit communication", "employee relations"], secondaryKeys: ["communication", "improvement"] }),
        ], scanPolicy: { scanDepthMessages: 12, includeParticipantNames: true, tokenBudget: 1800, recursive: true, maxRecursionSteps: 3 } },
      },
    },
  },
  {
    id: "world-book-software-engineering",
    version: 1,
    categoryId: "technology-engineering",
    locales: {
      "zh-CN": {
        name: "软件工程交付规范",
        tagline: "先定义行为，再用测试和回滚保护交付",
        summary: "把需求、接口、数据、测试、发布和故障恢复组织成可验证的软件工程流程。",
        canonical: { name: "软件工程交付规范", entries: [
          bookEntry({ id: "software-contract", title: "契约和边界优先", constant: true, content: "先写清输入、输出、状态、错误、权限和兼容性，再决定实现。行为变化必须说明影响范围、迁移策略和回滚方式。", primaryKeys: ["API", "接口", "需求", "实现"], secondaryKeys: ["契约", "兼容", "迁移"] }),
          bookEntry({ id: "software-verification", title: "没有验证就不算完成", content: "按风险覆盖主流程、边界、权限、错误、性能和兼容性。区分代码已写、测试已跑、部署已完成和用户已验收。", primaryKeys: ["软件测试", "软件验收", "回归测试", "软件发布"], secondaryKeys: ["验证", "通过", "完成"] }),
          bookEntry({ id: "software-change-safety", title: "变更可观察、可回滚", content: "生产变更前明确备份、监控信号、窗口、责任人和回滚点；故障时先保护数据和用户，再缩小影响、恢复服务并记录复盘。", primaryKeys: ["部署", "上线", "故障", "回滚"], secondaryKeys: ["监控", "恢复", "事故"] }),
        ], scanPolicy: { scanDepthMessages: 14, includeParticipantNames: true, tokenBudget: 2000, recursive: true, maxRecursionSteps: 3 } },
      },
      en: {
        name: "Software Engineering Delivery Rules",
        tagline: "Define behavior first, then protect delivery with tests and rollback",
        summary: "Organizes requirements, APIs, data, tests, release, and recovery into verifiable software delivery.",
        canonical: { name: "Software Engineering Delivery Rules", entries: [
          bookEntry({ id: "software-contract", title: "Contracts and boundaries first", constant: true, content: "Define input, output, state, error, authorization, and compatibility before implementation. Any behavior change must state impact, migration, and rollback.", primaryKeys: ["API", "interface", "requirement", "implementation"], secondaryKeys: ["contract", "compatibility", "migration"] }),
          bookEntry({ id: "software-verification", title: "Unverified is not done", content: "Cover main flow, boundaries, authorization, errors, performance, and compatibility by risk. Separate code written, tests run, deployed, and accepted by users.", primaryKeys: ["software test", "software acceptance", "regression test", "software release"], secondaryKeys: ["verify", "pass", "done"] }),
          bookEntry({ id: "software-change-safety", title: "Changes must be observable and reversible", content: "Before production change, name backup, signals, window, owner, and rollback. During failure, protect data and users first, narrow impact, restore service, and record the review.", primaryKeys: ["deploy", "release", "incident", "rollback"], secondaryKeys: ["monitoring", "recovery", "outage"] }),
        ], scanPolicy: { scanDepthMessages: 14, includeParticipantNames: true, tokenBudget: 2000, recursive: true, maxRecursionSteps: 3 } },
      },
    },
  },
  {
    id: "world-book-cybersecurity",
    version: 1,
    categoryId: "technology-security",
    locales: {
      "zh-CN": {
        name: "网络安全与事件响应",
        tagline: "按资产、证据和影响处理安全风险",
        summary: "提供资产识别、权限、漏洞、事件响应和安全交接规则，避免把防守工作写成攻击指南。",
        canonical: { name: "网络安全与事件响应", entries: [
          bookEntry({ id: "security-authority", title: "授权和影响先于技术动作", constant: true, content: "安全分析只在明确授权和防守目的下进行。先确认资产、范围、数据敏感度和潜在影响；不提供入侵、绕过、窃取或持久化操作。", primaryKeys: ["网络安全", "安全漏洞", "渗透测试", "网络攻击"], secondaryKeys: ["授权", "资产", "影响"] }),
          bookEntry({ id: "security-evidence", title: "事件结论必须可追溯", content: "区分日志事实、可疑信号、推断攻击路径和未知项。保留时间线、证据来源、处置动作和证据完整性，不用单条告警直接定性。", primaryKeys: ["事件", "日志", "告警", "证据"], secondaryKeys: ["时间线", "取证", "可疑"] }),
          bookEntry({ id: "security-response", title: "先遏制再恢复", content: "真实事件优先隔离影响、保护凭证和数据、通知授权响应团队，再进行恢复、根因分析和防复发。严重事件不要只在聊天中处理。", primaryKeys: ["响应", "泄露", "入侵", "隔离"], secondaryKeys: ["恢复", "凭证", "升级"] }),
        ], scanPolicy: { scanDepthMessages: 12, includeParticipantNames: true, tokenBudget: 1900, recursive: true, maxRecursionSteps: 3 } },
      },
      en: {
        name: "Cybersecurity and Incident Response",
        tagline: "Handle security risk by asset, evidence, and impact",
        summary: "Provides defensive rules for assets, access, vulnerabilities, incidents, and handoff without turning defense into attack guidance.",
        canonical: { name: "Cybersecurity and Incident Response", entries: [
          bookEntry({ id: "security-authority", title: "Authority and impact before technical action", constant: true, content: "Perform security analysis only with clear authorization and defensive purpose. Confirm asset, scope, data sensitivity, and impact first; do not provide intrusion, bypass, theft, or persistence instructions.", primaryKeys: ["cybersecurity", "security vulnerability", "penetration test", "network attack"], secondaryKeys: ["authorization", "asset", "impact"] }),
          bookEntry({ id: "security-evidence", title: "Incident claims must be traceable", content: "Separate log facts, suspicious signals, inferred attack paths, and unknowns. Preserve timeline, source, action, and evidence integrity; never classify an incident from one alert alone.", primaryKeys: ["incident", "log", "alert", "evidence"], secondaryKeys: ["timeline", "forensics", "suspicious"] }),
          bookEntry({ id: "security-response", title: "Contain before recovery", content: "For a real incident, isolate impact, protect credentials and data, and notify the authorized response team before recovery, root cause, and prevention. Serious incidents do not belong only in chat.", primaryKeys: ["response", "breach", "intrusion", "contain"], secondaryKeys: ["recovery", "credential", "escalate"] }),
        ], scanPolicy: { scanDepthMessages: 12, includeParticipantNames: true, tokenBudget: 1900, recursive: true, maxRecursionSteps: 3 } },
      },
    },
  },
  {
    id: "world-book-data-ai",
    version: 1,
    categoryId: "data-ai",
    locales: {
      "zh-CN": {
        name: "数据与 AI 生产规范",
        tagline: "让数据、模型和结论都可复核",
        summary: "覆盖指标、数据质量、偏差、实验、模型评估和上线监控，避免把预测包装成事实。",
        canonical: { name: "数据与 AI 生产规范", entries: [
          bookEntry({ id: "data-definition", title: "先定义指标和用途", constant: true, content: "每个指标、标签和模型输出都要说明定义、时间范围、样本、用途和不适用场景。业务问题不清楚时，先确认要支持什么决策。", primaryKeys: ["指标", "数据", "模型", "AI"], secondaryKeys: ["定义", "标签", "样本"] }),
          bookEntry({ id: "data-quality-bias", title: "质量、偏差和泄漏必须显式", content: "检查缺失、重复、口径漂移、选择偏差、标签泄漏、隐私和代表性。发现数据限制时，缩小结论范围而不是补写数据。", primaryKeys: ["数据质量", "偏差", "泄漏", "训练"], secondaryKeys: ["缺失", "代表性", "隐私"] }),
          bookEntry({ id: "ai-evaluation", title: "评估与上线不是一回事", content: "区分离线指标、线上指标、人工评价、成本、延迟、安全和失败降级。模型或 AI 输出必须保留不确定性、人工复核和回滚路径。", primaryKeys: ["评估", "上线", "准确率", "效果"], secondaryKeys: ["监控", "漂移", "人工复核"] }),
        ], scanPolicy: { scanDepthMessages: 12, includeParticipantNames: false, tokenBudget: 2000, recursive: true, maxRecursionSteps: 3 } },
      },
      en: {
        name: "Data and AI Production Rules",
        tagline: "Make data, models, and findings reviewable",
        summary: "Covers metrics, data quality, bias, experiments, model evaluation, and monitoring without turning predictions into facts.",
        canonical: { name: "Data and AI Production Rules", entries: [
          bookEntry({ id: "data-definition", title: "Define metric and use first", constant: true, content: "Every metric, label, and model output needs definition, date range, sample, decision use, and non-use. When the business question is unclear, confirm the decision it should support.", primaryKeys: ["metric", "data", "model", "AI"], secondaryKeys: ["definition", "label", "sample"] }),
          bookEntry({ id: "data-quality-bias", title: "Make quality, bias, and leakage explicit", content: "Check missingness, duplicates, definition drift, selection bias, label leakage, privacy, and representation. When data is limited, narrow the claim instead of filling the gap.", primaryKeys: ["data quality", "bias", "leakage", "training"], secondaryKeys: ["missing", "representation", "privacy"] }),
          bookEntry({ id: "ai-evaluation", title: "Evaluation is not deployment", content: "Separate offline, online, human, cost, latency, safety, and fallback signals. AI output needs uncertainty, human review, and rollback paths.", primaryKeys: ["evaluation", "deploy", "accuracy", "performance"], secondaryKeys: ["monitoring", "drift", "human review"] }),
        ], scanPolicy: { scanDepthMessages: 12, includeParticipantNames: false, tokenBudget: 2000, recursive: true, maxRecursionSteps: 3 } },
      },
    },
  },
  {
    id: "world-book-design-engineering",
    version: 1,
    categoryId: "design-engineering",
    locales: {
      "zh-CN": {
        name: "设计与工程交接规范",
        tagline: "让方案既好用，也能被实现和验收",
        summary: "覆盖用户任务、约束、方案取舍、状态、尺寸、材料和交接，连接创意与落地。",
        canonical: { name: "设计与工程交接规范", entries: [
          bookEntry({ id: "design-context", title: "场景和约束先于风格", constant: true, content: "先说明谁在什么场景完成什么任务，以及平台、尺寸、材料、法规、成本和时间约束。视觉或形式选择不能替代使用目标。", primaryKeys: ["设计", "方案", "用户", "工程"], secondaryKeys: ["场景", "约束", "需求"] }),
          bookEntry({ id: "design-states", title: "完整表达状态和例外", content: "交付至少考虑默认、空、加载、错误、权限、极端尺寸和失败恢复状态。工程方案要注明接口、容差、依赖和不可变条件。", primaryKeys: ["状态", "交互", "图纸", "规格"], secondaryKeys: ["空状态", "错误", "尺寸"] }),
          bookEntry({ id: "design-review", title: "评审要落到证据", content: "评审意见指向任务、可用性、可实施性、成本、安全或一致性，不把个人偏好写成用户事实；修改保留理由和影响。", primaryKeys: ["设计评审", "设计验收", "设计交接", "设计修改"], secondaryKeys: ["可用性", "可实施", "取舍"] }),
        ], scanPolicy: { scanDepthMessages: 12, includeParticipantNames: true, tokenBudget: 1800, recursive: true, maxRecursionSteps: 3 } },
      },
      en: {
        name: "Design and Engineering Handoff Rules",
        tagline: "Make solutions usable, buildable, and testable",
        summary: "Connects user task, constraints, trade-offs, states, dimensions, materials, and handoff from concept to delivery.",
        canonical: { name: "Design and Engineering Handoff Rules", entries: [
          bookEntry({ id: "design-context", title: "Context and constraints before style", constant: true, content: "State who completes what task in which context, plus platform, dimension, material, rule, cost, and time constraints. Form cannot replace use goal.", primaryKeys: ["design", "solution", "user", "engineering"], secondaryKeys: ["context", "constraint", "requirement"] }),
          bookEntry({ id: "design-states", title: "Express states and exceptions", content: "Cover default, empty, loading, error, authorization, extreme size, and recovery states. Engineering handoff names API, tolerance, dependency, and immutable conditions.", primaryKeys: ["state", "interaction", "drawing", "specification"], secondaryKeys: ["empty", "error", "dimension"] }),
          bookEntry({ id: "design-review", title: "Reviews land on evidence", content: "Review feedback should address task, usability, feasibility, cost, safety, or consistency, not turn preference into user fact. Preserve rationale and impact of changes.", primaryKeys: ["design review", "design acceptance", "design handoff", "design revision"], secondaryKeys: ["usability", "feasible", "trade-off"] }),
        ], scanPolicy: { scanDepthMessages: 12, includeParticipantNames: true, tokenBudget: 1800, recursive: true, maxRecursionSteps: 3 } },
      },
    },
  },
  {
    id: "world-book-education-training",
    version: 1,
    categoryId: "education-training",
    locales: {
      "zh-CN": {
        name: "教育与培训设计",
        tagline: "从学习目标出发设计解释、练习和反馈",
        summary: "适用于课程、培训、辅导和知识产品，强调学习者基础、可观察结果和真实练习。",
        canonical: { name: "教育与培训设计", entries: [
          bookEntry({ id: "learning-outcome", title: "目标必须可观察", constant: true, content: "把学习目标写成学习者能做出的可观察行为，再反推内容、练习、反馈和评价。不要用‘了解’‘掌握’等空泛词替代可验证结果。", primaryKeys: ["学习目标", "课程", "培训", "教学"], secondaryKeys: ["结果", "评价", "练习"] }),
          bookEntry({ id: "learner-fit", title: "先匹配基础和场景", content: "讲解前确认学习者已有知识、语言、时间、设备和实际任务。发现误解时先纠正前提，不用更复杂的术语掩盖理解缺口。", primaryKeys: ["基础", "学习者", "辅导", "课程设计"], secondaryKeys: ["先备知识", "难点", "误解"] }),
          bookEntry({ id: "learning-feedback", title: "反馈应该指导下一次尝试", content: "反馈指出具体错误、原因、修正方式和下一次练习，不只给分数或泛泛表扬。区分练习答案、正式评价和尚未验证的能力。", primaryKeys: ["学习反馈", "作业反馈", "考试复盘", "练习反馈"], secondaryKeys: ["纠错", "复习", "评价"] }),
        ], scanPolicy: { scanDepthMessages: 14, includeParticipantNames: false, tokenBudget: 1800, recursive: true, maxRecursionSteps: 3 } },
      },
      en: {
        name: "Education and Training Design",
        tagline: "Design explanation, practice, and feedback from the learning goal",
        summary: "For courses, training, tutoring, and knowledge products with learner baseline, observable outcomes, and real practice.",
        canonical: { name: "Education and Training Design", entries: [
          bookEntry({ id: "learning-outcome", title: "Outcomes must be observable", constant: true, content: "Write what the learner can do, then back-plan content, practice, feedback, and assessment. Do not replace a verifiable result with vague words such as understand or master.", primaryKeys: ["learning goal", "course", "training", "teaching"], secondaryKeys: ["outcome", "assessment", "practice"] }),
          bookEntry({ id: "learner-fit", title: "Fit the baseline and context", content: "Check prior knowledge, language, time, device, and real task before explaining. Correct a misconception at the prerequisite rather than hiding the gap in harder terminology.", primaryKeys: ["baseline", "learner", "tutoring", "curriculum"], secondaryKeys: ["prerequisite", "hard point", "misconception"] }),
          bookEntry({ id: "learning-feedback", title: "Feedback guides the next attempt", content: "Name the specific error, cause, correction, and next practice rather than only a score or praise. Separate practice answer, formal assessment, and unverified ability.", primaryKeys: ["learning feedback", "homework feedback", "exam review", "practice feedback"], secondaryKeys: ["correction", "review", "assessment"] }),
        ], scanPolicy: { scanDepthMessages: 14, includeParticipantNames: false, tokenBudget: 1800, recursive: true, maxRecursionSteps: 3 } },
      },
    },
  },
  {
    id: "world-book-healthcare-operations",
    version: 1,
    categoryId: "healthcare",
    locales: {
      "zh-CN": {
        name: "医疗健康安全规范",
        tagline: "区分健康教育、流程支持和临床判断",
        summary: "帮助整理就医流程、隐私、症状信息和升级条件，明确 AI 不替代医生或急救系统。",
        canonical: { name: "医疗健康安全规范", entries: [
          bookEntry({ id: "health-boundary", title: "不诊断、不处方、不拖延急救", constant: true, content: "一般健康信息只能作为教育和准备，不得写成确定诊断、治疗或药物指令。急性、严重、快速恶化或无法判断的情况应立即联系当地急救或医疗机构。", primaryKeys: ["症状", "诊断", "用药", "医疗"], secondaryKeys: ["急症", "医生", "治疗"] }),
          bookEntry({ id: "health-privacy", title: "健康信息最小化和去识别", content: "只使用完成流程所需的健康资料，避免重复传播姓名、身份证、病历号和可识别细节。涉及他人健康信息时先确认授权。", primaryKeys: ["病历", "隐私", "患者", "检查报告"], secondaryKeys: ["授权", "去标识", "保密"] }),
          bookEntry({ id: "health-questions", title: "把问题交给合适的专业人员", content: "帮助用户整理症状时间线、已用药物、检查结果和要问医生的问题；不能从缺少体检、影像或化验的信息中推断病因。", primaryKeys: ["就医", "问诊", "检查", "报告"], secondaryKeys: ["时间线", "资料", "复诊"] }),
        ], scanPolicy: { scanDepthMessages: 10, includeParticipantNames: false, tokenBudget: 1900, recursive: true, maxRecursionSteps: 2 } },
      },
      en: {
        name: "Healthcare Safety Rules",
        tagline: "Separate health education, navigation, and clinical judgment",
        summary: "Supports care navigation, privacy, symptom organization, and escalation while making clear that AI does not replace clinicians or emergency services.",
        canonical: { name: "Healthcare Safety Rules", entries: [
          bookEntry({ id: "health-boundary", title: "No diagnosis, prescription, or delayed emergency care", constant: true, content: "General health information is for education and preparation, never a definitive diagnosis, treatment, or medication instruction. Acute, serious, rapidly worsening, or unclear situations need local emergency or medical care now.", primaryKeys: ["symptom", "diagnosis", "medication", "medical"], secondaryKeys: ["emergency", "doctor", "treatment"] }),
          bookEntry({ id: "health-privacy", title: "Minimize and de-identify health data", content: "Use only health data needed for the process and avoid repeating names, identity numbers, record numbers, or identifying details. Confirm authorization for another person's data.", primaryKeys: ["medical record", "privacy", "patient", "test report"], secondaryKeys: ["authorization", "de-identify", "confidential"] }),
          bookEntry({ id: "health-questions", title: "Route questions to the right professional", content: "Help organize symptom timeline, medication, results, and questions for a clinician; do not infer cause without examination, imaging, or laboratory context.", primaryKeys: ["care", "visit", "test", "report"], secondaryKeys: ["timeline", "material", "follow-up"] }),
        ], scanPolicy: { scanDepthMessages: 10, includeParticipantNames: false, tokenBudget: 1900, recursive: true, maxRecursionSteps: 2 } },
      },
    },
  },
  {
    id: "world-book-legal-compliance",
    version: 1,
    categoryId: "legal-compliance",
    locales: {
      "zh-CN": {
        name: "法律与合规工作台",
        tagline: "把辖区、时点、依据和交接说清楚",
        summary: "适用于合同、政策、合规和法律研究准备，严格区分材料事实、规则、分析和正式意见。",
        canonical: { name: "法律与合规工作台", entries: [
          bookEntry({ id: "legal-jurisdiction", title: "先确认适用辖区和时点", constant: true, content: "法律结论必须说明适用司法辖区、法规版本或材料时点、事实前提和问题范围。辖区不明、跨境或规则可能变动时不得直接下确定结论。", primaryKeys: ["法律", "合同", "合规", "法规"], secondaryKeys: ["辖区", "时点", "适用"] }),
          bookEntry({ id: "legal-evidence", title: "事实、规则、分析分层", content: "逐项标出用户材料中的事实、可核验的规则依据、基于事实的分析和待补材料。不得把搜索摘要、模板条款或模型记忆当成当前法律依据。", primaryKeys: ["条款", "依据", "事实", "风险"], secondaryKeys: ["证据", "分析", "待确认"] }),
          bookEntry({ id: "legal-escalation", title: "重大事项交专业人士", content: "诉讼、刑事风险、不可逆期限、重大交易、监管调查、跨境数据和事实不足事项必须提示持证律师或合规负责人复核。", primaryKeys: ["诉讼", "刑事", "监管", "期限"], secondaryKeys: ["律师", "调查", "交接"] }),
        ], scanPolicy: { scanDepthMessages: 12, includeParticipantNames: true, tokenBudget: 1900, recursive: true, maxRecursionSteps: 3 } },
      },
      en: {
        name: "Legal and Compliance Workbench",
        tagline: "Make jurisdiction, date, authority, and handoff explicit",
        summary: "For contract, policy, compliance, and legal research preparation with strict separation of fact, rule, analysis, and formal opinion.",
        canonical: { name: "Legal and Compliance Workbench", entries: [
          bookEntry({ id: "legal-jurisdiction", title: "Confirm jurisdiction and date first", constant: true, content: "A legal conclusion must state jurisdiction, rule version or material date, factual premise, and issue scope. Do not conclude when jurisdiction is unclear, cross-border, or likely to change.", primaryKeys: ["legal", "contract", "compliance", "regulation"], secondaryKeys: ["jurisdiction", "date", "applicable"] }),
          bookEntry({ id: "legal-evidence", title: "Layer fact, rule, and analysis", content: "Label facts from user material, verifiable authority, analysis from those facts, and missing material. Search snippets, template clauses, and model memory are not current authority.", primaryKeys: ["clause", "authority", "fact", "risk"], secondaryKeys: ["evidence", "analysis", "open question"] }),
          bookEntry({ id: "legal-escalation", title: "Escalate material matters", content: "Litigation, criminal exposure, irreversible deadlines, major transactions, regulatory investigation, cross-border data, and incomplete facts require licensed counsel or compliance review.", primaryKeys: ["litigation", "criminal", "regulatory", "deadline"], secondaryKeys: ["lawyer", "investigation", "handoff"] }),
        ], scanPolicy: { scanDepthMessages: 12, includeParticipantNames: true, tokenBudget: 1900, recursive: true, maxRecursionSteps: 3 } },
      },
    },
  },
  {
    id: "world-book-finance-accounting",
    version: 1,
    categoryId: "finance-accounting",
    locales: {
      "zh-CN": {
        name: "财务与会计运营",
        tagline: "让数字有期间、有凭证、有解释",
        summary: "覆盖预算、现金流、对账、报表、税务边界和财务决策中的假设与风险。",
        canonical: { name: "财务与会计运营", entries: [
          bookEntry({ id: "finance-source", title: "数字必须带口径和来源", constant: true, content: "金额必须说明币种、期间、含税与否、来源、确认状态和计算方式。估算、预测、会计确认和实际发生不能混为一谈。", primaryKeys: ["预算", "现金流", "报表", "金额"], secondaryKeys: ["期间", "币种", "凭证"] }),
          bookEntry({ id: "finance-reconcile", title: "先对账再解释", content: "财务差异先与原始凭证、银行、订单、发票或系统记录核对，保留调整轨迹和待确认项，不用合理故事替代证据。", primaryKeys: ["对账", "差异", "凭证", "发票"], secondaryKeys: ["核对", "调整", "原始记录"] }),
          bookEntry({ id: "finance-advice-boundary", title: "投资、税务和信贷有专业边界", content: "涉及投资、借贷、税务申报、保险或重大支出时，明确假设、风险和信息缺口，不保证收益或结果，并建议持牌专业人士复核。", primaryKeys: ["投资", "税务", "借贷", "保险"], secondaryKeys: ["收益", "风险", "会计师"] }),
        ], scanPolicy: { scanDepthMessages: 12, includeParticipantNames: false, tokenBudget: 1800, recursive: true, maxRecursionSteps: 2 } },
      },
      en: {
        name: "Finance and Accounting Operations",
        tagline: "Give every number a period, source, and explanation",
        summary: "Covers budgets, cash flow, reconciliation, statements, tax boundaries, and assumptions in financial decisions.",
        canonical: { name: "Finance and Accounting Operations", entries: [
          bookEntry({ id: "finance-source", title: "Numbers need scope and source", constant: true, content: "Every amount states currency, period, tax treatment, source, confirmation status, and calculation. Estimate, forecast, accounting recognition, and actual occurrence are different.", primaryKeys: ["budget", "cash flow", "statement", "amount"], secondaryKeys: ["period", "currency", "evidence"] }),
          bookEntry({ id: "finance-reconcile", title: "Reconcile before explaining", content: "Check a variance against source evidence, bank, order, invoice, or system record first. Preserve adjustment trail and open items; do not replace evidence with a plausible story.", primaryKeys: ["reconcile", "variance", "evidence", "invoice"], secondaryKeys: ["check", "adjustment", "source"] }),
          bookEntry({ id: "finance-advice-boundary", title: "Investment, tax, and credit have professional boundaries", content: "For investing, borrowing, tax filing, insurance, or major spending, state assumptions, risk, and missing information; do not guarantee return or outcome and suggest licensed review.", primaryKeys: ["investing", "tax", "credit", "insurance"], secondaryKeys: ["return", "risk", "accountant"] }),
        ], scanPolicy: { scanDepthMessages: 12, includeParticipantNames: false, tokenBudget: 1800, recursive: true, maxRecursionSteps: 2 } },
      },
    },
  },
  {
    id: "world-book-property-construction",
    version: 1,
    categoryId: "property-construction",
    locales: {
      "zh-CN": {
        name: "地产与建设项目",
        tagline: "把物业事实、图纸、合同和现场变更分开管理",
        summary: "适用于买卖租赁、建设协调和项目验收，强调时点、来源、责任和现场专业复核。",
        canonical: { name: "地产与建设项目", entries: [
          bookEntry({ id: "property-facts", title: "物业和现场事实要有时点", constant: true, content: "价格、租金、产权、面积、许可、图纸、进度和现场状态都可能变化。记录来源和日期，不把估算或中介陈述当成已核验事实。", primaryKeys: ["房产", "物业", "图纸", "现场"], secondaryKeys: ["产权", "价格", "面积"] }),
          bookEntry({ id: "construction-change", title: "变更必须有影响和责任", content: "每项变更记录原因、位置、责任方、成本、工期、质量和审批状态。没有确认的变更不能直接写入最终计划或验收结论。", primaryKeys: ["工程变更", "施工计划", "工期变更", "工程验收"], secondaryKeys: ["成本", "责任", "审批"] }),
          bookEntry({ id: "property-professional", title: "安全、结构、许可交专业人员", content: "结构、消防、电气、施工安全、产权和正式合同问题不能靠一般建议定案；发现重大风险时交给当地合格工程师、律师或主管机构。", primaryKeys: ["结构安全", "消防许可", "施工安全", "产权许可"], secondaryKeys: ["工程师", "律师", "复核"] }),
        ], scanPolicy: { scanDepthMessages: 12, includeParticipantNames: true, tokenBudget: 1900, recursive: true, maxRecursionSteps: 3 } },
      },
      en: {
        name: "Property and Construction Projects",
        tagline: "Separate property facts, drawings, contracts, and field changes",
        summary: "For buying, renting, construction coordination, and acceptance with dated sources, ownership, and professional field review.",
        canonical: { name: "Property and Construction Projects", entries: [
          bookEntry({ id: "property-facts", title: "Property and field facts need a date", constant: true, content: "Price, rent, title, area, permits, drawings, schedule, and field status change. Record source and date; do not treat estimates or agent statements as verified fact.", primaryKeys: ["property", "real estate", "drawing", "site"], secondaryKeys: ["title", "price", "area"] }),
          bookEntry({ id: "construction-change", title: "Changes need impact and ownership", content: "Record reason, location, party, cost, schedule, quality, and approval for every change. Unconfirmed changes do not belong in the final plan or acceptance conclusion.", primaryKeys: ["construction change", "construction plan", "schedule change", "construction acceptance"], secondaryKeys: ["cost", "owner", "approval"] }),
          bookEntry({ id: "property-professional", title: "Safety, structure, and permits go to professionals", content: "Structural, fire, electrical, construction safety, title, and formal contract decisions need local qualified engineers, counsel, or authorities when material risk appears.", primaryKeys: ["structural safety", "fire permit", "construction safety", "title permit"], secondaryKeys: ["engineer", "lawyer", "review"] }),
        ], scanPolicy: { scanDepthMessages: 12, includeParticipantNames: true, tokenBudget: 1900, recursive: true, maxRecursionSteps: 3 } },
      },
    },
  },
  {
    id: "world-book-manufacturing-supply-chain",
    version: 1,
    categoryId: "manufacturing-supply",
    locales: {
      "zh-CN": {
        name: "制造与供应链控制",
        tagline: "让批次、库存、质量和异常都可追踪",
        summary: "覆盖排产、采购、库存、供应商、质量、交付和异常闭环，适合生产与物流协作。",
        canonical: { name: "制造与供应链控制", entries: [
          bookEntry({ id: "supply-traceability", title: "批次、数量和时间要可追踪", constant: true, content: "订单、物料、批次、库存、供应商、运输和交付记录要能互相追溯。缺少来源或口径时标注未知，不用计划数字冒充现场事实。", primaryKeys: ["库存", "物料", "批次", "交付"], secondaryKeys: ["数量", "供应商", "运输"] }),
          bookEntry({ id: "supply-quality", title: "异常先隔离再分析", content: "质量或供应异常先明确影响范围、隔离动作和通知对象，再分析根因、替代方案和复发预防。纠正动作必须有关闭证据。", primaryKeys: ["异常", "质量", "缺料", "供应商"], secondaryKeys: ["隔离", "根因", "CAPA"] }),
          bookEntry({ id: "supply-plan", title: "计划是方案，不是已交付", content: "排产、预测、交期和补货建议都要说明假设、置信度、瓶颈和替代选项。变更时更新责任人、时间和影响。", primaryKeys: ["排产", "预测", "补货", "交期"], secondaryKeys: ["产能", "瓶颈", "替代"] }),
        ], scanPolicy: { scanDepthMessages: 14, includeParticipantNames: true, tokenBudget: 1900, recursive: true, maxRecursionSteps: 3 } },
      },
      en: {
        name: "Manufacturing and Supply Chain Controls",
        tagline: "Make batches, inventory, quality, and exceptions traceable",
        summary: "Covers scheduling, purchasing, inventory, suppliers, quality, delivery, and closed-loop exceptions for production and logistics.",
        canonical: { name: "Manufacturing and Supply Chain Controls", entries: [
          bookEntry({ id: "supply-traceability", title: "Batch, quantity, and time must trace", constant: true, content: "Orders, material, batch, inventory, vendor, transport, and delivery records should trace to one another. Label unknown source or scope; never turn a plan into field fact.", primaryKeys: ["inventory", "material", "batch", "delivery"], secondaryKeys: ["quantity", "vendor", "transport"] }),
          bookEntry({ id: "supply-quality", title: "Contain exceptions before analysis", content: "For quality or supply exceptions, state impact, containment, and notification first, then root cause, alternatives, and prevention. Corrective action needs closure evidence.", primaryKeys: ["exception", "quality", "shortage", "supplier"], secondaryKeys: ["containment", "root cause", "CAPA"] }),
          bookEntry({ id: "supply-plan", title: "A plan is not delivery", content: "Schedules, forecasts, lead times, and replenishment state assumptions, confidence, bottlenecks, and alternatives. When changed, update owner, timing, and impact.", primaryKeys: ["schedule", "forecast", "replenishment", "lead time"], secondaryKeys: ["capacity", "bottleneck", "alternative"] }),
        ], scanPolicy: { scanDepthMessages: 14, includeParticipantNames: true, tokenBudget: 1900, recursive: true, maxRecursionSteps: 3 } },
      },
    },
  },
  {
    id: "world-book-commerce-sales-customer",
    version: 1,
    categoryId: "commerce-customer",
    locales: {
      "zh-CN": {
        name: "商业、销售与客户成功",
        tagline: "把客户问题、价值、承诺和结果分开",
        summary: "适用于销售、电商、客户成功和服务运营，减少夸大承诺、错配需求和数据误读。",
        canonical: { name: "商业、销售与客户成功", entries: [
          bookEntry({ id: "customer-problem", title: "先确认客户问题和成功", constant: true, content: "先确认客户要解决的问题、当前替代方式、决策人、时间、预算和成功指标。没有这些信息时，建议必须标注为假设。", primaryKeys: ["客户", "需求", "销售", "成功"], secondaryKeys: ["预算", "决策人", "指标"] }),
          bookEntry({ id: "commercial-claims", title: "商业主张要有证据和范围", content: "产品能力、价格、案例、销量、折扣、交付时间和效果承诺必须来自已确认资料，并说明适用版本、条件和限制。", primaryKeys: ["报价", "案例", "产品能力", "承诺"], secondaryKeys: ["价格", "折扣", "交付"] }),
          bookEntry({ id: "customer-health", title: "用行为和反馈判断健康度", content: "客户健康度结合使用证据、目标进展、支持记录、反馈和续约风险，不用一次情绪或一次拒绝代表全部关系。", primaryKeys: ["客户成功", "客户续约", "客户流失", "客户反馈"], secondaryKeys: ["采用", "健康度", "复盘"] }),
        ], scanPolicy: { scanDepthMessages: 12, includeParticipantNames: true, tokenBudget: 1800, recursive: true, maxRecursionSteps: 3 } },
      },
      en: {
        name: "Commerce, Sales, and Customer Success",
        tagline: "Separate customer problem, value, commitment, and outcome",
        summary: "For sales, e-commerce, customer success, and service operations without overpromising or misreading data.",
        canonical: { name: "Commerce, Sales, and Customer Success", entries: [
          bookEntry({ id: "customer-problem", title: "Confirm customer problem and success first", constant: true, content: "Confirm problem, current alternative, decision maker, timing, budget, and success metric before proposing. Without them, label advice as a hypothesis.", primaryKeys: ["customer", "need", "sales", "success"], secondaryKeys: ["budget", "decision maker", "metric"] }),
          bookEntry({ id: "commercial-claims", title: "Commercial claims need evidence and scope", content: "Capability, price, case, sales, discount, delivery date, and outcome promises must come from confirmed material with version, condition, and limit.", primaryKeys: ["quote", "case study", "capability", "commitment"], secondaryKeys: ["price", "discount", "delivery"] }),
          bookEntry({ id: "customer-health", title: "Judge health from behavior and feedback", content: "Customer health combines usage evidence, goal progress, support record, feedback, and renewal risk; one emotion or rejection does not represent the whole relationship.", primaryKeys: ["customer success", "customer renewal", "customer churn", "customer feedback"], secondaryKeys: ["adoption", "health", "review"] }),
        ], scanPolicy: { scanDepthMessages: 12, includeParticipantNames: true, tokenBudget: 1800, recursive: true, maxRecursionSteps: 3 } },
      },
    },
  },
  {
    id: "world-book-hospitality-events",
    version: 1,
    categoryId: "hospitality-events",
    locales: {
      "zh-CN": {
        name: "餐旅与活动运营",
        tagline: "把体验、容量、供应商和应急方案放在一起",
        summary: "适用于旅行、酒店、餐饮和活动，强调实时信息、容量、安全、服务和现场责任。",
        canonical: { name: "餐旅与活动运营", entries: [
          bookEntry({ id: "hospitality-facts", title: "实时信息必须核验", constant: true, content: "价格、营业时间、库存、交通、签证、天气、场地容量和安全规则都可能变化。出行或活动前核对官方或供应商来源和更新时间。", primaryKeys: ["旅行", "酒店", "餐饮", "活动"], secondaryKeys: ["价格", "预订", "天气"] }),
          bookEntry({ id: "hospitality-runbook", title: "现场流程要有负责人和切换点", content: "行程或活动表记录时间、地点、负责人、依赖、服务标准、设备、嘉宾和替代方案；关键节点不能只依赖口头沟通。", primaryKeys: ["旅行行程", "活动流程", "现场运营", "服务排班"], secondaryKeys: ["负责人", "供应商", "备用"] }),
          bookEntry({ id: "hospitality-safety", title: "安全和可及性优先", content: "人群容量、消防、食品卫生、无障碍、天气、取消和医疗应急需要提前评估；超出组织权限或专业能力时升级。", primaryKeys: ["活动安全", "场地容量", "食品卫生", "活动无障碍"], secondaryKeys: ["消防", "应急", "取消"] }),
        ], scanPolicy: { scanDepthMessages: 12, includeParticipantNames: true, tokenBudget: 1800, recursive: true, maxRecursionSteps: 3 } },
      },
      en: {
        name: "Hospitality and Event Operations",
        tagline: "Put experience, capacity, vendors, and contingency together",
        summary: "For travel, hotels, food service, and events with current information, capacity, safety, service, and field ownership.",
        canonical: { name: "Hospitality and Event Operations", entries: [
          bookEntry({ id: "hospitality-facts", title: "Verify current information", constant: true, content: "Price, hours, availability, transport, visa, weather, venue capacity, and safety rules change. Verify official or vendor sources and update time before travel or events.", primaryKeys: ["travel", "hotel", "food", "event"], secondaryKeys: ["price", "booking", "weather"] }),
          bookEntry({ id: "hospitality-runbook", title: "Live flow needs owners and transitions", content: "Itinerary or run sheet records time, place, owner, dependency, service standard, equipment, guest, and alternative. Critical nodes cannot depend on verbal coordination alone.", primaryKeys: ["travel itinerary", "event flow", "live operations", "service roster"], secondaryKeys: ["owner", "vendor", "backup"] }),
          bookEntry({ id: "hospitality-safety", title: "Safety and accessibility come first", content: "Assess capacity, fire, food hygiene, accessibility, weather, cancellation, and medical contingency early. Escalate beyond authority or professional capability.", primaryKeys: ["event safety", "venue capacity", "food hygiene", "event accessibility"], secondaryKeys: ["fire", "emergency", "cancellation"] }),
        ], scanPolicy: { scanDepthMessages: 12, includeParticipantNames: true, tokenBudget: 1800, recursive: true, maxRecursionSteps: 3 } },
      },
    },
  },
  {
    id: "world-book-public-nonprofit-agriculture",
    version: 1,
    categoryId: "public-nonprofit-agriculture",
    locales: {
      "zh-CN": {
        name: "公共、公益与农业项目",
        tagline: "让公共目标、资源、现场证据和公平影响对齐",
        summary: "覆盖公益项目、公共服务、资助申请和农业现场工作的通用规则，强调受益对象、问责和安全。",
        canonical: { name: "公共、公益与农业项目", entries: [
          bookEntry({ id: "public-beneficiary", title: "先确认服务对象和授权边界", constant: true, content: "公共或公益工作先说明服务对象、实际需求、授权范围和不可替代的专业责任。组织目标、资助方目标和受益人需求不自动等同。", primaryKeys: ["公益", "公共服务", "受益人", "农业项目"], secondaryKeys: ["目标", "授权", "需求"] }),
          bookEntry({ id: "public-evidence", title: "影响和产量必须可追溯", content: "项目效果、受益人数、产量、食品质量、资金使用和政策结果需要来源、时间点和口径。个案或现场记录缺失时缩小结论。", primaryKeys: ["影响", "产量", "资助", "项目报告"], secondaryKeys: ["指标", "记录", "证据"] }),
          bookEntry({ id: "public-safety-equity", title: "公平、安全和问责不能省略", content: "检查服务可及性、资源分配、隐私、食品或现场安全、投诉渠道和资金责任。涉及儿童、弱势群体、食品或公共安全时提高升级等级。", primaryKeys: ["服务公平", "公共安全", "公共投诉", "资金问责"], secondaryKeys: ["儿童", "弱势", "食品"] }),
        ], scanPolicy: { scanDepthMessages: 12, includeParticipantNames: true, tokenBudget: 1900, recursive: true, maxRecursionSteps: 3 } },
      },
      en: {
        name: "Public, Nonprofit, and Agriculture Programs",
        tagline: "Align public goal, resources, field evidence, and equity",
        summary: "Shared rules for nonprofit programs, public service, grants, and field agriculture with beneficiary focus, accountability, and safety.",
        canonical: { name: "Public, Nonprofit, and Agriculture Programs", entries: [
          bookEntry({ id: "public-beneficiary", title: "Confirm beneficiary and mandate boundary", constant: true, content: "Public and nonprofit work states beneficiary, actual need, mandate, and irreplaceable professional duty. Organizational and funder goals are not automatically beneficiary needs.", primaryKeys: ["nonprofit", "public service", "beneficiary", "agriculture program"], secondaryKeys: ["goal", "mandate", "need"] }),
          bookEntry({ id: "public-evidence", title: "Impact and yield must trace", content: "Impact, beneficiary count, yield, food quality, funding use, and policy results need source, date, and scope. Narrow the claim when case or field records are missing.", primaryKeys: ["impact", "yield", "grant", "program report"], secondaryKeys: ["metric", "record", "evidence"] }),
          bookEntry({ id: "public-safety-equity", title: "Do not skip equity, safety, or accountability", content: "Check access, resource allocation, privacy, food or field safety, complaint channel, and funding accountability. Raise escalation for children, vulnerable groups, food, or public safety.", primaryKeys: ["service equity", "public safety", "public complaint", "funding accountability"], secondaryKeys: ["children", "vulnerable", "food"] }),
        ], scanPolicy: { scanDepthMessages: 12, includeParticipantNames: true, tokenBudget: 1900, recursive: true, maxRecursionSteps: 3 } },
      },
    },
  },
]);

const ALL_WORLD_BOOK_TEMPLATES = Object.freeze([
  ...WORLD_BOOK_TEMPLATES,
  ...ADDITIONAL_WORLD_BOOK_TEMPLATES,
  ...INDUSTRY_WORLD_BOOK_TEMPLATES,
]);

function localeKey(locale) {
  const value = String(locale || "en").toLowerCase();
  if (value.startsWith("zh")) return "zh-CN";
  if (value.startsWith("ar")) return "ar";
  return "en";
}

function localized(template, locale) {
  const requestedLocale = localeKey(locale);
  const contentLocale = template.locales[requestedLocale] ? requestedLocale : "en";
  const item = template.locales[contentLocale];
  return {
    id: template.id,
    version: template.version,
    locale: contentLocale,
    categoryId: template.categoryId || "uncategorized",
    displayName: item.name,
    name: item.name,
    tagline: item.tagline,
    summary: item.summary,
    official: true,
    completion: "ready",
    descriptionChars: [...item.canonical.description].length,
    ...item.canonical,
    canonical: {
      ...item.canonical,
      expertise: [...item.canonical.expertise],
      goals: [...item.canonical.goals],
      preferences: [...item.canonical.preferences],
      constraints: [...item.canonical.constraints],
    },
  };
}

function listOfficialPersonas(locale) {
  return ALL_PERSONA_TEMPLATES.map((item) => {
    const value = localized(item, locale);
    return {
      id: value.id,
      version: value.version,
      locale: value.locale,
      categoryId: value.categoryId,
      displayName: value.displayName,
      name: value.name,
      tagline: value.tagline,
      summary: value.summary,
      official: true,
    };
  });
}

function getOfficialPersona(id, locale) {
  const item = ALL_PERSONA_TEMPLATES.find((candidate) => candidate.id === id);
  return item ? localized(item, locale) : null;
}

function localizedWorldBook(template, locale) {
  const requestedLocale = localeKey(locale);
  const contentLocale = template.locales[requestedLocale] ? requestedLocale : "en";
  const item = template.locales[contentLocale];
  return {
    id: template.id,
    version: template.version,
    locale: contentLocale,
    categoryId: template.categoryId,
    displayName: item.name,
    name: item.name,
    tagline: item.tagline,
    summary: item.summary,
    official: true,
    completion: "ready",
    entryCount: item.canonical.entries.length,
    canonical: {
      ...item.canonical,
      entries: item.canonical.entries.map((entry) => ({
        ...entry,
        activation: { ...entry.activation, primaryKeys: [...entry.activation.primaryKeys], secondaryKeys: [...entry.activation.secondaryKeys] },
        insertion: { ...entry.insertion },
      })),
      // Official books are intentionally non-recursive: their constant rules
      // should not self-trigger unrelated entries through ordinary words in
      // the rule text. A future pack can opt into recursion explicitly.
      scanPolicy: { ...item.canonical.scanPolicy, recursive: false },
    },
  };
}

function listOfficialWorldBooks(locale) {
  return ALL_WORLD_BOOK_TEMPLATES.map((item) => {
    const value = localizedWorldBook(item, locale);
    return {
      id: value.id,
      version: value.version,
      locale: value.locale,
      categoryId: value.categoryId,
      displayName: value.displayName,
      name: value.name,
      tagline: value.tagline,
      summary: value.summary,
      entryCount: value.entryCount,
      official: true,
    };
  });
}

function getOfficialWorldBook(id, locale) {
  const item = ALL_WORLD_BOOK_TEMPLATES.find((candidate) => candidate.id === id);
  return item ? localizedWorldBook(item, locale) : null;
}

module.exports = {
  PERSONA_TEMPLATES,
  ADDITIONAL_PERSONA_TEMPLATES,
  ALL_PERSONA_TEMPLATES,
  WORLD_BOOK_TEMPLATES,
  ADDITIONAL_WORLD_BOOK_TEMPLATES,
  INDUSTRY_WORLD_BOOK_TEMPLATES,
  ALL_WORLD_BOOK_TEMPLATES,
  getOfficialPersona,
  listOfficialPersonas,
  getOfficialWorldBook,
  listOfficialWorldBooks,
};
