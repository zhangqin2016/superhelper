---
name: lily-office-intent
description: Use when the user asks to read, create, edit, convert, verify, or extract information from Office/document files: Word, PDF, PPT, Excel, templates, fillable PDF forms, scanned documents, complex PDFs, reports, proposals, contracts, tables, charts, or slide decks. Routes to the right document capability and verification path before acting.
---

# Lily 办公意图路由

本技能是 Office Core 的路由层。目标是先判断文档任务类型，再选择 Word、PDF、PPT、Excel、模板填充、PDF 表单、文档校验或运行时扩展包。

## 何时使用

- 用户上传或提到 `.docx`、`.pdf`、`.pptx`、`.xlsx`、`.csv`、`.tsv`。
- 用户要写报告、方案、合同、通知书、简历、提案、PPT、表格、PDF。
- 用户要从文档中提取、总结、翻译、改写、排版、转换、合并、拆分、填写或校验。
- 用户说文档打不开、格式乱、PDF 识别不准、表格提取错、PPT 排版有问题。

## 路由规则

- **Word / .docx**：创建、编辑、排版、目录、页码、信头、查找替换、插图、修订批注 → Word 文档能力。
- **PDF**：读取、提取、合并、拆分、旋转、水印、加密、OCR、生成 PDF → PDF 能力。
- **可填写 PDF 表单**：有 AcroForm 字段，需要填写政府/银行/申请/登记表 → PDF 表单填充。
- **PPT / .pptx**：制作演示、编辑幻灯片、读取 deck、处理模板/备注/批注 → 演示文稿能力。
- **Excel / 表格数据**：读取、清洗、公式、图表、透视、CSV/TSV、数据分析 → 电子表格能力。
- **Word 模板批量填充**：已有 `{{ }}` 或 `{%p %}` 占位符，需要合同/证书/通知书批量生成 → 模板填充。
- **复杂 PDF / 高精度版面**：多栏、密集表格、扫描件、普通路径不准、用户要求 Docling/专业解析 → 运行时扩展包。
- **交付前检查**：重要文档、PPT、PDF、表格生成后需要确认版式 → 文档校验。

## 执行原则

1. 先判断输入文件类型和目标交付物，不要只按用户第一个词选工具。
2. 混合任务要拆步骤：例如“PDF 做成 PPT”是 PDF 提取 → 内容重组 → PPT 生成 → 渲染检查。
3. 读取用户文档后再下结论，不编造文档内容。
4. 生成或修改后的文件必须给绝对路径或可打开位置。
5. 重要交付要验证能打开；涉及版式的交付优先渲染检查。
6. 识别失败要说明失败点，并建议轻量路径、OCR、或运行时扩展包。

## 不要误用

- 用户只是要写普通网页或代码，不走 Office。
- 用户只是问事实问题，不因为回答里有表格就创建 Excel。
- 用户要设计合同/证书版式时，优先 Word 模板生成再转 PDF，不手画 PDF 坐标。
