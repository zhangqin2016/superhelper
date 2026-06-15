# 技能包审计与优化建议

审计时间：2026-06-14

## 结论

历史审计基线的技能注册表共有 **144 个技能**。它不是一套完全围绕 Lily Workbench 打磨过的“顶级技能包”，而是由多个公开来源聚合而成：

| 来源 | 数量 | 判断 |
| --- | ---: | --- |
| Product Manager Skills | 49 | 量大，但更像方法论模板库，适合按需安装，不适合默认推荐太多 |
| Marketing Skills | 42 | 覆盖广，但与当前办公工作台核心场景弱相关，适合做行业扩展包 |
| Trail of Bits Skills | 19 | 质量高但非常垂直，区块链/安全审计类应默认隐藏或归入专业市场 |
| Anthropic Skills | 15 | 当前最值得保留的基础来源，尤其文档、表格、PPT、PDF、测试、设计 |
| Superpowers | 14 | 研发协作流程强；其中规划、调试、测试、验证应进入 Coding Core，工作树/分支/多代理等重工程流程放专业包 |
| Lily Workbench | 5 | 最贴合平台，但数量偏少，需要继续自研补齐核心工作流 |

核心判断：**现在的问题不是技能数量不够，而是技能目录没有围绕平台定位分层。** 普通用户第一次打开会看到太多“看起来专业但不一定用得上”的技能，容易降低信任感。技能市场可以大，但默认推荐必须小而准。

补充判断：**普通用户也会大量提出编程需求。** Lily 不应该把“编程”只理解成专业开发者场景；对普通用户来说，编程能力反而更需要平台保障一次通过性、正确性、可运行验证和界面美观。因此研发/前端/测试类技能不能简单降级为边缘能力，而应该拆成两层：面向普通人的“编程创作核心能力”和面向专业开发者的“工程高级能力”。

更高层的判断：**技能包不应该按“有没有用”判断，而应该按“能不能显著提升平台结果质量”判断。** 顶级技能体系的目标不是让模型多知道一点，而是让模型即使用差一点，也能稳定完成以下闭环：

1. **准确识别意图**：用户一句自然语言，系统能判断是在写文档、做表格、编程、修 bug、画图、做网页、查资料、生成视频/音频，还是混合任务。
2. **选对执行路径**：不是靠模型自由发挥，而是进入对应任务框架：需求澄清、输入检查、执行、验证、修复、交付。
3. **产物能用**：生成文件路径正确，代码能跑，文档能打开，表格公式正确，图片/视频/音频本地可见。
4. **质量可验证**：代码有测试，网页有浏览器验证，文档有渲染检查，图片有预览，外部资料有来源。
5. **体验有审美**：UI 不是能跑就行，要布局合理、文字不挤、交互自然、视觉不廉价；图片和创意内容也要有审美约束。
6. **失败能自救**：出错后不是把错误丢给用户，而是自动诊断、重试、换路径、说明影响和下一步。

因此，真正顶级的技能不是“更多模板”，而是 **意图路由 + 任务框架 + 执行工具 + 验证门禁 + 审美标准** 的组合。

## 顶级平台能力标准

未来评价每个技能，不看名字是否专业，而看它是否提高以下七种能力。

| 能力 | 判断标准 | 低质量技能表现 | 顶级技能表现 |
| --- | --- | --- | --- |
| 意图识别 | 是否帮助弱模型判断用户真实目标 | 描述很泛，触发边界模糊 | 明确何时用、何时不用、冲突时怎么选 |
| 执行准确 | 是否把任务拆成稳定步骤 | 只给建议，让模型自由发挥 | 有输入 schema、固定脚本、明确输出格式 |
| 一次通过 | 是否减少返工和手工修 bug | 产物看似完成但跑不起来 | 强制测试、预览、验证、失败重试 |
| 美观创意 | 是否提升 UI/图片/文案质量 | 套模板、AI 味重、视觉廉价 | 有审美原则、反例、布局/交互约束 |
| 本地落地 | 是否和 Lily 文件/运行时体系结合 | 输出临时链接或相对路径 | 输出绝对路径、本地预览、可打开位置 |
| 安全可控 | 是否限制权限和副作用 | 任意脚本、任意联网、读凭据 | 权限最小化、来源可信、风险标注 |
| 可观测 | 是否能知道它有没有失效 | 失败静默、结果不可判断 | 有状态、日志、错误分类、回归测试 |

