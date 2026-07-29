const COMPANY = "北京科瑞普投艺术科技有限公司";
const EMAIL = "felix@lilywb.cn";
const UPDATED_ZH = "2026年7月29日";
const UPDATED_EN = "July 29, 2026";
const UPDATED_AR = "29 يوليو 2026";

const commonZh = {
  company: COMPANY,
  email: EMAIL,
  updated: UPDATED_ZH,
  labels: {
    updated: "最后更新",
    contents: "本页目录",
    contact: "联系我们",
    email: "发送邮件",
    home: "法律中心",
  },
};

const commonEn = {
  company: COMPANY,
  email: EMAIL,
  updated: UPDATED_EN,
  labels: {
    updated: "Last updated",
    contents: "On this page",
    contact: "Contact us",
    email: "Send email",
    home: "Legal center",
  },
};

const commonAr = {
  company: COMPANY,
  email: EMAIL,
  updated: UPDATED_AR,
  labels: {
    updated: "آخر تحديث",
    contents: "في هذه الصفحة",
    contact: "اتصل بنا",
    email: "إرسال بريد",
    home: "المركز القانوني",
  },
};

const zh = {
  common: commonZh,
  index: {
    eyebrow: "Lily Workbench",
    title: "法律与隐私中心",
    summary: "在这里了解 Lily 如何处理数据、使用第三方服务，以及您如何管理账号和个人信息。",
    principles: [
      ["默认本地", "对话记录、工作空间和生成文件默认保存在您的设备上。"],
      ["必要且透明", "仅在账号、授权、计费、诊断或您主动使用联网能力时处理必要数据。"],
      ["由您控制", "您可以管理本地文件，并申请查阅、更正、撤回授权或删除服务端个人信息。"],
    ],
    items: [
      { href: "/privacy", title: "隐私政策", body: "我们处理哪些信息、为何处理、如何保存，以及您的权利。" },
      { href: "/terms", title: "服务条款", body: "使用 Lily Workbench、AI 服务、技能和生成内容时适用的规则。" },
      { href: "/legal/data-and-third-parties", title: "个人信息与第三方清单", body: "按场景查看数据字段、目的、保存方式和服务接收方。" },
      { href: "/account-deletion", title: "账号与数据删除", body: "删除本地数据、提交账号注销或服务端数据删除申请。" },
    ],
  },
  privacy: {
    ...commonZh,
    eyebrow: "法律与隐私",
    title: "Lily Workbench 隐私政策",
    summary: `本政策说明 ${COMPANY}（“我们”）在提供 Lily Workbench 桌面应用、官网及相关服务时如何处理个人信息。`,
    notice: "重要提示：Lily 以本地工作空间为默认，但当您使用 AI、联网搜索、云端媒体生成、登录、支付、反馈或同步类能力时，完成该操作所需的数据会按本政策发送到相应服务。",
    sections: [
      {
        id: "scope",
        title: "1. 适用范围",
        paragraphs: [
          "本政策适用于 Lily Workbench 桌面应用、lilywb.cn 官网、账号与授权服务、模型及媒体网关、技能与运行时分发、客户支持和移动配对服务。",
          "您通过 Lily 配置并直接连接第三方 AI 服务时，第三方将依据其隐私规则独立处理相关数据；我们建议您同时阅读所选服务商的政策。",
        ],
      },
      {
        id: "local-data",
        title: "2. 默认保存在本地的信息",
        paragraphs: [
          "对话历史、工作空间目录、文件、索引、记忆、技能配置、生成文件和任务记录默认保存在您的设备或您选择的目录中。我们不会仅因为这些内容存在于工作空间就自动将完整目录上传到 Lily 服务端。",
          "卸载应用通常不会自动删除您自行选择的工作空间目录。应用配置和会话数据也可能保留在操作系统的应用数据目录，具体删除方法见“账号与数据删除”。",
        ],
      },
      {
        id: "collected-data",
        title: "3. 我们处理的信息",
        bullets: [
          "账号与认证：手机号、短信验证码的哈希值、登录会话、IP 地址、User-Agent、登录时间和风控结果。",
          "设备与授权：设备标识、设备指纹哈希、公钥、操作系统、架构、应用版本、授权码状态和最近连接时间。",
          "聚合用量与计费：模型标识、消息/图片/工具调用数量、输入输出 Token、能力类型、余额、订单、金额、支付渠道和支付状态。",
          "运行诊断：错误类型、阶段、会话状态、应用与运行时版本、脱敏摘要和诊断追踪。诊断可能包含您主动提交的故障上下文，请在提交前检查敏感信息。",
          "用户主动提交：联系表单中的姓名、邮箱、公司、电话、主题、留言、IP、附件；许愿池中的需求、期望结果和支持关系。",
          "官网技术数据：登录 Cookie、语言偏好 Cookie，以及移动配对页面保存在浏览器本地的设备标识。我们当前未在公开官网植入第三方广告追踪器。",
        ],
      },
      {
        id: "ai-transmission",
        title: "4. AI 与联网能力的数据传输",
        paragraphs: [
          "当您要求 AI 分析问题、文件、图片、语音或网页时，您的提示词，以及为完成任务而选择、提取或生成的必要内容，可能发送到您选择的模型、搜索、语音、图片或视频服务。Lily 的托管网关可能代为转发请求并记录计费所需的用量元数据，但不会把完整提示词写入聚合用量表。",
          "使用自带密钥（BYOK）或自定义接口时，请您自行确认接收方、服务器所在地、保留规则和跨境影响。发送他人的个人信息、商业秘密或敏感个人信息前，请确保具有合法依据和必要授权。",
        ],
      },
      {
        id: "purposes",
        title: "5. 处理目的与依据",
        bullets: [
          "履行产品服务：登录、授权、设备绑定、模型调用、文件处理、更新与运行时下载。",
          "履行交易：创建订单、确认支付、发放权益、记账、退款与处理争议。",
          "保障安全：短信风控、签名验证、防滥用、故障诊断、审计和服务稳定性。",
          "响应请求：处理咨询、反馈、删除申请和愿望审核。",
          "在取得同意或法律允许的范围内改进产品；您可以撤回基于同意的处理。",
        ],
      },
      {
        id: "retention",
        title: "6. 保存位置与期限",
        paragraphs: [
          "本地数据由您控制，保存至您主动删除。服务端数据按实现对应目的所需的最短期限保存：账号、授权和权益记录通常保存至账号注销或服务终止；未到期会话保存至到期或退出；订单、支付、账务、安全和审计记录按适用法律要求保存；联系、愿望、诊断和用量记录在处理完成后定期评估并删除或匿名化。",
          "若法律规定的保存期限尚未届满，或删除在技术上暂时难以实现，我们将停止除存储和安全保护外的其他处理。备份中的数据会在备份轮换周期内清除。",
        ],
      },
      {
        id: "sharing",
        title: "7. 委托处理、共享与第三方",
        paragraphs: [
          "我们不出售您的个人信息。为提供服务，我们可能向短信、云存储、AI 模型与媒体、支付、基础设施和您主动选择的自定义服务商提供最小必要信息。具体类别和场景见“个人信息与第三方清单”。",
          "依法应政府机关要求、保护用户或公众安全、处理争议，或在合并重组等情形转移业务时，我们可能依法披露或转移信息，并履行必要告知义务。",
        ],
      },
      {
        id: "cross-border",
        title: "8. 跨境处理",
        paragraphs: [
          "Lily 的国内服务默认部署在中国境内。若您选择境外模型、媒体服务、自定义接口或海外服务入口，模型请求、文件摘录、账号或设备相关数据可能发生跨境传输。我们会根据适用法律采取必要措施；需要单独同意时，将另行取得。",
          "接收方、处理目的、数据类型和所在地区取决于您的配置。请在发送敏感内容前查看第三方清单及所选服务商政策。",
        ],
      },
      {
        id: "security",
        title: "9. 安全措施",
        bullets: [
          "使用 HTTPS、请求签名、短期访问令牌、验证码哈希、密钥加密和权限控制保护传输与存储。",
          "对管理操作保留审计记录，并限制内部人员按职责访问。",
          "任何系统都无法保证绝对安全。如发生可能影响您权益的安全事件，我们将依法采取补救和通知措施。",
        ],
      },
      {
        id: "rights",
        title: "10. 您的权利",
        paragraphs: [
          `您可以申请查阅、复制、更正、补充、限制处理、撤回同意、注销账号或删除个人信息，也可以要求我们解释处理规则。请使用 ${EMAIL} 联系我们；我们会核验身份并在适用法律规定的期限内答复。`,
          "撤回同意不影响撤回前基于同意进行的处理。拒绝非必要处理不会影响基础功能；拒绝完成某项服务所必需的信息，可能导致该功能无法使用。",
        ],
      },
      {
        id: "children",
        title: "11. 未成年人",
        paragraphs: [
          "Lily Workbench 面向具备完全民事行为能力的工作用户，不专门面向不满十四周岁的未成年人。未成年人应在监护人指导和同意下使用；如发现我们在未获适当同意时处理了未成年人信息，请联系我们删除。",
        ],
      },
      {
        id: "updates-contact",
        title: "12. 更新与联系我们",
        paragraphs: [
          `重大变更时，我们会通过官网、应用内提示或其他合理方式告知。对本政策有疑问、投诉或希望行使权利，请发送邮件至 ${EMAIL}。个人信息处理者：${COMPANY}。网站：https://lilywb.cn。`,
        ],
      },
    ],
  },
  terms: {
    ...commonZh,
    eyebrow: "法律与隐私",
    title: "Lily Workbench 服务条款",
    summary: `本条款是您与 ${COMPANY} 之间关于使用 Lily Workbench 及相关服务的约定。`,
    notice: "使用产品前请阅读本条款。您代表组织使用 Lily 时，应确保已获得相应授权并遵守组织的数据与安全要求。",
    sections: [
      { id: "service", title: "1. 服务内容", paragraphs: ["Lily 提供本地桌面工作空间、AI 代理、文件处理、技能、可选运行时、账号授权、云端模型及媒体调用等功能。实际能力可能因版本、地区、套餐、设备和第三方服务而不同。"] },
      { id: "account", title: "2. 账号与授权", bullets: ["您应提供真实、有效的信息并妥善保管设备、验证码、授权码和 API 密钥。", "账号和授权仅限约定主体、席位及用途，不得转售、绕过设备限制或帮助他人规避安全控制。", "发现异常使用时，请及时退出会话并联系我们。"] },
      { id: "acceptable-use", title: "3. 合法与可接受使用", paragraphs: ["您不得使用 Lily 侵害他人权益、传播违法内容、攻击系统、窃取数据、规避权限或生成法律禁止的内容。您应确保有权处理输入的文件、个人信息和知识产权材料。"] },
      { id: "ai", title: "4. AI 输出与人工复核", paragraphs: ["AI 输出可能不准确、不完整或具有时效限制，不构成法律、医疗、财务或其他专业意见。高风险决定、对外发布、合同、数据和代码变更应由具备资格的人复核。", "您应审查工具执行范围和交付物。Lily 不保证任何模型、技能或第三方接口持续可用。"] },
      { id: "content", title: "5. 您的内容与生成内容", paragraphs: ["您保留对合法输入内容的权利，并授权 Lily 在提供所请求服务的必要范围内处理这些内容。在法律允许且不侵犯第三方权利的前提下，您可使用生成结果；生成结果可能与他人结果相似，也可能受第三方模型条款约束。"] },
      { id: "third-parties", title: "6. 第三方服务与开源组件", paragraphs: ["模型、支付、短信、云存储、搜索、技能和运行时可能由第三方提供，并受其条款约束。选择自定义服务或自带密钥时，您与该服务商之间的费用、权限和数据处理由相应协议决定。"] },
      { id: "payment", title: "7. 费用、订阅与退款", paragraphs: ["价格、资源额度、有效期和支付方式以购买页面和订单为准。除法律另有规定或页面另有说明外，已消耗的数字服务不支持退款。支付失败、退款或拒付可能导致相关权益调整。"] },
      { id: "updates", title: "8. 更新、暂停与终止", paragraphs: ["我们可能为安全、合规、维护或产品改进更新服务。对违法、滥用、危害安全、长期欠费或违反本条款的使用，我们可采取限制、暂停或终止措施，并在合理可行时提供通知和申诉渠道。"] },
      { id: "disclaimer", title: "9. 责任边界", paragraphs: ["我们将以合理的专业注意提供服务，但不承诺无中断、无错误或适合所有特定目的。对不可抗力、第三方故障、用户配置、未按提示复核或超出合理控制范围导致的损失，责任按适用法律确定；本条款不排除法律不得排除的责任。"] },
      { id: "law", title: "10. 法律适用与联系", paragraphs: [`本条款适用中华人民共和国法律。争议应先友好协商；协商不成的，依法向有管辖权的人民法院提起诉讼。问题请联系 ${EMAIL}。我们可能更新条款，重大变化将以合理方式告知。`] },
    ],
  },
  data: {
    ...commonZh,
    eyebrow: "透明度清单",
    title: "个人信息与第三方服务清单",
    summary: "这份清单把隐私政策拆成可核对的处理场景。具体供应商会因地区、管理员配置和您选择的功能而变化。",
    notice: "只有在使用对应功能时才会发生相关处理。AI 供应商是可配置的；Lily 不会把所有数据同时发送给下列所有服务。",
    sections: [
      {
        id: "data-list",
        title: "1. 个人信息处理清单",
        rows: [
          ["登录与短信", "手机号、验证码哈希、IP、User-Agent、设备标识、风控结果", "登录、反滥用与账号安全", "会话到期或注销；安全记录依法保留"],
          ["设备与授权", "设备标识、指纹哈希、公钥、平台、架构、版本、授权状态", "激活、席位控制、配置与更新", "授权或账号存续期间及必要审计期限"],
          ["聚合用量", "日期、模型、消息/图片/工具数量、Token 数", "额度展示、计费、容量与产品改进", "实现目的所需最短期限后删除或匿名化"],
          ["运行诊断", "错误类型、阶段、版本、脱敏摘要与追踪", "排障、安全和稳定性", "排障完成后定期评估删除"],
          ["AI 与媒体", "提示词、选中的文件内容或摘录、图片、音频、生成参数", "生成回复、识图、语音、图片或视频", "由所选服务商规则决定；Lily 网关不在聚合用量表保存完整提示词"],
          ["联系与反馈", "姓名、邮箱、公司、电话、留言、附件、IP", "回复咨询、支持和售前服务", "处理完成后按必要期限保存"],
          ["许愿池", "账号、原始需求、期望结果、支持关系", "审核需求并展示经审核的公开摘要", "账号或愿望存续期间；公开前原文不公开"],
          ["交易与权益", "订单、金额、渠道、支付状态、余额与流水", "完成交易、发放权益、财务审计", "按交易、税务和会计法律要求保存"],
        ],
      },
      {
        id: "third-parties",
        title: "2. 第三方服务清单",
        rows: [
          ["阿里云短信", "发送登录验证码", "手机号、验证码模板参数", "仅在短信登录时"],
          ["七牛云", "安装包、技能、运行时和反馈附件存储/CDN", "用户主动上传的反馈附件及文件元数据", "不用于自动上传本地工作空间"],
          ["支付宝 / 微信支付", "订单支付、回调与退款", "订单号、金额、支付状态及支付方要求的信息", "仅在选择相应支付方式时"],
          ["阿里云百炼 / DashScope", "可选聊天、嵌入、识图、语音、图片或视频", "为请求所需的提示词、媒体或摘录", "托管配置或用户主动选择时"],
          ["DeepSeek、Moonshot、智谱", "可选聊天或媒体模型", "为请求所需的提示词、媒体或摘录", "由管理员配置或用户主动选择时"],
          ["火山引擎、可灵、MiniMax", "可选图片或视频生成", "生成提示词、参考媒体和参数", "用户主动选择对应媒体能力时"],
          ["自定义 AI / BYOK 服务", "用户配置的模型、搜索、MCP 或媒体能力", "用户指示发送的请求内容", "接收方和地区由用户配置决定"],
          ["基础设施服务", "服务器、网络、防护、备份与邮件", "提供服务所必需的日志和通信数据", "按最小必要原则"],
        ],
      },
      {
        id: "cross-border",
        title: "3. 跨境与变更",
        paragraphs: [
          "部分模型或自定义服务可能位于中国境外。发生跨境处理时，接收方、目的、方式、数据类别和权利行使路径以您选择的供应商及其政策为准；法律要求单独同意时，我们将另行取得。",
          `供应商或用途发生实质变化时，我们会更新本清单。查询当前配置或行使权利，请联系 ${EMAIL}。`,
        ],
      },
    ],
  },
  deletion: {
    ...commonZh,
    eyebrow: "账号与数据",
    title: "账号与数据删除说明",
    summary: "您可以独立删除本地工作内容，也可以申请注销 Lily 账号并删除服务端个人信息。",
    notice: "当前版本尚未提供应用内一键注销。账号注销和服务端删除申请由人工核验处理；这不会阻止您立即删除自己设备上的本地数据。",
    sections: [
      { id: "local", title: "1. 删除本地工作数据", bullets: ["先退出正在运行的任务并备份仍需保留的文件。", "在 Lily 中删除不再需要的会话、项目或工作空间引用。", "在文件管理器中删除您选择的工作空间目录及其中的生成文件。", "如需彻底清理应用状态，请退出 Lily 后删除操作系统为 Lily Workbench 保存的应用数据目录；仅卸载应用不保证删除工作空间和应用数据。"] },
      { id: "request", title: "2. 申请账号注销或服务端数据删除", paragraphs: [`使用注册手机号可接收邮件的安全方式发送申请至 ${EMAIL}，主题写“Lily 账号注销/数据删除申请”。邮件中提供注册手机号的后四位、常用设备平台以及希望执行的操作；不要发送验证码、完整授权密钥或 API Key。`], bullets: ["注销账号并撤销登录会话。", "删除或匿名化可依法删除的账号、设备、用量、诊断、联系或愿望数据。", "仅删除某一类记录，或申请查阅、更正、复制和限制处理。"] },
      { id: "verify", title: "3. 身份核验", paragraphs: ["为防止他人恶意删除您的账号，我们可能通过注册手机号验证、现有会话或必要的设备信息核验身份。我们只要求完成核验所必需的信息。"] },
      { id: "effect", title: "4. 注销影响", bullets: ["账号会话、未使用权益、设备绑定和账号功能可能无法恢复。", "本地工作空间不会因服务端账号注销自动删除，仍需由您在设备上处理。", "公开愿望中的审核摘要可在去标识化后保留；您可以在申请中要求我们评估删除。"] },
      { id: "exceptions", title: "5. 不能立即删除的情形", paragraphs: ["交易、税务、会计、审计、安全、争议处理或法律义务要求保留的记录，将在法定期限内限制处理并安全保存；期限届满后删除或匿名化。备份数据会随备份轮换清除。"] },
      { id: "timing", title: "6. 处理时间与申诉", paragraphs: [`我们会在收到申请后确认受理，并在完成身份核验后按适用法律规定的期限处理。如拒绝请求，我们会说明原因和申诉方式。未收到回复或对结果有异议，请再次联系 ${EMAIL}。`] },
    ],
  },
  footer: {
    privacy: "隐私政策",
    terms: "服务条款",
    data: "信息与第三方",
    deletion: "账号删除",
  },
};

