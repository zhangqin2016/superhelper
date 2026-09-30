// Help center copy (/docs) for end users, in zh / en / ar.
//
// 2026-09-30: the old /docs page was English-only on the Chinese site and
// written for operators (upload installers, create licenses in the admin
// console). Internal procedures are not public help. Every locale carries the
// same shape — same section ids, same block types, same list lengths — and
// scripts/test-site-docs.mjs holds that, plus the rule that this copy never
// promises more than the legal pages do (no "fully offline", no "files are
// never uploaded"): what goes to model providers is stated as the privacy
// policy states it.
//
// Block types: sub (h3), p, list (bullets), steps (ordered), note (callout),
// faq ([question, answer] pairs).

const EMAIL = "felix@lilywb.cn";

const zh = {
  meta: {
    title: "帮助中心",
    description: "安装、登录、工作区、交付文件、企业额度与隐私——Lily Workbench 使用指南。",
  },
  eyebrow: "帮助中心",
  title: "从安装到交付，一页看懂。",
  lead: "Lily 是装在你电脑上的 AI 工作助手。你用平常说话的方式交代工作，它读资料、动手做、交付前自己检查。",
  navLabel: "帮助目录",
  mobileNav: "目录",
  onThisPage: "本页内容",
  sections: [
    {
      id: "install",
      title: "快速开始",
      summary: "几分钟装好 Lily，开始第一项工作。",
      blocks: [
        { type: "sub", text: "系统要求" },
        { type: "list", items: [
          "macOS：Apple 芯片（M 系列）或 Intel 芯片的 Mac。",
          "Windows：64 位 Windows 电脑。",
          "安装包已自带处理 Word、Excel、PPT、PDF 所需的运行环境，不需要另装 Office、Python 或其他软件。",
        ] },
        { type: "sub", text: "在 Mac 上安装" },
        { type: "steps", items: [
          "打开下载页，按你的 Mac 芯片选择安装包。不确定时，点屏幕左上角的苹果菜单 → 关于本机，查看“芯片”一栏。",
          "双击下载好的 DMG 文件，把 Lily 拖进“应用程序”文件夹。",
          "从“应用程序”或启动台打开 Lily。如果系统询问是否打开来自互联网的应用，确认即可。",
        ] },
        { type: "sub", text: "在 Windows 上安装" },
        { type: "steps", items: [
          "打开下载页，下载 Windows 安装程序。",
          "双击安装程序，按提示完成安装。如果系统弹出安全提示，请先确认文件来自 lilywb.cn 官网再继续。",
          "从开始菜单或桌面快捷方式打开 Lily。",
        ] },
        { type: "sub", text: "第一次打开" },
        { type: "steps", items: [
          "登录：用手机号和短信验证码，或使用公司发给你的企业账号。",
          "选择工作区：可以是已有的文件夹，也可以新建一个。",
          "在输入框里描述要做的事，比如“把这份合同的付款条款整理成表格”。",
        ] },
        { type: "note", text: "专业 PDF 解析、浏览器自动化、音视频处理这类较重的能力不预先装在安装包里。第一次需要时，Lily 会提示你下载，所以普通笔记本也能流畅运行。" },
      ],
      links: [{ href: "/download", label: "前往下载页" }],
    },
    {
      id: "account",
      title: "登录与账户",
      summary: "两种登录方式，按你的情况选一种。",
      blocks: [
        { type: "sub", text: "手机号 + 验证码" },
        { type: "steps", items: [
          "在登录页输入手机号，点“获取验证码”。",
          "输入收到的短信验证码完成登录。第一次登录会自动为这个手机号创建账户。",
        ] },
        { type: "sub", text: "企业账号（登录名 + 密码）" },
        { type: "p", text: "如果公司为你开通了企业账号，管理员会给你一个登录名和一次性密码。" },
        { type: "steps", items: [
          "在登录页切换到“企业账号”，输入登录名和一次性密码。",
          "首次登录时，系统会要求你设置新密码；设置完成后，一次性密码随即失效。",
          "忘记密码时，请联系公司的企业管理员为你重置。",
        ] },
        { type: "sub", text: "免费体验与余额" },
        { type: "list", items: [
          "新账户登录后会获得一份免费体验额度，可以直接使用平台提供的模型，不需要自己申请 API Key。",
          "余额、有效期和用量可以在 Lily 的“设置 → 账户”中查看；订单记录可以在官网账户页查看。",
          "额度用完后，可以在价格页购买；也可以在 Lily 中接入你自己的模型 Key。",
        ] },
      ],
      links: [
        { href: "/pricing", label: "查看价格" },
        { href: "/account", label: "官网账户" },
      ],
    },
    {
      id: "workspace",
      title: "工作区与文件",
      summary: "工作区就是你电脑上的一个文件夹。",
      blocks: [
        { type: "p", text: "Lily 的每个工作区对应电脑上的一个普通文件夹。每个工作区有自己的对话、历史记录和 Lily 记住的项目约定，互不干扰。你可以为不同的项目或客户分别建工作区。" },
        { type: "sub", text: "添加文件" },
        { type: "list", items: [
          "把文件直接放进工作区文件夹，Lily 就能找到它们。",
          "或者把文件拖进对话输入框，作为这一轮的附件。",
          "说明你要用哪份文件，比如“看一下 报价单.xlsx”，Lily 会优先读它。",
        ] },
        { type: "sub", text: "Lily 会读什么" },
        { type: "list", items: [
          "你附加或点名的文件，以及完成当前任务需要查看的工作区文件。",
          "Word、Excel、PPT、PDF、图片、扫描件、文本和代码文件都能读取；扫描件和图片里的文字会先识别出来。",
          "几百页的 PDF 或很大的表格会分块处理；如果只读了其中一部分，Lily 会明确告诉你。",
        ] },
        { type: "note", text: "Lily 不会因为文件放在工作区里，就把整个文件夹上传到 Lily 的服务器。哪些内容会发给模型服务，请看下方“隐私与数据”。" },
        { type: "sub", text: "改动可以恢复" },
        { type: "p", text: "Lily 每一轮对文件的改动都会自动保存成版本。你可以预览、单独撤回某个改动，或恢复到之前的状态；恢复时不会删除你自己放进去的其他文件。" },
      ],
      links: [],
    },
    {
      id: "delivery",
      title: "对话与交付",
      summary: "说清楚要什么成果，Lily 负责做完并检查。",
      blocks: [
        { type: "sub", text: "直接要成果" },
        { type: "p", text: "与其问“怎么做”，不如直接说要交付什么。好的请求通常说明三件事：要什么成果、依据哪些材料、给谁看。" },
        { type: "list", items: [
          "“根据这三份周报，写一页给老板看的月度总结，存成 Word。”",
          "“把 销售明细.xlsx 按区域汇总，找出异常订单，画一张趋势图。”",
          "“照着 模板.pptx 的版式，把这份方案做成 10 页的汇报。”",
        ] },
        { type: "sub", text: "Lily 如何完成" },
        { type: "steps", items: [
          "读资料：打开你给的文件和相关材料，必要时联网查证，并注明出处。",
          "动手做：整理数据、撰写内容、生成或修改文件。",
          "交付前检查：生成的文档会逐页渲染、核对版式，写的代码会实际运行；没把握的地方会直接说明。",
        ] },
        { type: "sub", text: "文件在哪里" },
        { type: "list", items: [
          "生成的文件默认保存在当前工作区文件夹里。",
          "对话里会出现文件卡片，点击可以直接打开，或在文件夹中显示它的位置。",
          "对结果不满意，直接说要改哪里，Lily 会在原文件的基础上继续修改。",
        ] },
        { type: "note", text: "发邮件、提交表单、删除数据这类有风险的操作，Lily 会先征求你的同意。任务进行中想补充要求，直接在输入框里说，不用打断重来。" },
      ],
      links: [],
    },
    {
      id: "apps-skills",
      title: "应用与技能",
      summary: "技能让 Lily 更会做某类事，应用给你一个现成的起点。",
      blocks: [
        { type: "sub", text: "技能" },
        { type: "p", text: "技能是 Lily 处理某类任务的专门方法，比如 Excel 数据分析、PPT 设计验收、联网研究。Lily 内置 40 多个技能，会根据你的请求自动选用，不需要手动开启；想指定时，在请求里点名即可。" },
        { type: "sub", text: "应用" },
        { type: "p", text: "应用把工作区、技能和模板组合成一个可以直接开始的工作场景，例如邮件助手、视频创作和股票投研示范工作区。" },
        { type: "sub", text: "从目录安装" },
        { type: "steps", items: [
          "在官网的应用或技能目录里浏览，了解每一项能做什么。",
          "在 Lily 的市场中一键安装，或者直接告诉 Lily：“帮我安装邮件助手”。",
          "安装后，用自然语言描述任务，Lily 会自动用上它。",
        ] },
      ],
      links: [
        { href: "/apps", label: "浏览应用" },
        { href: "/skills", label: "浏览技能" },
      ],
    },
    {
      id: "enterprise",
      title: "企业身份与额度",
      summary: "你以谁的身份使用 Lily，决定由谁付费。",
      blocks: [
        { type: "sub", text: "加入企业" },
        { type: "p", text: "企业由 Lily 平台为客户开通。成员可以通过两种方式加入：" },
        { type: "list", items: [
          "手机号邀请：管理员用你的手机号添加你。你用这个手机号登录 Lily 后即成为成员；在此之前，这个席位显示为待加入。",
          "企业账号：公司直接为你签发登录名和一次性密码，首次登录时需要修改密码。",
        ] },
        { type: "sub", text: "切换使用身份" },
        { type: "p", text: "在 Lily 的“设置 → 账户”里选择使用身份：" },
        { type: "list", items: [
          "选择某个企业：之后的模型消耗只使用该企业的额度池，不会扣你的个人余额。",
          "不选企业（个人）：只使用你的个人额度。",
          "两种额度不会混合扣费。切换身份后，从下一次请求开始生效。",
        ] },
        { type: "sub", text: "每周额度" },
        { type: "list", items: [
          "企业额度池由平台为企业充值，管理员可以为每位成员设置每周额度。",
          "每周额度的周期从你第一次使用时开始计算，满 7 天后重置。",
          "本周额度用完后，以企业身份发出的请求要等到下一个周期；这期间你可以切换为个人身份继续工作。",
        ] },
        { type: "sub", text: "企业被冻结、暂停，或你被移出" },
        { type: "list", items: [
          "企业被平台冻结、被管理员暂停，或你的成员身份被停用时，以该企业身份发出的模型请求会被拒绝。Lily 会提示原因，你可以联系企业管理员，或切换为个人身份继续。",
          "你被移出企业后，Lily 会自动改为个人身份，之后的消耗使用个人余额。",
        ] },
        { type: "note", text: "企业管理员可以看到成员的用量统计，以及企业设置的变更历史。" },
      ],
      links: [{ href: "/contact?topic=enterprise", label: "咨询企业开通" }],
    },
    {
      id: "updates",
      title: "更新",
      summary: "Lily 会自动检查新版本。",
      blocks: [
        { type: "list", items: [
          "Lily 运行时会自动检查更新。新版本在后台下载，准备好后提示你重启完成安装。",
          "新版本可能分批推送，同事比你早收到更新是正常的。",
          "个别重要更新需要安装后才能继续使用，Lily 会明确提示。",
          "想手动更新时，从下载页重新下载安装即可；重新安装通常不会影响你的工作区文件夹。",
        ] },
      ],
      links: [
        { href: "/changelog", label: "查看更新日志" },
        { href: "/download", label: "前往下载页" },
      ],
    },
    {
      id: "privacy",
      title: "隐私与数据",
      summary: "常见问题。完整说明以法律与隐私中心的文件为准。",
      blocks: [
        { type: "faq", items: [
          ["我的对话和文件存在哪里？", "对话记录、工作区和生成的文件默认保存在你的电脑上，或你选择的文件夹里。Lily 不会因为文件在工作区里，就自动把整个文件夹上传到 Lily 的服务器。"],
          ["哪些内容会发送出去？", "你让 AI 处理任务时，你的提示词，以及完成任务所需的文件内容或摘录，会发送到你选择的模型服务；使用联网搜索、语音、图片或视频生成时，所需内容也会发送给相应的服务。使用平台提供的模型时，请求由 Lily 的网关转发，并记录计费所需的用量信息。"],
          ["文档解析在哪里完成？", "读取 Office 与 PDF、识别扫描件文字、转换格式，都在你的电脑上完成。解析出的内容在需要时会作为上下文发送给模型。"],
          ["使用自己的模型 Key 呢？", "请求会发往你配置的服务商，并按该服务商的规则处理。发送前请确认它的服务器所在地和数据保留政策。"],
          ["反馈问题时会上传什么？", "你主动提交反馈时，会附带诊断报告和脱敏后的日志片段，帮助我们排查问题。提交前请检查截图和描述里是否有敏感信息。"],
          ["怎样删除我的数据？", "本地数据由你自己删除；账号注销和服务端数据删除，请按“账号与数据删除”页面的说明申请。"],
        ] },
      ],
      links: [
        { href: "/legal/data-and-third-parties", label: "个人信息与第三方清单" },
        { href: "/privacy", label: "隐私政策" },
        { href: "/account-deletion", label: "账号与数据删除" },
      ],
    },
    {
      id: "support",
      title: "联系支持",
      summary: "遇到问题，告诉我们。",
      blocks: [
        { type: "list", items: [
          "在 Lily 中打开“意见反馈”描述问题；默认附带的诊断信息能帮我们更快定位。",
          "通过官网联系表单留言，我们会尽快回复。",
          `发送邮件至 ${EMAIL}。`,
          "企业开通、采购或额度问题，请在联系表单中选择“企业开通与采购”。",
        ] },
      ],
      links: [
        { href: "/contact", label: "联系我们" },
        { href: "/contact?topic=enterprise", label: "企业咨询" },
      ],
    },
  ],
};

