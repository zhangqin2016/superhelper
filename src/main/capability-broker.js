"use strict";

const path = require("node:path");
const { PROJECT_ROOT } = require("./config");

const BASE_CAPABILITIES = [
  {
    id: "dependency.install",
    family: "dependency",
    title: "Install or repair optional dependency packs",
    triggers: ["dependency missing", "install runtime", "large pdf", "ocr", "ffmpeg", "playwright"],
    route: "Use Lily runtime-pack tools (runtime_pack_list/runtime_pack_install), or read the lily-runtime-packs guide and run its script. Do not invoke OpenCode native `skill <id>` for platform catalog skills, including `lily-*` and built-in `anthropics-*`. Long installs must run through lily_process_jobs.",
    failOpen: "If unavailable, fail open: continue with bundled capabilities and state the missing pack.",
  },
  {
    id: "file.index",
    family: "file",
    title: "Index and query large files or folders",
    triggers: ["large document", "many files", "search within folder", "query pdf", "analyze workbook"],
    route: "Use file intelligence tools or document extraction scripts. Do not read huge files wholesale into prompt.",
    failOpen: "If indexing fails, fail open: use path-first CLI/file tools and disclose partial evidence.",
  },
  {
    id: "process.job",
    family: "execution",
    title: "Run long tasks with progress and recovery",
    triggers: ["long scan", "batch convert", "dependency install", "web learning", "video processing"],
    route: "Use lily_process_jobs job_start/job_status/job_logs for long deterministic work.",
    failOpen: "If the supervisor is unavailable, fail open: use foreground tools only and do not claim background progress.",
  },
  {
    id: "artifact.reveal",
    family: "artifact",
    title: "Register, preview, and reveal generated files",
    triggers: ["generated image", "open file location", "preview artifact", "show output"],
    route: "Use artifact registry/local media protocol and absolute file evidence.",
    failOpen: "If preview cannot render, fail open: show the path and keep reveal/copy affordances.",
  },
  {
    id: "web.learn",
    family: "web",
    title: "Learn a web system into a workspace skill",
    triggers: ["learn website", "learn admin system", "automate portal", "web app operation"],
    route: "Use lily-web-system-learning orchestrator; normal usage must prefer learned API/playbook execution.",
    failOpen:
      "If learning cannot authenticate or converge, fail open: produce a partial draft with gaps instead of ad-hoc browser loops.",
  },
];

const OPERATION_INTENT_PATTERN =
  /(依赖|安装|修复|检查|分析|读取|解析|转换|索引|查询|搜索|总结|生成|导出|导入|学习|扫描|自动化|研究|调研|比较|估值|股票|邮件|邮箱|回复客户|意图|路由|触发哪个|应用|管理后台|小工具|脚本|组件|表单|工程规范|能力退化|网页|网站|系统|最新|今天|今日|新闻|来源|出处|价格|排行榜|PDF|pdf|Word|word|Excel|excel|PPT|ppt|PowerPoint|图片|图像|视频|音频|OCR|ocr|runtime|dependency|install|repair|analy[sz]e|read|parse|convert|index|search|summari[sz]e|generate|export|import|learn|scan|automate|research|compare|stock|valuation|mail|email|intent|routing|app|dashboard|script|component|browser|website|document|image|video|audio|latest|current|today|news|sources?|citations?|prices?|rankings?|ffmpeg|playwright)/i;

function normalizeCapability(item) {
  return {
    id: String(item?.id || "").trim(),
    family: String(item?.family || "general").trim(),
    title: String(item?.title || "").trim(),
    triggers: Array.isArray(item?.triggers) ? item.triggers.map(String).filter(Boolean) : [],
    route: String(item?.route || "").trim(),
    failOpen: String(item?.failOpen || "Fail open to today's behavior.").trim(),
  };
}

function listCapabilities(extra = []) {
  return [...BASE_CAPABILITIES, ...extra].map(normalizeCapability).filter((item) => item.id && item.title);
}