按这个标准看，很多 PM/Marketing 技能“有用”，但不一定能大幅提升平台能力；而调试、测试、前端设计、浏览器验证、文档渲染、媒体生成这些技能，对平台结果质量的提升更直接。

## 重新定义核心能力层

Lily 的默认能力应该围绕用户真实任务，而不是围绕岗位名称。

### 1. Intent Core：意图识别核心

目标：弱模型也能选对路线。

应具备：

- 任务类型判定：办公文档、编程、网页/UI、数据表格、图片/视频/音频、资料检索、部署/运维、问题排查。
- 混合任务拆分：例如“帮我做个可以上传 Excel 的网页并生成图表”要拆成前端、表格解析、图表、浏览器验证。
- 最小澄清问题：只在关键输入缺失时问，不把用户逼成产品经理。
- 技能冲突规则：例如网页生成优先走 Coding Core + Design Core，不应只走 marketing landing page 模板。

现状：有基础规则，但还不够系统。建议新增或强化 `lily-intent-router` 类内部强制技能。

### 2. Coding Core：普通用户编程创作核心

目标：让普通用户说“做个网页/工具/脚本/自动化”时，产物一次跑通。

应默认包含：

- 需求拆解：`superpowers-writing-plans`
- 编码纪律：`lily-engineering-rules`
- 调试：`superpowers-systematic-debugging`
- 测试：`superpowers-test-driven-development`
- 完成前验证：`superpowers-verification-before-completion`
- 前端审美：`anthropics-frontend-design`
- 浏览器验证：`anthropics-webapp-testing`

但要重新包装：用户不应该看到一堆“superpowers”名字，而应该看到一个“编程创作增强”或“做网页/小工具更稳”的能力包。

### 3. Design Core：界面和交互审美核心

目标：不是只生成能跑的网页，而是生成用户愿意用的界面。

应具备：

- 信息层级：用户第一眼知道要干什么。
- 交互合理：按钮、状态、取消、加载、错误、空状态齐全。
- 响应式布局：移动端/桌面不挤、不重叠。
- 视觉约束：避免廉价渐变、模板感、无意义卡片堆叠。
- 浏览器截图验证：必须实际看页面，而不是模型自评。

现状：`anthropics-frontend-design` 有价值，但 Lily 还需要自己的 `lily-ui-quality` 规则，把我们产品审美和交互底线固化。

### 4. Media Core：图片/视频/音频创意核心

目标：生成漂亮、可见、可复用的媒体产物。

应具备：

- 图片识别准确：`lily-vision`
- 图片生成：`lily-image-generation`
- 视频生成：`lily-video-generation`
- 语音生成：`lily-speech-generation`
- 本地落地：必须下载到工作区，输出绝对路径，直接预览。
- 创意质量：提示词不能只翻译用户输入，要补构图、风格、光线、质感、用途。

现状：工具链已经开始成型，但还缺少统一的 `creative-quality` 标准，比如图片构图、海报排版、人物一致性、产品图可用性。

### 5. Office Core：办公文档核心

目标：普通用户处理 Word、Excel、PPT、PDF 不需要懂格式和工具。

应默认包含：

- `anthropics-docx`
- `anthropics-xlsx`
- `anthropics-pptx`
- `anthropics-pdf`
- `anthropics-doc-coauthoring`
- `lily-template-fill`
- `lily-pdf-form`
- `lily-document-verify`
- `lily-runtime-packs`

关键不是“会生成”，而是：

- 能读取真实内容。
- 能保留格式。
- 能渲染检查。
- 能输出本地文件。
- 能让用户打开所在位置。

### 6. Research Core：联网检索与证据核心

目标：减少幻觉，增强事实性。

应包含：

- `websearch`
- `webfetch`
- 来源引用规则
- 时效性判断规则
- 国内可用搜索后端

现状：方向正确。后续应加入“资料可信度评分”和“多来源交叉确认”。