const en = {
  meta: {
    title: "Help center",
    description: "Install, sign in, workspaces, delivered files, organization budgets and privacy: how to use Lily Workbench.",
  },
  eyebrow: "Help center",
  title: "From install to delivery, on one page.",
  lead: "Lily is an AI work assistant that runs on your computer. Describe the work in plain language; Lily reads the material, does the work, and checks it before handing it over.",
  navLabel: "Help contents",
  mobileNav: "Contents",
  onThisPage: "On this page",
  sections: [
    {
      id: "install",
      title: "Get started",
      summary: "Install Lily in a few minutes and start your first task.",
      blocks: [
        { type: "sub", text: "Requirements" },
        { type: "list", items: [
          "macOS: a Mac with Apple silicon (M series) or an Intel processor.",
          "Windows: a 64-bit Windows PC.",
          "The installer includes everything needed to work with Word, Excel, PowerPoint and PDF files. You do not need to install Office, Python or anything else.",
        ] },
        { type: "sub", text: "Install on a Mac" },
        { type: "steps", items: [
          "Open the download page and pick the installer for your Mac's chip. Not sure? Choose Apple menu → About This Mac and look at \"Chip\".",
          "Double-click the downloaded DMG and drag Lily into the Applications folder.",
          "Open Lily from Applications or Launchpad. If macOS asks whether to open an app downloaded from the internet, confirm.",
        ] },
        { type: "sub", text: "Install on Windows" },
        { type: "steps", items: [
          "Open the download page and download the Windows installer.",
          "Double-click the installer and follow the prompts. If Windows shows a security prompt, first make sure the file came from lilywb.cn.",
          "Open Lily from the Start menu or the desktop shortcut.",
        ] },
        { type: "sub", text: "First launch" },
        { type: "steps", items: [
          "Sign in with your phone number and an SMS code, or with the company account your organization gave you.",
          "Choose a workspace: an existing folder or a new one.",
          "Describe what you need in the message box, for example \"Put the payment terms of this contract into a table\".",
        ] },
        { type: "note", text: "Heavier capabilities such as professional PDF parsing, browser automation and audio or video processing are not bundled. Lily offers to download them the first time you need one, so it stays light on an ordinary laptop." },
      ],
      links: [{ href: "/download", label: "Go to downloads" }],
    },
    {
      id: "account",
      title: "Sign-in and account",
      summary: "Two ways to sign in. Use the one that fits you.",
      blocks: [
        { type: "sub", text: "Phone number and code" },
        { type: "steps", items: [
          "On the sign-in screen, enter your phone number and choose \"Get code\".",
          "Enter the SMS code to sign in. The first sign-in creates an account for that number.",
        ] },
        { type: "sub", text: "Company account (login name and password)" },
        { type: "p", text: "If your company set up a company account for you, an administrator gives you a login name and a one-time password." },
        { type: "steps", items: [
          "On the sign-in screen, switch to \"Company account\" and enter the login name and one-time password.",
          "At first sign-in you are asked to set a new password; the one-time password stops working once you do.",
          "If you forget your password, ask your organization's administrator to reset it.",
        ] },
        { type: "sub", text: "Free trial and balance" },
        { type: "list", items: [
          "A new account receives a free trial allowance for the models the platform provides. You do not need your own API key.",
          "See your balance, validity and usage in Lily under Settings → Account; see your orders on the website account page.",
          "When the allowance runs out, buy more on the pricing page, or connect your own model key in Lily.",
        ] },
      ],
      links: [
        { href: "/pricing", label: "See pricing" },
        { href: "/account", label: "Website account" },
      ],
    },
    {
      id: "workspace",
      title: "Workspaces and files",
      summary: "A workspace is a folder on your computer.",
      blocks: [
        { type: "p", text: "Each Lily workspace is an ordinary folder on your computer. A workspace keeps its own conversations, history and the project conventions Lily remembers, separate from the others. Create one per project or client if you like." },
        { type: "sub", text: "Add files" },
        { type: "list", items: [
          "Put files in the workspace folder and Lily can find them.",
          "Or drag files into the message box to attach them to this turn.",
          "Name the file you mean, for example \"look at quote.xlsx\", and Lily reads it first.",
        ] },
        { type: "sub", text: "What Lily reads" },
        { type: "list", items: [
          "Files you attach or name, and the workspace files the current task needs.",
          "Word, Excel, PowerPoint, PDF, images, scans, text and code files. Text in scans and images is recognized first.",
          "Very long PDFs and very large spreadsheets are processed in parts. If Lily read only part of something, it tells you.",
        ] },
        { type: "note", text: "Lily does not upload a whole folder to Lily's servers just because it is your workspace. For what is sent to model services, see Privacy and data below." },
        { type: "sub", text: "Changes can be undone" },
        { type: "p", text: "Every round of changes Lily makes to your files is saved as a version. You can preview it, undo a single change or restore an earlier state; restoring does not delete other files you put there yourself." },
      ],
      links: [],
    },
    {
      id: "delivery",
      title: "Conversations and deliverables",
      summary: "Say what result you need. Lily does the work and checks it.",
      blocks: [
        { type: "sub", text: "Ask for the result" },
        { type: "p", text: "Instead of asking how to do something, say what you want delivered. A good request covers three things: the result, the material to base it on, and who will read it." },
        { type: "list", items: [
          "\"From these three weekly reports, write a one-page monthly summary for my manager, as a Word file.\"",
          "\"Summarize sales.xlsx by region, flag unusual orders and draw a trend chart.\"",
          "\"Turn this proposal into a 10-slide deck in the style of template.pptx.\"",
        ] },
        { type: "sub", text: "How Lily gets it done" },
        { type: "steps", items: [
          "Reads: opens your files and related material, and checks facts online when needed, citing sources.",
          "Works: organizes data, writes content, creates or edits files.",
          "Checks before delivery: documents are rendered page by page to check the layout, and code is actually run. Anything uncertain is stated plainly.",
        ] },
        { type: "sub", text: "Where files go" },
        { type: "list", items: [
          "Files Lily creates are saved in the current workspace folder by default.",
          "A file card appears in the conversation. Open the file from it, or show it in its folder.",
          "Not quite right? Say what to change and Lily keeps editing the same file.",
        ] },
        { type: "note", text: "Lily asks before risky actions such as sending email, submitting forms or deleting data. To add a requirement while a task is running, just type it; there is no need to start over." },
      ],
      links: [],
    },
    {
      id: "apps-skills",
      title: "Apps and skills",
      summary: "Skills make Lily better at a kind of work; apps give you a ready starting point.",
      blocks: [
        { type: "sub", text: "Skills" },
        { type: "p", text: "A skill is a focused method for a kind of task, such as Excel analysis, slide design review or web research. Lily includes more than 40 skills and picks the right ones for your request; you do not turn them on. To use a specific one, name it in your request." },
        { type: "sub", text: "Apps" },
        { type: "p", text: "An app combines a workspace, skills and templates into a scenario you can start right away, such as the mail assistant, video creation or the stock research starter workspace." },
        { type: "sub", text: "Install from the catalog" },
        { type: "steps", items: [
          "Browse the app and skill catalogs on this website to see what each one does.",
          "Install it with one click from the marketplace in Lily, or just tell Lily: \"Install the mail assistant for me\".",
          "Then describe your task in plain language and Lily uses it.",
        ] },
      ],
      links: [
        { href: "/apps", label: "Browse apps" },
        { href: "/skills", label: "Browse skills" },
      ],
    },
    {
      id: "enterprise",
      title: "Organization identity and budget",
      summary: "The identity you use Lily under decides who pays.",
      blocks: [
        { type: "sub", text: "Joining an organization" },
        { type: "p", text: "Organizations are opened for customers by the Lily platform. Members join in one of two ways:" },
        { type: "list", items: [
          "Phone invitation: an administrator adds your phone number. You become a member when you sign in to Lily with that number; until then the seat shows as pending.",
          "Company account: your company issues you a login name and a one-time password, which you change at first sign-in.",
        ] },
        { type: "sub", text: "Choosing your identity" },
        { type: "p", text: "In Lily, choose your identity under Settings → Account:" },
        { type: "list", items: [
          "An organization: model usage is paid only from that organization's pool and never from your personal balance.",
          "No organization (personal): only your personal balance is used.",
          "The two are never mixed. A change of identity applies from your next request.",
        ] },
        { type: "sub", text: "Weekly budget" },
        { type: "list", items: [
          "The platform funds the organization's pool, and administrators can give each member a weekly budget.",
          "Your weekly window starts the first time you use it and resets after 7 days.",
          "Once this week's budget is used up, requests under the organization wait for the next window; meanwhile you can switch to your personal identity and keep working.",
        ] },
        { type: "sub", text: "Frozen, paused or removed" },
        { type: "list", items: [
          "If the platform freezes the organization, an administrator pauses it, or your membership is disabled, model requests under that organization are refused. Lily tells you why; contact your administrator or switch to your personal identity.",
          "If you are removed from the organization, Lily switches you to your personal identity and later usage comes from your personal balance.",
        ] },
        { type: "note", text: "Organization administrators can see members' usage and a history of changes to the organization's settings." },
      ],
      links: [{ href: "/contact?topic=enterprise", label: "Talk to us about organizations" }],
    },
    {
      id: "updates",
      title: "Updates",
      summary: "Lily checks for new versions automatically.",
      blocks: [
        { type: "list", items: [
          "Lily checks for updates while it runs. A new version downloads in the background and Lily asks you to restart when it is ready.",
          "Versions may roll out in stages, so a colleague can get an update before you.",
          "A few important updates must be installed before you can continue; Lily says so clearly.",
          "To update by hand, download and install again from the download page; reinstalling normally leaves your workspace folders alone.",
        ] },
      ],
      links: [
        { href: "/changelog", label: "Read the changelog" },
        { href: "/download", label: "Go to downloads" },
      ],
    },
    {
      id: "privacy",
      title: "Privacy and data",
      summary: "Common questions. The documents in the legal and privacy center are authoritative.",
      blocks: [
        { type: "faq", items: [
          ["Where are my conversations and files kept?", "Conversation history, workspaces and generated files are stored on your computer by default, or in folders you choose. Lily does not upload a whole folder to Lily's servers just because it is your workspace."],
          ["What is sent out?", "When you ask the AI to work on something, your prompt and the file content or excerpts the task needs are sent to the model service you chose. Web search, speech, image and video generation likewise send what they need to the respective service. With the platform's models, requests pass through Lily's gateway, which records the usage needed for billing."],
          ["Where are documents parsed?", "Reading Office and PDF files, recognizing text in scans and converting formats happen on your computer. The extracted content is sent to the model as context when a task needs it."],
          ["What if I use my own model key?", "Requests go to the provider you configured and are handled under that provider's terms. Check where its servers are and how long it keeps data before sending anything."],
          ["What does a feedback report include?", "When you choose to send feedback, it includes a diagnostic report and a redacted excerpt of the logs to help us find the problem. Check screenshots and descriptions for sensitive information before sending."],
          ["How do I delete my data?", "You delete local data yourself. For account closure and deletion of server-side data, follow the account and data deletion page."],
        ] },
      ],
      links: [
        { href: "/legal/data-and-third-parties", label: "Personal information and third parties" },
        { href: "/privacy", label: "Privacy policy" },
        { href: "/account-deletion", label: "Account and data deletion" },
      ],
    },
    {
      id: "support",
      title: "Contact support",
      summary: "Something not working? Tell us.",
      blocks: [
        { type: "list", items: [
          "In Lily, open Feedback and describe the problem; the diagnostics attached by default help us find it faster.",
          "Leave a message through the contact form on this website and we reply as soon as we can.",
          `Email ${EMAIL}.`,
          "For organization setup, purchasing or budgets, choose \"Organizations and purchasing\" in the contact form.",
        ] },
      ],
      links: [
        { href: "/contact", label: "Contact us" },
        { href: "/contact?topic=enterprise", label: "Organization enquiries" },
      ],
    },
  ],
};

