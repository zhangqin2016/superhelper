---
name: lily-intent-eval
description: Use when building, reviewing, or running golden examples and regression tests for Lily intent routing across Office, Coding, UI, Media, Research, Runtime, and mixed-task requests.
---

# Lily 意图评测

本技能用于维护意图路由的黄金样例和回归测试，目标是发现“选错技能、漏拆混合任务、过度追问、验证路线缺失”等路由问题。

## 何时使用

- 新增或修改意图路由、技能触发描述、默认技能预设。
- 发布前回归 Office、Coding、UI、Media、Research、Runtime 和混合任务。
- 复盘用户请求被错误路由、漏用技能或误触发网络/运行时能力的问题。

## 何时不用

- 单个业务功能的实现测试。
- 普通知识问答质量评测。
- 只评审某个技能内容本身；那应使用技能质量评测。

## 样例格式

每条黄金样例必须是结构化记录，建议 JSONL：

```json
{
  "id": "office_pdf_to_ppt_001",
  "locale": "zh-CN",
  "prompt": "把这个 PDF 的重点做成 8 页 PPT，并检查版式",
  "attachments": ["sample.pdf"],
  "expected_intents": ["office", "presentation", "document_verify"],
  "expected_route": ["pdf_extract", "content_restructure", "ppt_create", "render_verify"],
  "must_not_route": ["web_research"],
  "needs_clarification": false,
  "verification_required": ["output_path", "render_check"],
  "risk": "medium",
  "notes": "混合 Office 任务，应拆成能力链。"
}
```

必填字段：`id`、`prompt`、`expected_intents`、`expected_route`、`must_not_route`、`needs_clarification`、`verification_required`。

## 覆盖范围

- **Office**：Word/PDF/PPT/Excel/CSV、模板填充、PDF 表单、扫描件、格式校验、文件转换。
- **Coding**：脚本、小工具、Electron/网页、调试、测试、自动化、数据处理。
- **UI**：页面、后台、表单、仪表盘、组件、响应式、视觉 QA、浏览器验证。
- **Media**：图片理解、图片生成、视频提示、语音、海报、封面、产品图。
- **Research**：最新事实、价格、政策、榜单、引用来源、多来源确认。
- **Runtime**：本地运行时、Office/PDF 专业解析包、下载/安装/缺失运行时处理。
- **混合任务**：PDF 转 PPT、Excel 生成网页图表、研究后写报告、生成图片并嵌入文档、代码修复后做 UI 验证。

每个类别至少包含：清晰正例、近邻反例、缺信息样例、失败恢复样例。混合任务必须断言能力链顺序。

## 判定标准

- **意图命中**：`expected_intents` 全部命中，且没有高风险误触发。
- **路由链正确**：混合任务按必要顺序拆解，不只选第一个显眼技能。
- **最小追问**：只有缺少阻塞信息时才问；可从附件或默认安全假设推进时不追问。
- **验证匹配**：文件、代码、UI、研究、修复任务分别要求对应验收证据。
- **权限克制**：不因普通任务触发联网、运行时下载、写文件或子进程。
- **失败可解释**：无法路由或工具不可用时，输出原因、影响和下一步。

通过门槛：关键样例 100% 通过；全量样例通过率不低于 95%；任何安全或权限误触发都是阻断失败。

## 工作流

1. 从真实用户请求、历史失败和新技能边界中补充样例。
2. 给每条样例写清预期意图、禁止意图、验证要求和是否需要追问。
3. 运行路由或人工评审输出，记录实际 `intent`、`route`、`clarification`、`verification`。
4. 标记失败类型：漏召回、误召回、顺序错、追问错、验证漏、权限过宽。
5. 回归修复后保留失败样例，避免再次退化。

## 输出标准

评测报告必须包含：样例总数、分类覆盖、通过率、阻断失败、失败明细、最小修复建议、仍缺的样例类别。不要只给“通过/失败”。