### 7. Professional Packs：专业岗位扩展包

这些不是默认核心，但可以作为可选包：

- PM Pack：PRD、路线图、用户故事、机会树、JTBD。
- Marketing Pack：SEO、广告、邮件、增长、CRO。
- Security Pack：Trail of Bits 安全审计、合约安全、C/Crypto 分析。
- Dev Pro Pack：工作树、代码审查、分支收尾、多代理协作。

这些包有价值，但不应干扰普通用户默认体验。

## 与 Lily 平台的匹配度

### A 级：应作为默认/强推荐

这些技能直接支撑 Lily 的主线体验：本地文档处理、生成文件可见、运行时能力扩展、自然语言工作。

- `anthropics-docx`
- `anthropics-xlsx`
- `anthropics-pptx`
- `anthropics-pdf`
- `anthropics-doc-coauthoring`
- `lily-template-fill`
- `lily-pdf-form`
- `lily-document-verify`
- `lily-runtime-packs`
- `lily-vision`
- `lily-image-generation`
- `lily-video-generation`
- `lily-speech-generation`
- `websearch`
- `webfetch`
- `anthropics-frontend-design`
- `anthropics-webapp-testing`
- `superpowers-systematic-debugging`
- `superpowers-test-driven-development`
- `superpowers-verification-before-completion`
- `superpowers-writing-plans`

建议：这些应该构成 **Lily Core**，并在产品中放在最前面。它不只是 Office Core，还应包括 **Coding Core**：让普通人用自然语言做小工具、网页、脚本、自动化、数据处理时，默认获得规划、调试、测试、验证和美观 UI 约束。

### B 级：保留，但不要默认打扰普通用户

这些适合专业开发者、产品经理、营销人员，但不是所有用户都需要。

- `superpowers-*`
- `pm-prd-development`
- `pm-user-story-mapping`
- `pm-roadmap-planning`
- `pm-problem-framing-canvas`
- `marketing-copywriting`
- `marketing-seo-audit`
- `marketing-analytics`
- `marketing-product-marketing`
- `marketing-emails`

建议：做成 **岗位包**，例如“产品经理包”“营销增长包”“专业研发包”，默认不全量展开。注意：专业研发包和 Coding Core 不一样；Coding Core 面向普通用户的一次通过和可用性，专业研发包才放工作树、代码审查、分支收尾、多代理等重工程流程。

### C 级：应降级为专业市场/高级筛选

这些不是垃圾，但和 Lily 普通办公用户主线弱相关。

- 大部分 `tob-building-secure-contracts-*`
- `tob-burpsuite-project-parser-*`
- `tob-constant-time-analysis-*`
- `tob-culture-index-*`
- 大量细分 `marketing-*`
- 大量重复或相邻的 `pm-*`

建议：保留在市场索引里，但默认列表不展示，除非用户选择“安全审计 / 区块链 / 高级研发”。

### D 级：建议合并或重新包装

当前 PM 和 Marketing 技能存在“颗粒度过细”的问题。用户不需要看到 49 个产品经理技能和 42 个营销技能。

建议合并为少量高质量包：

- `pm-strategy-pack`：问题定义、PRD、路线图、用户故事、优先级
- `pm-research-pack`：访谈、用户旅程、JTBD、竞品/公司研究
- `marketing-growth-pack`：SEO、广告、落地页、CRO、邮件
- `marketing-content-pack`：文案、内容策略、社媒、发布

内部仍可保留子技能，但 UI 和推荐层不要直接暴露全部。

## GitHub / 生态对比

当前生态里更值得关注的不是“再找 100 个技能”，而是把高质量来源纳入候选池并做筛选。

已核查的公开来源：

- `anthropics/skills`：官方 Agent Skills 参考实现，GitHub 页面显示约 150k stars，是当前最强基线来源。
  https://github.com/anthropics/skills
- `VoltAgent/awesome-agent-skills`：强调“官方团队与社区真实使用”的精选集合，页面写明不是批量 AI 生成，约 25.2k stars。
  https://github.com/VoltAgent/awesome-agent-skills