const ar = {
  meta: {
    title: "مركز المساعدة",
    description: "التثبيت وتسجيل الدخول ومساحات العمل والملفات المسلَّمة وميزانيات المؤسسات والخصوصية: دليل استخدام Lily Workbench.",
  },
  eyebrow: "مركز المساعدة",
  title: "من التثبيت إلى التسليم، في صفحة واحدة.",
  lead: "Lily مساعد عمل بالذكاء الاصطناعي يعمل على حاسوبك. صف العمل بلغتك المعتادة، فتقرأ Lily المواد وتنجز العمل وتتحقق منه قبل تسليمه.",
  navLabel: "محتويات المساعدة",
  mobileNav: "المحتويات",
  onThisPage: "في هذه الصفحة",
  sections: [
    {
      id: "install",
      title: "البدء",
      summary: "ثبّت Lily في دقائق وابدأ أول مهمة.",
      blocks: [
        { type: "sub", text: "المتطلبات" },
        { type: "list", items: [
          "macOS: جهاز Mac بشريحة Apple (سلسلة M) أو بمعالج Intel.",
          "Windows: حاسوب يعمل بنظام Windows ‏64 بت.",
          "يتضمن المثبّت كل ما يلزم للعمل مع ملفات Word وExcel وPowerPoint وPDF، فلا حاجة إلى تثبيت Office أو Python أو غيرهما.",
        ] },
        { type: "sub", text: "التثبيت على Mac" },
        { type: "steps", items: [
          "افتح صفحة التنزيل واختر المثبّت المناسب لشريحة جهازك. إن لم تكن متأكداً فاختر قائمة Apple ← حول هذا الـMac وانظر إلى خانة «الشريحة».",
          "انقر نقراً مزدوجاً على ملف DMG ثم اسحب Lily إلى مجلد التطبيقات.",
          "افتح Lily من التطبيقات أو Launchpad. إذا سألك النظام عن فتح تطبيق من الإنترنت فأكّد ذلك.",
        ] },
        { type: "sub", text: "التثبيت على Windows" },
        { type: "steps", items: [
          "افتح صفحة التنزيل ونزّل مثبّت Windows.",
          "انقر نقراً مزدوجاً على المثبّت واتبع الخطوات. إذا ظهر تنبيه أمني فتأكد أولاً من أن الملف من موقع lilywb.cn.",
          "افتح Lily من قائمة ابدأ أو من اختصار سطح المكتب.",
        ] },
        { type: "sub", text: "التشغيل الأول" },
        { type: "steps", items: [
          "سجّل الدخول برقم هاتفك ورمز SMS، أو بحساب الشركة الذي أعطتك إياه مؤسستك.",
          "اختر مساحة عمل: مجلداً موجوداً أو مجلداً جديداً.",
          "صف ما تحتاجه في مربع الرسالة، مثل: «ضع شروط الدفع في هذا العقد في جدول».",
        ] },
        { type: "note", text: "القدرات الأثقل مثل التحليل الاحترافي لملفات PDF وأتمتة المتصفح ومعالجة الصوت والفيديو غير مضمّنة في المثبّت. تعرض Lily تنزيلها عند أول حاجة إليها، لتبقى خفيفة على الحاسوب المحمول العادي." },
      ],
      links: [{ href: "/download", label: "الانتقال إلى التنزيل" }],
    },
    {
      id: "account",
      title: "تسجيل الدخول والحساب",
      summary: "طريقتان لتسجيل الدخول، اختر ما يناسبك.",
      blocks: [
        { type: "sub", text: "رقم الهاتف ورمز التحقق" },
        { type: "steps", items: [
          "في شاشة تسجيل الدخول أدخل رقم هاتفك واختر «احصل على الرمز».",
          "أدخل رمز SMS لتسجيل الدخول. يُنشأ حساب لهذا الرقم عند أول تسجيل دخول.",
        ] },
        { type: "sub", text: "حساب الشركة (اسم الدخول وكلمة المرور)" },
        { type: "p", text: "إذا أنشأت شركتك حساباً لك، فسيعطيك المسؤول اسم دخول وكلمة مرور لمرة واحدة." },
        { type: "steps", items: [
          "في شاشة تسجيل الدخول انتقل إلى «حساب الشركة» وأدخل اسم الدخول وكلمة المرور المؤقتة.",
          "عند أول تسجيل دخول يُطلب منك تعيين كلمة مرور جديدة، وتتوقف كلمة المرور المؤقتة عن العمل بعدها.",
          "إذا نسيت كلمة المرور فاطلب من مسؤول مؤسستك إعادة تعيينها.",
        ] },
        { type: "sub", text: "التجربة المجانية والرصيد" },
        { type: "list", items: [
          "يحصل الحساب الجديد على رصيد تجربة مجاني لاستخدام النماذج التي توفرها المنصة، دون الحاجة إلى مفتاح API خاص بك.",
          "اعرض رصيدك وصلاحيته واستخدامك في Lily من الإعدادات ← الحساب، واعرض طلباتك في صفحة الحساب على الموقع.",
          "عند نفاد الرصيد يمكنك الشراء من صفحة الأسعار، أو ربط مفتاح نموذج خاص بك في Lily.",
        ] },
      ],
      links: [
        { href: "/pricing", label: "عرض الأسعار" },
        { href: "/account", label: "حساب الموقع" },
      ],
    },
    {
      id: "workspace",
      title: "مساحات العمل والملفات",
      summary: "مساحة العمل مجلد على حاسوبك.",
      blocks: [
        { type: "p", text: "كل مساحة عمل في Lily مجلد عادي على حاسوبك. لكل مساحة محادثاتها وسجلها وأعراف المشروع التي تتذكرها Lily، منفصلة عن غيرها. يمكنك إنشاء مساحة لكل مشروع أو عميل." },
        { type: "sub", text: "إضافة الملفات" },
        { type: "list", items: [
          "ضع الملفات في مجلد مساحة العمل لتتمكن Lily من العثور عليها.",
          "أو اسحب الملفات إلى مربع الرسالة لإرفاقها بهذه الجولة.",
          "سمِّ الملف الذي تقصده، مثل «انظر في quote.xlsx»، فتقرأه Lily أولاً.",
        ] },
        { type: "sub", text: "ما الذي تقرؤه Lily" },
        { type: "list", items: [
          "الملفات التي ترفقها أو تسمّيها، وملفات مساحة العمل التي تحتاجها المهمة الحالية.",
          "ملفات Word وExcel وPowerPoint وPDF والصور والمستندات الممسوحة والنصوص والشيفرات. يُتعرَّف أولاً على النص في الصور والمستندات الممسوحة.",
          "تُعالَج ملفات PDF الطويلة جداً والجداول الكبيرة على أجزاء. وإذا قرأت Lily جزءاً فقط فستخبرك بذلك.",
        ] },
        { type: "note", text: "لا ترفع Lily مجلداً كاملاً إلى خوادم Lily لمجرد أنه مساحة عملك. لمعرفة ما يُرسل إلى خدمات النماذج، راجع قسم «الخصوصية والبيانات» أدناه." },
        { type: "sub", text: "يمكن التراجع عن التغييرات" },
        { type: "p", text: "تُحفظ كل جولة من تغييرات Lily على ملفاتك كنسخة. يمكنك معاينتها أو التراجع عن تغيير واحد أو استعادة حالة سابقة، ولا تحذف الاستعادة الملفات الأخرى التي وضعتها بنفسك." },
      ],
      links: [],
    },
    {
      id: "delivery",
      title: "المحادثات والتسليمات",
      summary: "قل ما النتيجة التي تريدها، وتنجز Lily العمل وتتحقق منه.",
      blocks: [
        { type: "sub", text: "اطلب النتيجة مباشرة" },
        { type: "p", text: "بدلاً من السؤال عن طريقة العمل، قل ما الذي تريد تسليمه. الطلب الجيد يوضح ثلاثة أمور: النتيجة، والمواد التي تستند إليها، ومن سيقرؤها." },
        { type: "list", items: [
          "«من هذه التقارير الأسبوعية الثلاثة، اكتب ملخصاً شهرياً في صفحة واحدة لمديري، كملف Word».",
          "«لخّص sales.xlsx حسب المنطقة، وحدد الطلبات غير المعتادة، وارسم مخطط الاتجاه».",
          "«حوّل هذا المقترح إلى عرض من 10 شرائح بأسلوب template.pptx».",
        ] },
        { type: "sub", text: "كيف تنجز Lily العمل" },
        { type: "steps", items: [
          "تقرأ: تفتح ملفاتك والمواد ذات الصلة، وتتحقق من الحقائق عبر الإنترنت عند الحاجة مع ذكر المصادر.",
          "تعمل: ترتب البيانات وتكتب المحتوى وتنشئ الملفات أو تعدّلها.",
          "تتحقق قبل التسليم: تُعرض المستندات صفحة صفحة لفحص التنسيق، وتُشغَّل الشيفرة فعلياً، ويُذكر أي أمر غير مؤكد بوضوح.",
        ] },
        { type: "sub", text: "أين تُحفظ الملفات" },
        { type: "list", items: [
          "تُحفظ الملفات التي تنشئها Lily افتراضياً في مجلد مساحة العمل الحالية.",
          "تظهر بطاقة ملف في المحادثة، يمكنك منها فتح الملف أو إظهاره في مجلده.",
          "إن لم تكن النتيجة كما تريد، فقل ما الذي يجب تغييره وتواصل Lily تعديل الملف نفسه.",
        ] },
        { type: "note", text: "تستأذنك Lily قبل الإجراءات الحساسة مثل إرسال البريد أو إرسال النماذج أو حذف البيانات. ولإضافة متطلب أثناء تنفيذ مهمة، اكتبه مباشرة دون الحاجة إلى البدء من جديد." },
      ],
      links: [],
    },
    {
      id: "apps-skills",
      title: "التطبيقات والمهارات",
      summary: "المهارات تجعل Lily أمهر في نوع من العمل، والتطبيقات تمنحك نقطة بداية جاهزة.",
      blocks: [
        { type: "sub", text: "المهارات" },
        { type: "p", text: "المهارة طريقة مركّزة لنوع من المهام، مثل تحليل Excel ومراجعة تصميم الشرائح والبحث عبر الإنترنت. تتضمن Lily أكثر من 40 مهارة وتختار المناسب منها لطلبك دون أن تحتاج إلى تفعيلها. ولاستخدام مهارة بعينها، سمّها في طلبك." },
        { type: "sub", text: "التطبيقات" },
        { type: "p", text: "يجمع التطبيق مساحة عمل ومهارات وقوالب في سيناريو يمكنك البدء به فوراً، مثل مساعد البريد وإنشاء الفيديو ومساحة أبحاث الأسهم التجريبية." },
        { type: "sub", text: "التثبيت من الدليل" },
        { type: "steps", items: [
          "تصفح دليلي التطبيقات والمهارات على هذا الموقع لمعرفة ما يفعله كل منها.",
          "ثبّته بنقرة من المتجر داخل Lily، أو قل لـLily ببساطة: «ثبّت مساعد البريد».",
          "ثم صف مهمتك بلغتك المعتادة وستستخدمه Lily.",
        ] },
      ],
      links: [
        { href: "/apps", label: "تصفح التطبيقات" },
        { href: "/skills", label: "تصفح المهارات" },
      ],
    },
    {
      id: "enterprise",
      title: "هوية المؤسسة والميزانية",
      summary: "الهوية التي تستخدم بها Lily تحدد من يدفع.",
      blocks: [
        { type: "sub", text: "الانضمام إلى مؤسسة" },
        { type: "p", text: "تفتح منصة Lily المؤسسات لعملائها. ينضم الأعضاء بإحدى طريقتين:" },
        { type: "list", items: [
          "دعوة عبر الهاتف: يضيف المسؤول رقم هاتفك، وتصبح عضواً عندما تسجّل الدخول إلى Lily بهذا الرقم؛ وحتى ذلك الحين يظهر المقعد قيد الانتظار.",
          "حساب الشركة: تصدر شركتك لك اسم دخول وكلمة مرور لمرة واحدة تغيّرها عند أول تسجيل دخول.",
        ] },
        { type: "sub", text: "اختيار الهوية" },
        { type: "p", text: "في Lily، اختر هويتك من الإعدادات ← الحساب:" },
        { type: "list", items: [
          "مؤسسة: يُدفع استخدام النماذج من رصيد تلك المؤسسة فقط، ولا يُخصم من رصيدك الشخصي.",
          "بلا مؤسسة (شخصي): يُستخدم رصيدك الشخصي فقط.",
          "لا يُخلط الرصيدان أبداً، ويسري تغيير الهوية من طلبك التالي.",
        ] },
        { type: "sub", text: "الميزانية الأسبوعية" },
        { type: "list", items: [
          "تموّل المنصة رصيد المؤسسة، ويمكن للمسؤولين منح كل عضو ميزانية أسبوعية.",
          "تبدأ دورتك الأسبوعية عند أول استخدام لها وتُعاد بعد 7 أيام.",
          "عند استنفاد ميزانية الأسبوع، تنتظر الطلبات باسم المؤسسة الدورة التالية، ويمكنك خلال ذلك التحول إلى هويتك الشخصية ومواصلة العمل.",
        ] },
        { type: "sub", text: "التجميد أو الإيقاف أو الإزالة" },
        { type: "list", items: [
          "إذا جمّدت المنصة المؤسسة أو أوقفها المسؤول أو عُطّلت عضويتك، تُرفض طلبات النماذج باسم تلك المؤسسة. تخبرك Lily بالسبب، ويمكنك التواصل مع المسؤول أو التحول إلى هويتك الشخصية.",
          "إذا أُزلت من المؤسسة، تحوّلك Lily إلى هويتك الشخصية ويُخصم الاستخدام اللاحق من رصيدك الشخصي.",
        ] },
        { type: "note", text: "يمكن لمسؤولي المؤسسة رؤية استخدام الأعضاء وسجل التغييرات على إعدادات المؤسسة." },
      ],
      links: [{ href: "/contact?topic=enterprise", label: "تواصل معنا بشأن المؤسسات" }],
    },
    {
      id: "updates",
      title: "التحديثات",
      summary: "تتحقق Lily من الإصدارات الجديدة تلقائياً.",
      blocks: [
        { type: "list", items: [
          "تتحقق Lily من التحديثات أثناء عملها. يُنزَّل الإصدار الجديد في الخلفية، وتطلب منك Lily إعادة التشغيل عندما يصبح جاهزاً.",
          "قد تُطرح الإصدارات على مراحل، لذا قد يحصل زميلك على التحديث قبلك.",
          "بعض التحديثات المهمة يجب تثبيتها قبل المتابعة، وتوضح Lily ذلك.",
          "للتحديث يدوياً، نزّل المثبّت من صفحة التنزيل وثبّته مجدداً؛ ولا تمس إعادة التثبيت عادةً مجلدات مساحات العمل.",
        ] },
      ],
      links: [
        { href: "/changelog", label: "سجل التحديثات" },
        { href: "/download", label: "الانتقال إلى التنزيل" },
      ],
    },
    {
      id: "privacy",
      title: "الخصوصية والبيانات",
      summary: "أسئلة شائعة. الوثائق في مركز الخصوصية والشؤون القانونية هي المرجع.",
      blocks: [
        { type: "faq", items: [
          ["أين تُحفظ محادثاتي وملفاتي؟", "تُحفظ سجلات المحادثات ومساحات العمل والملفات المنشأة افتراضياً على حاسوبك أو في المجلدات التي تختارها. ولا ترفع Lily مجلداً كاملاً إلى خوادم Lily لمجرد أنه مساحة عملك."],
          ["ما الذي يُرسل إلى الخارج؟", "عندما تطلب من الذكاء الاصطناعي العمل على شيء، تُرسل مطالبتك ومحتوى الملفات أو المقتطفات التي تحتاجها المهمة إلى خدمة النموذج التي اخترتها. وكذلك يرسل البحث عبر الإنترنت وتوليد الصوت والصور والفيديو ما يلزم إلى الخدمة المعنية. ومع نماذج المنصة تمر الطلبات عبر بوابة Lily التي تسجّل الاستخدام اللازم للفوترة."],
          ["أين تُحلَّل المستندات؟", "تجري قراءة ملفات Office وPDF والتعرف على النص في المستندات الممسوحة وتحويل الصيغ على حاسوبك. ويُرسل المحتوى المستخرج إلى النموذج كسياق عندما تحتاجه المهمة."],
          ["ماذا لو استخدمت مفتاح نموذج خاصاً بي؟", "تذهب الطلبات إلى المزوّد الذي أعددته وتُعالَج وفق شروطه. تحقق من موقع خوادمه ومدة احتفاظه بالبيانات قبل الإرسال."],
          ["ماذا يتضمن تقرير الملاحظات؟", "عندما تختار إرسال ملاحظات، يتضمن ذلك تقريراً تشخيصياً ومقتطفاً منقّحاً من السجلات لمساعدتنا في إيجاد المشكلة. راجع لقطات الشاشة والوصف بحثاً عن معلومات حساسة قبل الإرسال."],
          ["كيف أحذف بياناتي؟", "تحذف البيانات المحلية بنفسك. أما إغلاق الحساب وحذف البيانات على الخادم فاتبع فيهما صفحة حذف الحساب والبيانات."],
        ] },
      ],
      links: [
        { href: "/legal/data-and-third-parties", label: "المعلومات الشخصية والجهات الخارجية" },
        { href: "/privacy", label: "سياسة الخصوصية" },
        { href: "/account-deletion", label: "حذف الحساب والبيانات" },
      ],
    },
    {
      id: "support",
      title: "التواصل مع الدعم",
      summary: "هل هناك ما لا يعمل؟ أخبرنا.",
      blocks: [
        { type: "list", items: [
          "في Lily افتح «الملاحظات» وصف المشكلة؛ تساعدنا المعلومات التشخيصية المرفقة افتراضياً على إيجادها أسرع.",
          "اترك رسالة عبر نموذج التواصل على هذا الموقع وسنرد في أقرب وقت.",
          `راسلنا على ${EMAIL}.`,
          "لإعداد المؤسسات أو الشراء أو الميزانيات، اختر «المؤسسات والشراء» في نموذج التواصل.",
        ] },
      ],
      links: [
        { href: "/contact", label: "تواصل معنا" },
        { href: "/contact?topic=enterprise", label: "استفسارات المؤسسات" },
      ],
    },
  ],
};

export const docsCopy = { zh, en, ar };

export function docsCopyFor(locale) {
  return docsCopy[locale] || docsCopy.zh;
}