function translated(locale, language) {
  const common = language === "ar" ? commonAr : commonEn;
  const isAr = language === "ar";
  const copy = {
    common,
    index: {
      eyebrow: "Lily Workbench",
      title: isAr ? "المركز القانوني والخصوصية" : "Legal and privacy center",
      summary: isAr
        ? "تعرّف على كيفية معالجة Lily للبيانات واستخدام الخدمات الخارجية وكيفية إدارة حسابك ومعلوماتك."
        : "Learn how Lily handles data, uses third-party services, and lets you manage your account and information.",
      principles: isAr
        ? [["محلي افتراضياً", "تبقى المحادثات ومساحات العمل والملفات الناتجة على جهازك افتراضياً."], ["ضروري وشفاف", "نعالج البيانات اللازمة فقط عند استخدام الحساب أو الترخيص أو الدفع أو التشخيص أو الميزات المتصلة."], ["تحت سيطرتك", "يمكنك إدارة الملفات المحلية وطلب الوصول أو التصحيح أو السحب أو الحذف."]]
        : [["Local by default", "Chats, workspaces, and generated files stay on your device by default."], ["Necessary and transparent", "We process required data only for account, licensing, billing, diagnostics, or connected features you use."], ["Under your control", "Manage local files and request access, correction, withdrawal, or deletion."]],
      items: [
        { href: "/privacy", title: isAr ? "سياسة الخصوصية" : "Privacy Policy", body: isAr ? "البيانات التي نعالجها وأسباب المعالجة والحفظ وحقوقك." : "What we process, why, retention, security, and your rights." },
        { href: "/terms", title: isAr ? "شروط الخدمة" : "Terms of Service", body: isAr ? "قواعد استخدام Lily وخدمات الذكاء الاصطناعي والمهارات والمحتوى الناتج." : "Rules for Lily, AI services, skills, and generated content." },
        { href: "/legal/data-and-third-parties", title: isAr ? "البيانات والأطراف الثالثة" : "Data and third parties", body: isAr ? "حقول البيانات والأغراض وفئات المستلمين حسب السيناريو." : "Data fields, purposes, retention, and recipient categories by scenario." },
        { href: "/account-deletion", title: isAr ? "حذف الحساب والبيانات" : "Account and data deletion", body: isAr ? "حذف البيانات المحلية أو طلب إغلاق الحساب وحذف بيانات الخادم." : "Delete local data or request account closure and server-side deletion." },
      ],
    },
    footer: {
      privacy: isAr ? "الخصوصية" : "Privacy",
      terms: isAr ? "الشروط" : "Terms",
      data: isAr ? "البيانات والأطراف الثالثة" : "Data & third parties",
      deletion: isAr ? "حذف الحساب" : "Account deletion",
    },
  };

  const documents = {
    privacy: {
      eyebrow: isAr ? "القانون والخصوصية" : "Legal and privacy",
      title: isAr ? "سياسة خصوصية Lily Workbench" : "Lily Workbench Privacy Policy",
      summary: isAr ? `توضح هذه السياسة كيفية معالجة ${COMPANY} للمعلومات الشخصية عند تقديم Lily Workbench والموقع والخدمات ذات الصلة.` : `This policy explains how ${COMPANY} processes personal information when providing Lily Workbench, its website, and related services.`,
      notice: isAr ? "Lily محلي افتراضياً. عند استخدام الذكاء الاصطناعي أو البحث أو إنشاء الوسائط أو تسجيل الدخول أو الدفع أو الدعم، تُرسل البيانات اللازمة للخدمة التي اخترتها." : "Lily is local by default. When you use AI, search, media generation, sign-in, payment, feedback, or sync-like features, the data needed for that action is sent to the relevant service.",
      sections: [
        { id: "scope", title: isAr ? "1. النطاق" : "1. Scope", paragraphs: [isAr ? "تنطبق هذه السياسة على تطبيق سطح المكتب والموقع والحساب والترخيص وبوابات النماذج والوسائط وتوزيع المهارات والدعم والاقتران المحمول." : "This policy covers the desktop app, website, account and licensing services, model and media gateways, skill/runtime distribution, support, and mobile pairing."] },
        { id: "local", title: isAr ? "2. البيانات المحلية" : "2. Local data", paragraphs: [isAr ? "تبقى المحادثات ومساحات العمل والملفات والفهارس والذاكرة والمهارات والمخرجات وسجلات المهام على جهازك افتراضياً. لا يؤدي وجود ملف في مساحة العمل وحده إلى رفع المجلد كاملاً إلى خوادم Lily." : "Chats, workspaces, files, indexes, memory, skills, outputs, and task records stay on your device by default. A file existing in a workspace does not by itself upload the whole folder to Lily servers."] },
        { id: "data", title: isAr ? "3. البيانات التي نعالجها" : "3. Data we process", bullets: isAr ? ["الحساب: رقم الهاتف والجلسات وعنوان IP وبيانات مكافحة الإساءة.", "الجهاز والترخيص: معرّف الجهاز وبصمة مجزأة والمنصة والإصدار وحالة الترخيص.", "الاستخدام والفوترة: أعداد الرسائل والصور والأدوات والرموز والأرصدة والطلبات.", "التشخيص والدعم: أخطاء منزوعة الحساسية ورسائل ونماذج اتصال ومرفقات ورغبات.", "الموقع: ملفات تعريف ارتباط تسجيل الدخول واللغة ومعرّف اقتران محلي."] : ["Account: phone number, sessions, IP address, user agent, and abuse-prevention results.", "Device and license: device ID, hashed fingerprint, public key, platform, version, and license state.", "Usage and billing: model, message/image/tool counts, tokens, balances, orders, amount, and payment status.", "Diagnostics and submissions: error traces, support/contact details and attachments, and feature wishes.", "Website: sign-in and locale cookies, plus a mobile pairing ID stored locally in the browser."] },
        { id: "ai", title: isAr ? "4. الذكاء الاصطناعي والخدمات المتصلة" : "4. AI and connected services", paragraphs: [isAr ? "عند طلب تحليل نص أو ملف أو صورة أو صوت أو صفحة ويب، قد تُرسل مطالبتك والمحتوى الضروري المحدد أو المستخرج إلى مزود النموذج أو البحث أو الوسائط الذي اخترته. قد تسجل بوابة Lily بيانات استخدام الفوترة، لكنها لا تحفظ المطالبة الكاملة في جداول الاستخدام المجمعة." : "When you ask AI to analyze text, files, images, audio, or web pages, your prompt and necessary selected or extracted content may be sent to the chosen model, search, or media provider. Lily's gateway may record billing metadata but does not store full prompts in aggregate usage tables."] },
        { id: "purpose", title: isAr ? "5. الأغراض" : "5. Purposes", bullets: isAr ? ["تقديم الحساب والترخيص والتحديث وميزات الذكاء الاصطناعي.", "إتمام الدفع ومنح الأرصدة ومعالجة النزاعات.", "الأمن ومكافحة الإساءة والتشخيص.", "الرد على الدعم وطلبات الحقوق."] : ["Provide account, licensing, updates, and requested AI features.", "Complete payments, grant entitlements, and resolve disputes.", "Protect security, prevent abuse, and diagnose failures.", "Respond to support and privacy-rights requests."] },
        { id: "retention", title: isAr ? "6. الحفظ" : "6. Retention", paragraphs: [isAr ? "تبقى البيانات المحلية حتى تحذفها. نحتفظ ببيانات الخادم لأقصر مدة لازمة: الحسابات والتراخيص حتى الإغلاق، والجلسات حتى الانتهاء أو تسجيل الخروج، والسجلات المالية والأمنية حسب القانون، مع مراجعة دورية لحذف أو إخفاء هوية بيانات الاستخدام والتشخيص والدعم." : "Local data remains until you delete it. Server data is kept for the shortest necessary period: account and license records until closure, sessions until expiry or logout, financial/security records as required by law, and periodic deletion or anonymization review for usage, diagnostics, and support data."] },
        { id: "sharing", title: isAr ? "7. المشاركة والأطراف الثالثة" : "7. Sharing and third parties", paragraphs: [isAr ? "لا نبيع المعلومات الشخصية. نشارك الحد الأدنى اللازم مع مزودي الرسائل النصية والتخزين السحابي والذكاء الاصطناعي والدفع والبنية التحتية أو الخدمة المخصصة التي تختارها. راجع قائمة البيانات والأطراف الثالثة." : "We do not sell personal information. We provide minimum necessary data to SMS, cloud storage, AI, payment, infrastructure, or user-selected custom providers. See the Data and Third-Party List."] },
        { id: "cross-border", title: isAr ? "8. النقل عبر الحدود" : "8. Cross-border processing", paragraphs: [isAr ? "قد يؤدي اختيار نموذج خارجي أو نقطة نهاية مخصصة أو خدمة خارجية إلى نقل البيانات عبر الحدود. يعتمد المستلم والموقع والغرض على إعدادك، وسنطبق التدابير والموافقات التي يتطلبها القانون." : "Selecting an overseas model, custom endpoint, or overseas service can cause cross-border transfer. The recipient, location, and purpose depend on your configuration; we apply legally required safeguards and consent."] },
        { id: "security", title: isAr ? "9. الأمان" : "9. Security", bullets: isAr ? ["نستخدم HTTPS وتوقيع الطلبات والرموز قصيرة الأجل وتجزئة الرموز وتشفير الأسرار والتحكم في الوصول.", "لا يوجد نظام آمن بشكل مطلق؛ سنتخذ إجراءات المعالجة والإخطار المطلوبة عند وقوع حادث."] : ["We use HTTPS, request signing, short-lived tokens, code hashing, secret encryption, access control, and audit logs.", "No system is absolutely secure; we take legally required remediation and notification steps after an incident."] },
        { id: "rights", title: isAr ? "10. حقوقك" : "10. Your rights", paragraphs: [isAr ? `يمكنك طلب الوصول والنسخ والتصحيح والتقييد وسحب الموافقة وإغلاق الحساب أو الحذف عبر ${EMAIL}. نتحقق من الهوية ونرد خلال المدة القانونية.` : `You may request access, a copy, correction, restriction, withdrawal of consent, account closure, or deletion at ${EMAIL}. We verify identity and respond within the applicable legal period.`] },
        { id: "children", title: isAr ? "11. القاصرون" : "11. Children", paragraphs: [isAr ? "Lily موجه لمستخدمي العمل وليس للأطفال دون 14 عاماً. يجب على القاصر استخدامه بإشراف وموافقة ولي الأمر." : "Lily is intended for capable workplace users and is not directed to children under 14. Minors should use it only with guardian supervision and consent."] },
        { id: "contact", title: isAr ? "12. التحديثات والاتصال" : "12. Updates and contact", paragraphs: [isAr ? `سنعلن التغييرات الجوهرية عبر الموقع أو داخل التطبيق. مسؤول المعالجة: ${COMPANY}. البريد: ${EMAIL}.` : `We announce material changes on the website, in the app, or by another reasonable channel. Controller: ${COMPANY}. Contact: ${EMAIL}.`] },
      ],
    },
    terms: {
      eyebrow: isAr ? "القانون والخصوصية" : "Legal and privacy",
      title: isAr ? "شروط خدمة Lily Workbench" : "Lily Workbench Terms of Service",
      summary: isAr ? `تنظم هذه الشروط استخدامك لخدمات ${COMPANY}.` : `These terms govern your use of services provided by ${COMPANY}.`,
      notice: isAr ? "إذا كنت تستخدم Lily نيابة عن مؤسسة، فيجب أن تكون مخولاً وأن تلتزم بسياسات البيانات والأمن لديها." : "If you use Lily for an organization, you must be authorized and follow its data and security requirements.",
      sections: [
        { id: "service", title: isAr ? "1. الخدمة" : "1. Service", paragraphs: [isAr ? "توفر Lily مساحات عمل محلية ووكلاء ذكاء اصطناعي ومعالجة ملفات ومهارات وتشغيلات اختيارية وحسابات وخدمات سحابية. تختلف الميزات حسب الإصدار والمنطقة والخطة." : "Lily provides local workspaces, AI agents, file processing, skills, optional runtimes, accounts, and cloud features. Availability varies by version, region, plan, and provider."] },
        { id: "account", title: isAr ? "2. الحساب والترخيص" : "2. Account and license", paragraphs: [isAr ? "حافظ على أمان جهازك والرموز والتراخيص ومفاتيح API. لا يجوز إعادة البيع أو تجاوز حدود المقاعد أو الضوابط الأمنية." : "Keep devices, codes, licenses, and API keys secure. Do not resell access, exceed licensed seats, or bypass security controls."] },
        { id: "use", title: isAr ? "3. الاستخدام المقبول" : "3. Acceptable use", paragraphs: [isAr ? "لا تستخدم Lily لأعمال غير قانونية أو انتهاك الحقوق أو مهاجمة الأنظمة أو تجاوز الأذونات. تأكد من حقك في معالجة الملفات والبيانات الشخصية." : "Do not use Lily unlawfully, infringe rights, attack systems, or bypass permissions. Ensure you have rights to process submitted files and personal information."] },
        { id: "ai", title: isAr ? "4. مخرجات الذكاء الاصطناعي" : "4. AI output", paragraphs: [isAr ? "قد تكون المخرجات غير دقيقة ولا تعد مشورة مهنية. يجب على شخص مؤهل مراجعة القرارات عالية المخاطر والنشر الخارجي والعقود والبيانات وتغييرات الكود." : "AI output can be inaccurate and is not professional advice. Qualified people must review high-risk decisions, external publication, contracts, data, and code changes."] },
        { id: "content", title: isAr ? "5. المحتوى" : "5. Content", paragraphs: [isAr ? "تحتفظ بحقوقك في المدخلات القانونية وتمنح Lily إذناً لمعالجتها بالقدر اللازم للخدمة المطلوبة. قد تتشابه النتائج أو تخضع لشروط مزود النموذج." : "You retain rights in lawful inputs and permit Lily to process them as needed for the requested service. Outputs may be similar to others and subject to provider terms."] },
        { id: "third", title: isAr ? "6. خدمات الأطراف الثالثة" : "6. Third-party services", paragraphs: [isAr ? "تخضع النماذج والدفع والرسائل والتخزين والبحث والمهارات لشروط الأطراف الثالثة. أنت مسؤول عن الخدمات المخصصة ومفاتيحك الخاصة." : "Models, payment, SMS, storage, search, skills, and runtimes may have third-party terms. You are responsible for custom services and BYOK configurations."] },
        { id: "payment", title: isAr ? "7. الدفع" : "7. Payment", paragraphs: [isAr ? "تحدد صفحة الشراء السعر والرصيد والمدة. لا تُرد الخدمات الرقمية المستهلكة إلا إذا تطلب القانون أو نص العرض خلاف ذلك." : "The purchase page controls price, allowance, and duration. Consumed digital services are non-refundable unless law or the offer states otherwise."] },
        { id: "termination", title: isAr ? "8. التحديث والتعليق" : "8. Updates and suspension", paragraphs: [isAr ? "يجوز تحديث الخدمة أو تقييد الاستخدام غير القانوني أو المسيء أو غير الآمن، مع إشعار ومسار اعتراض حيثما أمكن." : "We may update services and restrict unlawful, abusive, unsafe, or unpaid use, with notice and appeal where reasonably possible."] },
        { id: "liability", title: isAr ? "9. حدود المسؤولية" : "9. Liability", paragraphs: [isAr ? "نقدم الخدمة بعناية معقولة لكن لا نضمن عدم الانقطاع أو الخطأ. تُحدد المسؤولية وفق القانون ولا نستبعد ما لا يجوز استبعاده." : "We use reasonable care but do not guarantee uninterrupted or error-free service. Liability follows applicable law; legally non-excludable liability remains."] },
        { id: "law", title: isAr ? "10. القانون والاتصال" : "10. Law and contact", paragraphs: [isAr ? `تخضع الشروط لقانون جمهورية الصين الشعبية. للتواصل: ${EMAIL}.` : `These terms are governed by the laws of the People's Republic of China. Contact: ${EMAIL}.`] },
      ],
    },
    data: {
      eyebrow: isAr ? "قائمة الشفافية" : "Transparency list",
      title: isAr ? "قائمة المعلومات والأطراف الثالثة" : "Personal Information and Third-Party List",
      summary: isAr ? "سيناريوهات البيانات والأغراض وفئات المستلمين. يختلف المزود حسب المنطقة والإعداد والميزة." : "Data scenarios, purposes, and recipient categories. Providers vary by region, configuration, and selected feature.",
      notice: isAr ? "لا تحدث المعالجة إلا عند استخدام الميزة المقابلة. لا ترسل Lily كل البيانات إلى جميع الخدمات المدرجة." : "Processing occurs only when you use the corresponding feature. Lily does not send all data to every listed service.",
      sections: [
        { id: "data", title: isAr ? "1. فئات البيانات" : "1. Data categories", rows: isAr ? [["تسجيل الدخول", "الهاتف وIP والجلسة والجهاز", "المصادقة والأمان", "حتى انتهاء الجلسة أو إغلاق الحساب"], ["الجهاز والترخيص", "المعرّف والبصمة والمنصة والإصدار", "التفعيل والتحديث", "مدة الحساب أو الترخيص"], ["الاستخدام والتشخيص", "الأعداد والرموز والأخطاء المنزوعة الحساسية", "الفوترة والاستقرار", "أقصر مدة لازمة"], ["الذكاء الاصطناعي", "المطالبة والمحتوى المحدد أو المستخرج", "إكمال طلبك", "وفق مزودك"], ["الدعم والدفع", "بيانات الاتصال والمرفقات والطلب والمبلغ", "الدعم وإتمام المعاملة", "وفق الحاجة والقانون"]] : [["Sign-in", "Phone, IP, session, device", "Authentication and security", "Until session expiry or account closure"], ["Device and license", "ID, fingerprint hash, platform, version", "Activation and updates", "Account/license lifetime plus required audit"], ["Usage and diagnostics", "Counts, tokens, sanitized errors", "Billing and reliability", "Shortest necessary period"], ["AI and media", "Prompt and selected/extracted content", "Complete your request", "Selected provider's rules"], ["Support and payment", "Contact details, attachments, order and amount", "Support and transaction", "As needed and legally required"]] },
        { id: "providers", title: isAr ? "2. فئات المزودين" : "2. Provider categories", rows: isAr ? [["رسائل Alibaba Cloud", "رموز تسجيل الدخول", "رقم الهاتف ومعلمات القالب", "عند تسجيل الدخول"], ["Qiniu", "تخزين المرفقات والتوزيع", "مرفقات الدعم المرفوعة وبيانات الملفات", "عند الرفع"], ["Alipay / WeChat Pay", "الدفع", "الطلب والمبلغ والحالة", "عند اختيار الدفع"], ["DashScope وDeepSeek وMoonshot وZhipu", "نماذج اختيارية", "المطالبة والمحتوى اللازم", "عند الاختيار"], ["Volcengine وKling وMiniMax", "وسائط اختيارية", "المطالبة والمرجع والمعلمات", "عند الاختيار"], ["مزود مخصص / BYOK", "خدمة يحددها المستخدم", "المحتوى الذي يرسله المستخدم", "وفق إعداد المستخدم"]] : [["Alibaba Cloud SMS", "Login codes", "Phone and template parameters", "On SMS sign-in"], ["Qiniu", "Attachment storage and distribution", "Uploaded support attachments and file metadata", "On upload"], ["Alipay / WeChat Pay", "Payment", "Order, amount, and status", "When selected"], ["DashScope, DeepSeek, Moonshot, Zhipu", "Optional AI models", "Prompt and required content", "When selected"], ["Volcengine, Kling, MiniMax", "Optional media generation", "Prompt, reference media, parameters", "When selected"], ["Custom / BYOK provider", "User-configured service", "Content the user directs to send", "Per user configuration"]] },
        { id: "change", title: isAr ? "3. النقل والتغييرات" : "3. Transfers and changes", paragraphs: [isAr ? `قد تكون بعض الخدمات خارج الصين. سنحدث القائمة عند التغييرات الجوهرية. للاستفسار: ${EMAIL}.` : `Some providers may be outside China. We update this list after material changes. Contact ${EMAIL} for current configuration or rights requests.`] },
      ],
    },
    deletion: {
      eyebrow: isAr ? "الحساب والبيانات" : "Account and data",
      title: isAr ? "حذف الحساب والبيانات" : "Account and Data Deletion",
      summary: isAr ? "احذف العمل المحلي بنفسك أو اطلب إغلاق الحساب وحذف بيانات الخادم." : "Delete local work yourself or request account closure and server-side data deletion.",
      notice: isAr ? "لا يوفر الإصدار الحالي حذفاً ذاتياً داخل التطبيق. نعالج طلبات الحساب والخادم يدوياً بعد التحقق، ويمكنك حذف بيانات جهازك فوراً." : "The current version does not provide in-app self-service deletion. Account and server-data requests are handled manually after verification; you can delete device data immediately.",
      sections: [
        { id: "local", title: isAr ? "1. حذف البيانات المحلية" : "1. Delete local data", bullets: isAr ? ["أوقف المهام واحتفظ بنسخة مما تحتاجه.", "احذف المحادثات والمشاريع والمجلدات من Lily ومدير الملفات.", "احذف مجلد بيانات تطبيق Lily بعد إغلاق التطبيق للتنظيف الكامل. إزالة التطبيق وحدها لا تضمن حذف البيانات."] : ["Stop active tasks and back up anything you need.", "Delete conversations, projects, workspace folders, and generated files from Lily and your file manager.", "After quitting Lily, remove its operating-system application-data folder for a full cleanup. Uninstalling alone does not guarantee data deletion."] },
        { id: "request", title: isAr ? "2. إرسال طلب" : "2. Submit a request", paragraphs: [isAr ? `أرسل بريداً إلى ${EMAIL} بعنوان "Lily account/data deletion". اذكر آخر أربعة أرقام من الهاتف والمنصة والإجراء المطلوب. لا ترسل رمز تحقق أو مفتاح ترخيص أو API.` : `Email ${EMAIL} with subject "Lily account/data deletion". Include the last four digits of the registered phone, device platform, and requested action. Never send a verification code, full license key, or API key.`] },
        { id: "verify", title: isAr ? "3. التحقق" : "3. Identity verification", paragraphs: [isAr ? "قد نتحقق عبر الهاتف المسجل أو جلسة حالية أو الحد الأدنى من بيانات الجهاز لمنع الحذف الاحتيالي." : "We may verify through the registered phone, an existing session, or minimum device information to prevent fraudulent deletion."] },
        { id: "effect", title: isAr ? "4. الأثر" : "4. Effect", paragraphs: [isAr ? "قد لا يمكن استعادة الجلسات والأرصدة والروابط. لا يؤدي حذف الحساب إلى حذف مساحة العمل المحلية تلقائياً." : "Sessions, unused entitlements, and device links may not be recoverable. Account deletion does not automatically remove local workspaces."] },
        { id: "exceptions", title: isAr ? "5. الاستثناءات" : "5. Legal retention", paragraphs: [isAr ? "نقيّد معالجة السجلات المالية والأمنية والنزاعات التي يجب الاحتفاظ بها قانوناً، ثم نحذفها أو نخفي هويتها بعد انتهاء المدة." : "We restrict processing of financial, security, dispute, and other records that law requires us to retain, then delete or anonymize them after the period ends."] },
        { id: "time", title: isAr ? "6. المدة والاعتراض" : "6. Timing and appeal", paragraphs: [isAr ? `نؤكد الاستلام ونعالج الطلب خلال المدة القانونية بعد التحقق. للاستئناف اكتب إلى ${EMAIL}.` : `We acknowledge and process verified requests within the applicable legal period. If denied, we explain why and how to appeal. Contact ${EMAIL}.`] },
      ],
    },
  };

  for (const document of Object.values(documents)) {
    copy[Object.keys(documents).find((key) => documents[key] === document)] = { ...common, ...document };
  }
  return copy;
}

const en = translated("en", "en");
const ar = translated("ar", "ar");
const all = { zh, en, ar };

function normalizeLocale(locale) {
  const value = String(locale || "zh").toLowerCase();
  if (value.startsWith("ar")) return "ar";
  if (value.startsWith("en")) return "en";
  return "zh";
}

export function legalContentFor(locale) {
  return all[normalizeLocale(locale)];
}

export function legalDocumentFor(locale, key) {
  const content = legalContentFor(locale);
  return content[key] || content.privacy;
}

export function legalFooterFor(locale) {
  return legalContentFor(locale).footer;
}