- `ComposioHQ/awesome-claude-skills`：技能与资源聚合，约 64.5k stars，适合作为候选池，不适合无筛选导入。
  https://github.com/ComposioHQ/awesome-claude-skills
- `hesreallyhim/awesome-claude-code`：覆盖 skills、hooks、commands、agents、plugins，约 46.3k stars，适合研究工程生态，不是纯技能包源。
  https://github.com/hesreallyhim/awesome-claude-code
- `MCP Market Leaderboard`：按 stars 排 MCP servers，适合发现工具连接能力，但 MCP 与 Skill 不是一回事。
  https://mcpmarket.com/leaderboards
- `Agent Skills Hot`：声称收录 63,000+ agent skills，可作为搜索入口，但必须做安全与质量过滤。
  https://agent-skills.cc/claude-skills/hot

## 是否有更好的？

有，但不能按 stars 直接导入。

更好的方向是：

1. **Anthropic 官方 skills 继续跟进**：文档、PPT、Excel、PDF、Web 测试、技能创建是高价值。
2. **从 VoltAgent awesome-agent-skills 挑官方团队技能**：优先考虑 Google、Vercel、Stripe、Cloudflare、Sentry、Figma、Hugging Face、Firecrawl、Neon、ClickHouse 等来源。
3. **MCP 排行榜只用于“连接能力”**：如 Context7、Playwright/Browser、Firecrawl、GitHub、数据库、云服务，不要混进普通技能包。
4. **社区技能先隔离试用**：任何带脚本、网络、凭据读取、自动更新的技能都必须经过权限审计。

## 建议的新结构

### 1. 默认只展示 15-25 个精品技能

默认推荐：

- Office Core：Word、Excel、PPT、PDF、协作文档、模板填充、PDF 表单、文档验证
- Media Core：图片识别、图片生成、视频生成、语音生成
- Web Core：联网搜索、网页抓取
- Runtime Core：runtime packs
- Coding Core：需求澄清、实现规划、调试、测试、验证、前端美观、Web 应用测试

Coding Core 的目标不是把用户变成程序员，而是让用户说“帮我做个网页/小工具/脚本/自动化”时，产物更可能一次跑通、界面不粗糙、错误能被自动发现并修掉。

### 2. 技能市场分层

- 默认推荐：平台强绑定、普通用户常用
- 岗位包：PM、Marketing、Dev
- 专业包：Security、Blockchain、DevSecOps
- 实验区：社区来源、未充分验证

### 3. 加质量评分

建议每个技能增加内部评分字段：

- `platformFit`：是否贴合 Lily 主线
- `userFrequency`：普通用户使用频率
- `executionRisk`：是否运行脚本、联网、读写文件、读凭据
- `maintenanceHealth`：来源是否活跃、是否官方
- `localizationQuality`：中文说明是否可靠
- `defaultEligible`：是否允许默认推荐

### 4. 下一个版本建议

短期可以不删除技能，但要改展示和默认推荐：

1. 默认首页只展示 Office / Media / Web / Runtime / Coding Core。
2. PM 和 Marketing 折叠成岗位包，不直接铺 91 个技能。
3. Trail of Bits 默认隐藏到“专业安全”。
4. 新增“官方/精选/社区/实验”标签。
5. 从 VoltAgent awesome-agent-skills 建一个候选清单，但只人工引入 10-20 个和 Lily 高度匹配的技能。
6. 把编程类默认能力拆成“普通用户编程创作”和“专业工程流程”，前者默认推荐，后者按需安装。

## 最终建议

当前 144 个技能里，真正适合作为 Lily 默认能力的约 **25 个左右**；适合做岗位包的约 **40-60 个**；剩下大量应作为专业/实验市场候选。

不要追求“技能很多”。Lily 的优势应该是：

> 默认少而准，市场大而有筛选，运行时能力强，输出结果能本地落地；普通人做编程，也要默认保证能跑、准确、好看。

## 2026-06-14 落地状态

已按“默认少而准”完成第一轮本地能力整理：

