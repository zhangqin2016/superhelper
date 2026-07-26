# Lily Agent Manual Release Acceptance Task

This is a manual, natural-language release check for Lily's real chat path. Run it
in a fresh Lily Workbench conversation after installing or starting a release
candidate. Do not pre-create fixture files; the point is to verify that the agent
can plan, discover capabilities, prepare dependencies, create files, verify its
own work, and report gaps from a normal user request.

## When To Run

- Before a public client release.
- After changing OpenCode, model routing, runtime packs, skills, document
  handling, permissions, tool cards, or turn recovery.
- After packaging a new Mac or Windows build.

Use a model and permission mode that match the intended release default. Start
from a new conversation so old context, old skills, and old resume state do not
hide regressions.

## Copy This Into Lily

```text
我在做 Lily Workbench 发版验收。请你完整执行一个复杂但真实的办公室任务，不要只给计划。

目标：请为一家虚构公司“星河运营中心”制作一套 2026 年 7 月的月度运营复盘材料，并最终交付一个可检查的文件夹。你需要自己规划步骤、选择合适能力/技能、创建数据、生成文档，并验证产物。

具体要求：

1. 先在当前工作区创建一个新文件夹，命名为 `lily-release-acceptance-YYYYMMDD-HHMM`，后续所有产物都放进去。
2. 在文件夹里创建一份原始运营数据 CSV，至少包含 30 行，字段包括日期、渠道、线索数、成交数、收入、客服响应时长、客户满意度、备注。数据可以虚构，但要内部一致。
3. 基于 CSV 生成一份 Excel 工作簿，至少包含：
   - 原始数据表
   - 汇总表
   - 透视/分组统计或等价汇总
   - 至少 2 个公式列
   - 至少 1 张图表或图表数据页
4. 生成一份 Word 复盘报告，要求：
   - 中文标题、目录式结构、摘要、关键指标、问题分析、下月行动计划
   - 引用 Excel 中的关键数据，不要凭空写
   - 表格或项目符号要排版清楚
   - 不要使用深色背景
5. 生成一份 PDF 版本的复盘报告。如果不能直接高质量生成 PDF，请说明原因，并用当前最可靠的本地方式转换或导出。
6. 生成一份简短 Markdown 验收报告 `ACCEPTANCE_REPORT.md`，记录：
   - 你实际创建了哪些文件
   - 每个文件的用途
   - 你做了哪些验证
   - 哪些能力/技能/依赖被使用或被建议使用
   - 有无降级、失败、重试、未验证项
7. 请至少做一次“读回验证”：重新打开或读取你生成的 CSV、Excel/Word/PDF 中可读的部分，确认关键指标和文件存在。不要只说“应该可以”。
8. 请故意检查一个不存在的依赖或能力，例如“高级扫描 PDF/OCR/Docling 类能力是否可用”。如果不可用，不要中断任务；请记录它是否缺失、是否需要安装 runtime pack、以及本任务如何降级到基础能力继续完成。
9. 如果过程中工具失败、权限被拒、依赖缺失、文件格式转换失败或模型中断，请不要换个说法假装完成。请恢复、重试或明确记录降级路径，继续完成可完成的部分。
10. 最终回复请只包含：
    - 产物文件夹路径
    - 主要文件清单
    - 验证通过/未通过项
    - 需要我人工打开检查的文件

验收重点：我不是要漂亮话，我要验证 Lily 的 agent、技能选择、依赖提示、文件生成、工具卡片、读回验证、失败降级和最终交付是否都正常。
```

## Expected Healthy Behavior

A healthy release should show these behaviors in the UI and final answer:

- The agent starts work instead of only giving a plan.
- It creates a timestamped output folder and keeps all artifacts inside it.
- Tool cards appear for file creation, command execution, document generation,
  conversion, and read-back checks.
- It uses deterministic local file operations for CSV/Excel/report creation
  rather than inventing invisible artifacts.
- It notices optional advanced PDF/OCR/Docling capability as optional, not a
  blocker for this task.
- Missing optional runtime packs are reported as a capability gap with a
  fail-open path, not as task failure.
- Final answer includes concrete paths and verification details.
- `ACCEPTANCE_REPORT.md` is present and names both successful checks and any
  skipped or degraded checks.

## Manual Pass Criteria

Mark the release candidate as passing this manual task only if all required items
below are true:

- The final output folder exists.
- The CSV exists and contains at least 30 data rows.
- The Excel workbook exists and has separate raw-data and summary content.
- The Word report exists and references numbers that can be traced to the data.
- A PDF report exists, or the agent clearly explains a conversion failure and
  still delivers the Word report plus verification notes.
- `ACCEPTANCE_REPORT.md` exists and is specific, not generic.
- The agent performed a real read-back or reopen check.
- The agent did not claim optional advanced OCR/Docling was used unless it was
  actually available.
- The final answer clearly separates verified items from degraded or unverified
  items.

## Red Flags

Treat any of these as a release concern:

- The agent only provides a plan and stops.
- It asks the user to manually create files that it could create itself.
- It writes artifacts outside the promised output folder without explanation.
- It says files were created but paths do not exist.
- It claims “verified” without reopening, reading, rendering, or inspecting files.
- It blocks the whole task because an optional runtime pack is missing.
- It silently downgrades to plain text when Word/Excel/PDF generation should be
  available.
- It loses the final answer after a long tool run or shows stale output from a
  previous conversation.
- It invents external facts for a fictional company instead of using the generated
  local data.

## Suggested Follow-Up Prompts

Use these only after the main task finishes.

```text
请重新打开刚才的 ACCEPTANCE_REPORT.md，对照产物文件夹实际文件，检查有没有声称存在但实际不存在的文件。只报告不一致。
```

```text
请在刚才的 Excel 中追加一个“风险评分”列，并同步更新 Word 报告和 PDF。不要重建整个项目；保留原始数据和已有结论，说明你改了哪些文件。
```

```text
我刚刚手动删除了 PDF 文件。请检查产物文件夹当前状态，只恢复缺失的 PDF，不要覆盖 CSV、Excel、Word 和验收报告。
```

The follow-up prompts are designed to test history continuity, live-file
authority, incremental editing, and stale artifact recovery.