function compactArray(values = [], max = 4) {
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const item = String(value || "").trim();
    if (item && !out.includes(item)) out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeQueryToken(token) {
  const item = String(token || "");
  if (!/^[a-z]+$/.test(item) || item.length < 4) return item;
  if (item === "resizing") return "resize";
  if (item.endsWith("ies") && item.length > 4) return `${item.slice(0, -3)}y`;
  if (item.endsWith("ing") && item.length > 5) {
    const stem = item.slice(0, -3);
    if (/(cod|siz|mov|remov|chang|writ|mak)$/.test(stem)) return `${stem}e`;
    return stem;
  }
  if (item.endsWith("s") && !/(ss|us|is)$/.test(item)) return item.slice(0, -1);
  return item;
}

function normalizedQueryText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\bbg\b/g, " background ")
    .replace(/\bremove\b/g, " removal ")
    .replace(/[_./:-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map(normalizeQueryToken)
    .join(" ");
}

function hintMatchesText(hint, text) {
  const normalizedHint = normalizedQueryText(hint);
  const normalizedText = normalizedQueryText(text);
  if (!normalizedHint || !normalizedText) return false;
  if (/[\u4e00-\u9fff]/.test(normalizedHint)) {
    return normalizedText.includes(normalizedHint);
  }
  const terms = normalizedHint.split(" ").filter((term) => term.length >= 3);
  if (!terms.length) return false;
  return terms.every((term) => new RegExp(`(^|[^a-z0-9])${escapeRegExp(term)}([^a-z0-9]|$)`, "i").test(normalizedText));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function capabilityHintRelevance(skill, rawText) {
  const hints = Array.isArray(skill?.matchHints) ? skill.matchHints : [];
  if (!hints.length) return 0;
  const matches = hints.filter((hint) => hintMatchesText(hint, rawText)).length;
  if (!matches) return 0;
  return Math.min(155, 110 + matches * 15);
}

function capabilityAvoidHintMatches(skill, rawText) {
  const hints = Array.isArray(skill?.avoidHints) ? skill.avoidHints : [];
  return hints.some((hint) => hintMatchesText(hint, rawText));
}

function hasCapabilityHintMatch(text, opts = {}) {
  if (!String(text || "").trim()) return false;
  return listSkillCapabilityGraph(opts).some((skill) => capabilityHintRelevance(skill, text) > 0);
}

function skillGuidePath(skillId) {
  return path.join(PROJECT_ROOT, "resources", "skills-catalog", skillId, "SKILL.md");
}

function listSkillCapabilityGraph(opts = {}) {
  try {
    const { loadBundledRegistry } = require("./skill-registry");
    const { inferRuntimePackIds } = require("./runtime-pack-preflight");
    const registry = opts.registry || loadBundledRegistry();
    const skills = Array.isArray(registry?.skills) ? registry.skills : [];
    return skills
      .filter((skill) => skill?.id && skill.capability)
      .map((skill) => {
        const capability = skill.capability || {};
        const requiredRuntimePacks = inferRuntimePackIds({ skillIds: [skill.id] });
        const failureRoutes = compactArray(capability.failure?.recovery, 4);
        return {
          id: String(skill.id),
          category: skill.category || "",
          kind: capability.kind || skill.capabilityLayer || "workflow",
          intents: compactArray(capability.intents, 5),
          avoidIntents: compactArray(capability.avoidIntents, 3),
          matchHints: compactArray(capability.matchHints, 16),
          avoidHints: compactArray(capability.avoidHints, 8),
          primaryTools: compactArray(capability.primaryTools, 5),
          runtimeDependencies: compactArray(capability.runtimeDependencies, 5),
          requiredRuntimePacks,
          inputModes: compactArray(capability.inputModes, 4),
          outputModes: compactArray(capability.outputModes, 4),
          risk: capability.risk || { level: skill.riskLevel || "low", confirmation: "none" },
          verification: capability.verification || { required: false, methods: [] },
          failOpen: failureRoutes.length ? failureRoutes.join(", ") : "read guide and fall back to baseline tools",
          guidePath: skillGuidePath(skill.id),
        };
      });
  } catch {
    return [];
  }
}

function fileFacts(files = []) {
  const names = (Array.isArray(files) ? files : [])
    .map((file) => String(file?.name || file?.path || "").toLowerCase())
    .filter(Boolean);
  return {
    pdf: names.some((name) => name.endsWith(".pdf")),
    xlsx: names.some((name) => /\.(xlsx|xlsm|xls|csv|tsv)$/.test(name)),
    pptx: names.some((name) => /\.(pptx|ppt)$/.test(name)),
    docx: names.some((name) => /\.(docx|doc|rtf|odt)$/.test(name)),
    image: names.some((name) => /\.(png|jpe?g|webp|bmp|tiff?|heic)$/.test(name)),
    media: names.some((name) => /\.(mp4|mov|mkv|avi|webm|mp3|wav|m4a|aac|flac|ogg)$/.test(name)),
  };
}

function queryFacts(opts = {}) {
  const text = String(opts.text || opts.query || "").toLowerCase();
  const zh = String(opts.text || opts.query || "");
  const files = fileFacts(opts.files || opts.attachments || []);
  const sourceOfficeFile = files.xlsx || files.pptx || files.docx;
  const referencedMedia = /(?:uploaded|attached|current|this|the)\s+(?:video|audio|movie|clip|recording|mp4|mov|mp3|wav)|(?:video|audio|movie|clip|recording|mp4|mov|mp3|wav)\s+(?:uploaded|attached)|上传(?:的)?(?:视频|音频|录音|素材)|附件(?:里|中|的)?(?:视频|音频|录音|素材)|这段(?:视频|音频|录音)|这个(?:视频|音频|录音)/i.test(`${text} ${zh}`);
  const media = files.media || referencedMedia;
  const referencedImage = /(?:uploaded|attached|current|this|the)\s+(?:[\w-]+\s+){0,3}(?:image|picture|photo|screenshot|png|jpe?g|webp)|(?:image|picture|photo|screenshot|png|jpe?g|webp)\s+(?:uploaded|attached)|上传(?:的)?(?:图片|图像|照片|截图|产品图|商品图|素材)|附件(?:里|中|的)?(?:图片|图像|照片|截图|产品图|商品图|素材)|这张(?:图片|图像|照片|截图|产品图|商品图|素材)|这个(?:图片|图像|照片|截图|产品图|商品图|素材)/i.test(`${text} ${zh}`);
  const image = files.image || referencedImage || /图片|图像|截图|产品图|商品图|ocr|image|photo|screenshot/i.test(`${text} ${zh}`);
  const sourceNonPdfFile = sourceOfficeFile || files.image || referencedImage || media;
  const pdf = files.pdf || (!sourceNonPdfFile && /pdf|扫描|版面|表格提取|阅读顺序/i.test(`${text} ${zh}`));
  const explicitSpreadsheet = /xlsx|xls|csv|excel|spreadsheet|worksheet|电子表格|公式|图表/i.test(`${text} ${zh}`);
  const referencedSpreadsheet = /(?:uploaded|attached|current|this|the)\s+(?:workbook|spreadsheet|worksheet|excel|csv|sheet)|(?:workbook|spreadsheet|worksheet|excel|csv|sheet)\s+(?:uploaded|attached)|上传(?:的)?(?:工作簿|表格|电子表格|Excel|CSV)|附件(?:里|中|的)?(?:工作簿|表格|电子表格|Excel|CSV)|这份(?:工作簿|表格|电子表格|Excel|CSV)|该(?:工作簿|表格|电子表格|Excel|CSV)/i.test(`${text} ${zh}`);
  const spreadsheet = files.xlsx || referencedSpreadsheet || (!pdf && explicitSpreadsheet);
  const pdfForm = pdf && /form|field|required|fillable|表单|字段|必填|填写|填充|填表/i.test(`${text} ${zh}`);
  const engineeringRules = /工程规范|工程纪律|过度设计|能力退化|最小改动|保护用户改动|验证后完成|read before write|engineering rules|delivery quality/i.test(`${text} ${zh}`);
  const documentDraft = !engineeringRules && !pdf &&
    /coauthor|proposal|structured doc|draft|write|memo|report|document|提案|方案|报告|计划书|起草|撰写|写一份|创建一份|结构化文档/i.test(`${text} ${zh}`);
  const evidenceLookup = /query|search|lookup|evidence|cite|citation|find|查询|搜索|查找|找出|证据|引用|出处/i.test(`${text} ${zh}`);
  const readSummary = /read|summari[sz]e|extract summary|overview|读取|阅读|总结|摘要|提取要点|说明.*内容/i.test(`${text} ${zh}`);
  const referencedDocument = /(?:uploaded|attached|current|this|the)\s+(?:contract|agreement|document|report|file)|(?:contract|agreement|document|report|file)\s+(?:uploaded|attached)|上传(?:的)?(?:合同|协议|文档|报告|文件)|附件(?:里|中|的)?(?:合同|协议|文档|报告|文件)|这份(?:合同|协议|文档|报告|文件)|该(?:合同|协议|文档|报告|文件)/i.test(`${text} ${zh}`);
  const documentQuery = evidenceLookup || readSummary;
  const templateFill = /template|placeholder|mail merge|merge fields|模板|占位符|邮件合并|批量填充|套打/i.test(`${text} ${zh}`);
  const presentationQa = (files.pptx || /ppt|pptx|powerpoint|presentation|deck|slide|幻灯片|演示/i.test(`${text} ${zh}`)) &&
    /qa|review|check|overflow|layout|design|visual|检查|质检|溢出|版式|排版|设计|视觉/i.test(`${text} ${zh}`);
  const documentVerification = !presentationQa && (referencedDocument || files.pdf || sourceOfficeFile) &&
    /verify|check|validate|pagination|page numbers?|table layout|links?|render|delivery|验收|检查|校验|分页|页码|表格.*(?:版式|布局)|链接|渲染|交付/i.test(`${text} ${zh}`);
  const spreadsheetAnalysis = spreadsheet &&
    /analy[sz]e|clean|chart|pivot|summary|formula|outlier|dashboard|分析|清洗|图表|透视|汇总|公式|异常值|看板/i.test(`${text} ${zh}`);
  const webLearning = /学习|learn|自动化.*可复用|生成可复用|workspace skill|capability map|后台系统|logged.?in system/i.test(`${text} ${zh}`);
  const browserQaSignal = !sourceOfficeFile &&
    /localhost|127\.0\.0\.1|console|控制台|前端|frontend|冒烟|smoke|按钮|点击|交互|响应式|布局|登录页|网页.*测试|web app|browser\s+(?:qa|test|check)|qa/i.test(`${text} ${zh}`);
  const promptEnhance = /prompt|提示词|咒语|关键词|改写.*提示|写得更专业|扩写/i.test(`${text} ${zh}`);
  const visualCreative = /海报|封面|小红书|产品图|头像|插画|图片|图像|视频|分镜|\bposter\b|\bcover\b|\bimage\b|\bvideo\b|\bstoryboard\b|visual asset|visual concept|visual design/i.test(`${text} ${zh}`);
  const mediaTranscode = media && /剪辑|裁剪|转码|压缩|导出|mp4|mov|ffmpeg|transcode|encode|trim|cut|compress/i.test(`${text} ${zh}`);
  const imageTransform = image &&
    /resize|convert|export|thumbnail|compress|crop|scale|smaller|larger|save\s+as|remove.{0,20}background|background removal|change.{0,30}\bto\b.{0,20}(?:png|jpe?g|webp|gif|tiff?|bmp|avif)|格式转换|调整尺寸|缩放|裁剪|压缩|导出|另存为|抠图|去背景|背景移除|改成.{0,12}(?:png|jpe?g|webp|gif|tiff?|bmp|avif)|转成.{0,12}(?:png|jpe?g|webp|gif|tiff?|bmp|avif)/i.test(`${text} ${zh}`);
  const creativeCreate = !mediaTranscode && !imageTransform && visualCreative && /生成|创建|设计|制作|编辑|优化|海报|封面|产品图|头像|插画|分镜|\bposter\b|\bcover\b|\bstoryboard\b|visual asset|visual concept|visual design/i.test(`${text} ${zh}`);
  const imageReview = files.image &&
    /检查|review|qa|验收|错误|错位|清晰|可用|瑕疵|重做|文字错误|artifact/i.test(`${text} ${zh}`);
  const stockResearch = /股票|股价|估值|财报|财务|market cap|valuation|ticker|stock|equity|earnings|英伟达|nvidia|nvda|特斯拉|tesla|tsla/i.test(`${text} ${zh}`);
  const currentFactResearch = /最新|今天|今日|新闻|实时|当前|价格|排行榜|带来源|给出处|引用来源|证据来源|latest|current|today|news|prices?|rankings?|citations?|with sources?/i.test(`${text} ${zh}`);
  const sourceResearch = stockResearch ||
    currentFactResearch ||
    /研究|竞品|比较|排名|排行榜|事实核查|来源|出处|引用来源|证据来源|调研|research|competitor|compare|ranking|fact.?check|source/i.test(`${text} ${zh}`);
  const skillQuality = /技能|skill|能力契约|质量门槛|release gate|quality gate|capability contract/i.test(`${text} ${zh}`) &&
    /检查|review|audit|质量|门槛|符合|验收|评审/i.test(`${text} ${zh}`);
  const intentEval = /意图|intent|路由|routing|触发哪个|prompt regression|评估这句话/i.test(`${text} ${zh}`) &&
    /评估|evaluate|测试|test|触发|识别/i.test(`${text} ${zh}`);
  const mail = /邮件|邮箱|email|mail|inbox|客户.*回复|回复客户|收件箱|发信|send mail/i.test(`${text} ${zh}`);
  const codeSignal = /debug|fix|TypeError|ReferenceError|SyntaxError|build failure|test failure|runtime error|cannot read|stack trace|exception|npm|node|python|java|代码|编译|构建|测试失败/i.test(`${text} ${zh}`);
  const codeRepair = !files.image && !files.pdf && !files.docx && !files.pptx && !spreadsheet &&
    (codeSignal || /报错|异常|失败|修复/i.test(`${text} ${zh}`));
  const uiBuildArtifact = !pdf && !sourceOfficeFile &&
    /页面|界面|落地页|登录页|官网|网站|网页|仪表盘|看板|管理后台|后台页面|landing\s*page|login\s*(?:page|screen)|web\s*page|website|dashboard|admin\s*(?:page|screen|interface)/i.test(`${text} ${zh}`);
  const uiArtifact = uiBuildArtifact || (!pdf && !sourceOfficeFile &&
    /ui|组件|表单|component|form/i.test(`${text} ${zh}`));
  const uiReview = uiArtifact &&
    /审查|评审|验收|质量|一致|无障碍|可访问|间距|层级|视觉|交互|audit|review|critique|visual\s*qa|quality|consistency|accessibility|spacing|hierarchy|interaction/i.test(`${text} ${zh}`);
  const uiDesignVerb = /设计|美化|优化|改版|重新设计|重设计|design|redesign|polish|restyle/i.test(`${text} ${zh}`);
  const uiCreate = !codeRepair && uiArtifact && (uiDesignVerb || (uiBuildArtifact &&
    /制作|创建|构建|开发|实现|生成|搭建|做一个|build|create|implement|make/i.test(`${text} ${zh}`)));
  const explicitBrowserVerification = uiArtifact &&
    /打开|预览|截图|浏览器|点击|测试|验证|响应式|控制台|open|preview|screenshot|browser|click|test|verify|responsive|console/i.test(`${text} ${zh}`);
  const uiQuality = uiReview || uiCreate;
  const appCreate = !codeRepair && (uiCreate ||
    /做一个.*(应用|app|工具)|搭建.*(应用|app|工具)|创建.*(应用|app|工具)|构建.*(应用|app|工具)|开发.*应用|写.*脚本|生成.*脚本|批量.*文件|web app|小工具|script/i.test(`${text} ${zh}`));
  const browserQa = browserQaSignal || uiReview || explicitBrowserVerification || appCreate;
  const web = webLearning || browserQa || uiQuality || appCreate || /网页|网站|系统|\boa\b|erp|crm|browser|website|web app|playwright|自动化/i.test(`${text} ${zh}`);
  const codingCore = !sourceResearch && !appCreate && !codeRepair && !files.image && !files.pdf && !files.docx && !files.pptx && !files.xlsx &&
    /实现|接入|组件|表单|逻辑|重构|改代码|代码|automation|script|function|api|hook|component/i.test(`${text} ${zh}`);
  return {
    rawText: `${text} ${zh}`,
    sourceOfficeFile,
    office: files.pdf || files.xlsx || files.pptx || files.docx ||
      /pdf|word|excel|xlsx|spreadsheet|worksheet|ppt|powerpoint|presentation|document|office|文档|表格|演示|幻灯片|合同|模板/i.test(`${text} ${zh}`),
    pdf,
    pdfForm,
    xlsx: spreadsheet,
    spreadsheetAnalysis,
    pptx: files.pptx || /ppt|pptx|powerpoint|presentation|deck|slide|幻灯片|演示/i.test(`${text} ${zh}`),
    pptQa: presentationQa,
    docx: files.docx || (!files.pptx && (documentDraft || /docx|word|letter|memo|report|proposal|文档|报告|合同|模板/i.test(`${text} ${zh}`))),
    documentDraft,
    documentQuery,
    referencedDocument,
    documentVerification,
    evidenceLookup,
    readSummary,
    templateFill,
    runtime: mediaTranscode || imageTransform || /依赖|安装|启用|专业解析引擎|专业.*引擎|runtime|dependency|pack|ocr|docling|libreoffice|ffmpeg|playwright|advanced parser|professional parser/i.test(`${text} ${zh}`),
    web: web || uiQuality || appCreate,
    webLearning,
    browserQa: browserQa || uiQuality || appCreate,
    media: media || /视频|音频|ffmpeg|video|audio|剪辑|转码/i.test(`${text} ${zh}`),
    mediaTranscode,
    image,
    imageTransform,
    creativeCreate,
    promptEnhance,
    imageReview,
    stockResearch,
    sourceResearch,
    skillQuality,
    intentEval,
    mail,
    uiArtifact,
    uiReview,
    uiCreate,
    explicitBrowserVerification,
    uiQuality,
    codeRepair,
    appCreate,
    codingCore,
    engineeringRules,
  };
}

function skillRelevance(skill, facts) {
  let score = 0;
  const appWithTextOnlyOfficeInput = facts.appCreate && !facts.sourceOfficeFile;
  if (capabilityAvoidHintMatches(skill, facts.rawText)) return 0;
  if (skill.id === "lily-prompt-enhancer" && facts.intentEval) return 0;
  if (skill.id === "lily-office-intent" && facts.office && !appWithTextOnlyOfficeInput) score += 120;
  if (skill.id === "lily-runtime-packs" && facts.runtime) score += facts.mediaTranscode ? 170 : 160;
  if (skill.id === "lily-pdf-extraction-router" && facts.pdf) score += 100;
  if (skill.id === "lily-excel-data-analysis" && facts.xlsx && !appWithTextOnlyOfficeInput) score += facts.spreadsheetAnalysis ? 150 : 95;
  if (skill.id === "lily-ppt-design-qa" && facts.pptx) score += facts.pptQa ? 150 : 90;
  if (skill.id === "lily-document-verify" && !appWithTextOnlyOfficeInput && (facts.office || facts.pdf || facts.pptx || facts.docx || facts.xlsx || facts.referencedDocument)) score += facts.documentVerification ? 175 : 55;
  if (skill.id === "lily-template-fill" && facts.templateFill) score += 170;
  if (skill.id === "lily-document-query" && (facts.pdf || facts.docx || facts.xlsx || facts.pptx || facts.office || facts.referencedDocument)) {
    score += facts.evidenceLookup ? 140 : 50;
  }
  if (skill.id === "lily-pdf-form" && facts.pdfForm) score += 180;
  if (skill.id === "anthropics-doc-coauthoring" && facts.documentDraft && !facts.documentVerification) score += /创建|生成|写一份|起草|撰写|create|write|draft/i.test(facts.rawText || "") ? 170 : 95;
  if (skill.id === "anthropics-pdf" && facts.pdf) {
    score += /创建|生成|加水印|合并|页码|拆分|加密|解密|create|write|watermark|merge|split/i.test(`${facts.rawText || ""}`)
      ? 160
      : facts.readSummary && !facts.evidenceLookup ? 160 : 90;
  }
  if (skill.id === "anthropics-xlsx" && facts.xlsx && !appWithTextOnlyOfficeInput) score += facts.readSummary && !facts.evidenceLookup ? 160 : 90;
  if (skill.id === "anthropics-pptx" && facts.pptx) {
    score += /创建|生成|制作|培训课件|create|write|deck/i.test(facts.rawText || "")
      ? 170
      : facts.readSummary && !facts.evidenceLookup ? 160 : 90;
  }
  if (skill.id === "anthropics-docx" && facts.docx) score += facts.readSummary && !facts.evidenceLookup ? 160 : 90;
  if (skill.id === "lily-web-system-learning" && facts.webLearning) score += 140;
  if (skill.id === "lily-browser-qa" && facts.web && (!facts.sourceResearch || facts.browserQa)) score += facts.browserQa ? 150 : 60;
  if (skill.id === "lily-creative-director" && facts.creativeCreate && !facts.imageReview) score += facts.promptEnhance ? 100 : 150;
  if (skill.id === "lily-prompt-enhancer" && !facts.intentEval && !facts.imageReview && (facts.promptEnhance || facts.creativeCreate)) score += facts.promptEnhance ? 150 : 80;
  if (skill.id === "lily-image-qa" && facts.image) score += facts.imageReview ? 150 : 60;
  if (skill.id === "lily-stock-research" && facts.stockResearch) score += 160;
  if (skill.id === "lily-research-synthesis" && facts.sourceResearch) score += facts.stockResearch ? 90 : 150;
  if (skill.id === "lily-skill-quality-gate" && facts.skillQuality) score += 160;
  if (skill.id === "lily-intent-eval" && facts.intentEval) score += 160;
  if (skill.id === "lily-mail-assistant" && facts.mail) score += 160;
  if (skill.id === "lily-ui-quality" && facts.uiQuality) score += 160;
  if (skill.id === "lily-code-repair" && facts.codeRepair) score += 160;
  if (skill.id === "lily-app-builder" && facts.appCreate) score += 170;
  if (skill.id === "lily-coding-core" && (facts.codingCore || facts.appCreate || facts.codeRepair)) {
    score += facts.codingCore ? 160 : 90;
  }
  if (skill.id === "lily-engineering-rules" && facts.engineeringRules) score += 170;
  score += capabilityHintRelevance(skill, facts.rawText);
  if (skill.id.startsWith("anthropics-") && !score) score -= 20;
  if (skill.kind === "router" && facts.office && !appWithTextOnlyOfficeInput && skill.id !== "lily-pdf-extraction-router") score += 20;
  if (skill.kind === "runtime" && facts.runtime) score += 20;
  return score;
}

function recommendSkillCapabilityGraph(opts = {}) {
  const maxSkills = Number.isFinite(opts.maxSkills) ? Math.max(1, opts.maxSkills) : 8;
  const graph = listSkillCapabilityGraph(opts);
  const active = new Set((Array.isArray(opts.activeSkillIds) ? opts.activeSkillIds : []).map(String));
  const facts = queryFacts(opts);
  const operational = Object.values(facts).some(Boolean);
  const ranked = graph
    .map((skill) => {
      let score = skillRelevance(skill, facts);
      if (score > 0 && active.has(skill.id)) score += 10;
      return { skill, score };
    })
    .filter((item) => item.score > 0 || (!operational && (item.skill.kind === "router" || item.skill.id === "lily-runtime-packs")))
    .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id))
    .slice(0, maxSkills)
    .map((item) => item.skill);
  if (ranked.length) return ranked;
  return graph
    .filter((skill) => skill.kind === "router" || skill.id === "lily-runtime-packs")
    .slice(0, maxSkills);
}