- `resources/skills-registry/registry.json` 从 144 个可安装技能收敛为 24 个核心精选技能，其中 22 个进入普通用户推荐能力，2 个质量评测技能保留在质量分类供发布/研发使用。
- `resources/skills-catalog/` 已删除低匹配度本地技能目录，默认保留 Office、Lily 包装后的 Coding 核心能力，以及独立 UI 质量门禁；底层研发/设计/测试技能不再直接暴露给普通用户。
- 默认推荐能力包从 5 个岗位包收敛为 5 个核心包：办公 Starter、可靠交付、编程研发 Starter、创意 Starter、研究 Starter。
- PM / Marketing / Trail of Bits / 区块链安全等长尾能力不再进入本地默认目录；后续如果需要，应通过服务端精选岗位包或专业包下发。
- 媒体能力（识图、图片生成、视频生成、语音生成）仍作为平台内置工具技能保留在 `resources/skills/`，不进入可下载市场目录。
- `lily-intent-router` 已作为平台强制内置技能落地，不在用户可管理列表中展示。
- `lily-coding-core` 已作为第一条 Lily 包装能力落地，吸收计划、系统化调试、测试驱动、完成前验证、前端审美和浏览器 QA，不再默认展示 `superpowers-*` 等底层原料名。
- `lily-ui-quality` 已作为第二条 Lily 包装能力落地，独立承载 UI/交互/审美/响应式/截图验证门禁。
- `lily-browser-qa` 已作为第三条 Lily 包装能力落地，独立承载浏览器打开、控制台检查、主流程点击、截图和响应式验收。
- `lily-creative-director` 已作为第四条 Lily 包装能力落地，承载图片/视频/语音创意补全、质量约束、本地保存和反馈迭代。
- `lily-office-intent` 已作为第五条 Lily 包装能力落地，承载 Word/PDF/PPT/Excel/模板/表单/复杂 PDF 的办公任务路由。
- `lily-app-builder`、`lily-code-repair` 已补齐普通用户编程从构建到失败修复的闭环。
- `lily-research-synthesis` 已补齐最新事实、排行榜、价格、政策、竞品和资料汇总的联网核验能力。
- `lily-prompt-enhancer`、`lily-image-qa` 已补齐创意提示增强和图片产后验收能力。
- `lily-pdf-extraction-router`、`lily-excel-data-analysis`、`lily-ppt-design-qa` 已补齐 PDF 解析路由、表格分析和 PPT 设计验收能力。
- `lily-skill-quality-gate`、`lily-intent-eval` 已补齐技能发布评测和意图路由回归测试规范，但默认不进入普通用户推荐包。

当前保留的可安装技能：

- Office：`lily-office-intent`、`lily-pdf-extraction-router`、`lily-excel-data-analysis`、`lily-ppt-design-qa`、`anthropics-docx`、`anthropics-pdf`、`anthropics-pptx`、`anthropics-xlsx`、`anthropics-doc-coauthoring`、`lily-template-fill`、`lily-document-verify`、`lily-pdf-form`、`lily-runtime-packs`
- Coding：`lily-coding-core`、`lily-app-builder`、`lily-code-repair`、`lily-browser-qa`
- Design：`lily-ui-quality`
- Media：`lily-creative-director`、`lily-prompt-enhancer`、`lily-image-qa`
- Research：`lily-research-synthesis`
- Quality：`lily-skill-quality-gate`、`lily-intent-eval`

二次审计修正：

- Office Starter 已补入 `lily-document-verify`，办公文档默认链路包含最终版式验收。
- `dev-starter` 不再包含 `lily-creative-director`，研发可靠性交付只保留编程、UI 质量、浏览器验收。
- `creative-starter` 单独承载媒体/视觉创作，避免创意能力和研发默认包混在一起。

三次落地修正：

- `lily-intent-eval` 已补入真实 JSONL 黄金样例库和 `scripts/run-intent-eval.mjs` 自动 runner，并纳入 `npm run test:skills`。
- `lily-skill-quality-gate` 已在服务端技能包创建/上传流程接入质量门禁，低质量描述、高风险默认推荐、外部来源默认推荐等会被阻断。

仍未完成的平台闭环：

- 技能质量评分尚未持久化到数据库，后台还不能查看历史评分和退回原因趋势。
- 技能使用效果 telemetry、A/B 测试、自动回滚和服务端分渠道下发仍需继续做。