function hasScoredCapabilityRecommendation(opts = {}) {
  const graph = listSkillCapabilityGraph(opts);
  const facts = queryFacts(opts);
  return graph.some((skill) => skillRelevance(skill, facts) > 0);
}

function compactSkillCapabilityGraph(opts = {}) {
  const maxSkills = Number.isFinite(opts.maxSkills) ? Math.max(0, opts.maxSkills) : 16;
  const hasFocus = Boolean(String(opts.text || opts.query || "").trim()) ||
    (Array.isArray(opts.files) && opts.files.length > 0) ||
    (Array.isArray(opts.attachments) && opts.attachments.length > 0);
  const focused = hasFocus
    ? recommendSkillCapabilityGraph({ ...opts, maxSkills })
    : listSkillCapabilityGraph(opts)
      .filter((item) => (
        item.kind === "router" ||
        item.category === "office" ||
        item.id.startsWith("lily-runtime") ||
        [
          "lily-app-builder",
          "lily-mail-assistant",
          "lily-research-synthesis",
          "lily-browser-qa",
          "lily-coding-core",
          "lily-creative-director",
        ].includes(item.id)
      ))
      .sort((a, b) => {
      const score = (item) => {
        if (item.id === "lily-office-intent") return 0;
        if (item.id === "lily-runtime-packs") return 1;
        if (item.id === "lily-app-builder") return 2;
        if (item.id === "lily-research-synthesis") return 3;
        if (item.id === "lily-mail-assistant") return 4;
        if (item.id === "lily-browser-qa") return 5;
        if (item.id === "lily-coding-core") return 6;
        if (item.id === "lily-creative-director") return 7;
        if (item.id === "anthropics-xlsx") return 8;
        if (item.id === "anthropics-docx") return 9;
        if (item.id === "anthropics-pdf") return 10;
        if (item.id === "anthropics-pptx") return 11;
        if (item.id.startsWith("anthropics-")) return 12;
        if (item.kind === "router") return 13;
        if (item.kind === "quality") return 14;
        return 15;
      };
      return score(a) - score(b) || a.id.localeCompare(b.id);
    })
      .slice(0, maxSkills);
  if (!focused.length) return [];
  return [
    "Skill capability graph (catalog guides, not native skills):",
    ...focused.map((item) => {
      const intents = item.intents.length ? ` intents=${item.intents.join(",")}` : "";
      const packs = item.requiredRuntimePacks.length ? ` packs=${item.requiredRuntimePacks.join(",")}` : "";
      const verify = item.verification?.required ? ` verify=${compactArray(item.verification.methods, 3).join(",")}` : "";
      const guide = path.relative(PROJECT_ROOT, item.guidePath);
      return `- ${item.id} [${item.kind}]${intents}${packs}${verify} guide=${guide}`;
    }),
  ];
}

function compactCapabilityContext(opts = {}) {
  const maxChars = Number.isFinite(opts.maxChars) ? Math.max(500, opts.maxChars) : 4000;
  const hasFocus = Boolean(String(opts.text || opts.query || "").trim()) ||
    (Array.isArray(opts.files) && opts.files.length > 0) ||
    (Array.isArray(opts.attachments) && opts.attachments.length > 0);
  const baseLines = listCapabilities(opts.extra).map(
    (item) => `- ${item.id}: ${item.title}. Route: ${item.route} Fail-open: ${item.failOpen}`
  );
  const compactBaseLines = listCapabilities(opts.extra).map((item) => {
    if (item.id === "dependency.install") {
      return "- dependency.install: runtime_pack_list/runtime_pack_install; Do not invoke OpenCode native `skill <id>` for catalog skills including lily-* and anthropics-*; Long installs must run through lily_process_jobs; fail open: continue with bundled capabilities.";
    }
    if (item.id === "process.job") {
      return "- process.job: use lily_process_jobs job_start/job_status/job_logs for long work; fail open to foreground tools.";
    }
    return `- ${item.id}: ${item.title}; fail open.`;
  });
  const graphLines = compactSkillCapabilityGraph(opts);
  const lines = hasFocus
    ? [
        "Lily chat-native capabilities:",
        ...graphLines,
        "Supporting platform routes:",
        ...baseLines,
      ]
    : [
        "Lily chat-native capabilities:",
        "Supporting platform routes:",
        ...compactBaseLines,
        ...graphLines,
      ];
  const text = lines.join("\n");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 25))}\n[capabilities truncated]`;
}

function shouldInjectCapabilityContext(opts = {}) {
  if (Array.isArray(opts.files) && opts.files.length > 0) return true;
  if (opts.dependencyAdvisory?.text) return true;
  if (opts.turnPolicy?.rigor === "grounded" || opts.turnPolicy?.rigor === "coverage") return true;
  const text = String(opts.text || "");
  return OPERATION_INTENT_PATTERN.test(text) ||
    hasCapabilityHintMatch(text, opts) ||
    hasScoredCapabilityRecommendation({ ...opts, text });
}

module.exports = {
  listCapabilities,
  listSkillCapabilityGraph,
  recommendSkillCapabilityGraph,
  compactCapabilityContext,
  shouldInjectCapabilityContext,
};
