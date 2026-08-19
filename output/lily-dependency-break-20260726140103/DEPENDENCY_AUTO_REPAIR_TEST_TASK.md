# Lily 依赖自动修复综合测试任务

把下面整段自然语言复制到 Lily 新任务里执行。不要提前告诉 Lily 我们手动破坏了哪些文件，让它自己发现、修复、继续完成。

```text
请完成一次“本地依赖自动诊断、自动修复、完整交付”的综合验收任务。你必须尽可能完成用户任务，不要因为某个本地依赖路径坏、runtime pack 已安装但不可用、浏览器版本不匹配、LibreOffice 缺失或 OCR/视觉工具选择失败就停止。遇到依赖问题时，先调用 Lily 的能力状态/依赖工具检查当前状态，优先使用 runtime_pack_install / repair 路线修复或重装；只有所有 Lily 托管修复路线都失败后，才明确说明具体缺哪个依赖、哪个可执行文件或哪个工具。

输出目录请使用：
/Users/zhangqin/testlilynew/output/lily-dependency-auto-repair-20260726

请从零生成一套“星河运营中心 2026 年 7 月多渠道增长复盘”交付包，要求如下：

1. 先做依赖与能力自检
   - 检查 Office 渲染/转换、PDF 解析、复杂 PDF/Docling、大文件处理、图片处理、Pandoc、FFmpeg、浏览器自动化是否可用。
   - 如果某个 runtime pack 显示已安装但健康检查失败，必须尝试 repair/reinstall，不要直接说不可用。
   - 不要临时 pip install / npm install；优先走 Lily 管理的 runtime pack 工具。

2. 生成数据源
   - 创建 CSV：至少 2,000 行线索明细，字段包含日期、城市、渠道、线索数、有效线索、成交数、收入、成本、客服负责人、备注。
   - 创建 JSONL：至少 500 条客户跟进记录，包含状态变化、跟进文本、风险标签。
   - 数据要可复算，不要只写结论。

3. 使用大文件/表格能力分析
   - 用适合大文件的方式读取 CSV/JSONL，不能一次性把全量内容塞进上下文。
   - 计算渠道 ROI、城市成交率、客服负责人贡献、异常成本、漏斗转化。
   - 输出一个带公式的 XLSX 工作簿，至少 4 个 sheet：RawData、Pivot、Dashboard、ActionPlan。
   - 工作簿里要有公式，并进行公式重算验证；如果 LibreOffice 不可用，先自动修复依赖再重试。

4. 生成 Word 报告并转换 PDF
   - 生成一份中文 DOCX 复盘报告，包含封面、摘要、指标表、渠道分析、城市分析、风险发现、下月行动计划和附录。
   - 不要使用容易缺字形的装饰符号；CJK 字体要稳。
   - 将 DOCX 通过确定性路线转换成 PDF，优先使用 Lily 管理的 LibreOffice/render_document 路线。
   - 纯转换过程中不得悄悄修改源 DOCX；如果发现必须改源文件才能修复渲染问题，先明确说明并创建一个单独的修复副本，不要覆盖原 DOCX。

5. PDF/复杂文档能力
   - 对生成的 PDF 做结构读取和页面级检查。
   - 尝试使用复杂 PDF/Docling 或等价高精度 PDF 路由恢复版面、表格和阅读顺序。
   - 如果 pro-pdf/Docling 已安装但不可导入，必须自动 repair/reinstall 后重试。

6. 图片处理能力
   - 从关键指标生成至少 3 张 PNG 图表或信息图。
   - 用图片处理能力生成缩略图和一张 contact sheet。
   - 检查图片尺寸、格式和是否可打开。

7. Pandoc 能力
   - 生成一份 Markdown 版摘要。
   - 用 Pandoc 转换为 HTML。
   - 如果 Pandoc 可执行文件损坏或缺失，必须自动修复后重试。

8. FFmpeg 能力
   - 生成一个 3-5 秒的本地测试 MP4，画面展示核心 KPI 文案或图表截图。
   - 抽取音视频元数据，另导出一个短音频或封面帧。
   - 如果 ffmpeg/ffprobe 缺失或损坏，必须自动修复后重试。

9. 浏览器自动化能力
   - 用本地 HTML 摘要页打开检查，截图保存。
   - 检查页面无控制台错误、主要文字可见、布局没有明显遮挡。
   - 如果 Playwright/Chromium 浏览器目录缺失或版本不匹配，必须自动修复 web-automation runtime pack 后重试。

10. 最终交付与验收报告
   - 输出所有文件的绝对路径。
   - 写一份 ACCEPTANCE_REPORT.md，必须包含：
     - 依赖自检结果
     - 哪些依赖曾失败
     - 是否自动 repair/reinstall
     - 每个产物的生成状态
     - PDF 渲染页数与视觉检查覆盖说明
     - 公式重算结果
     - Pandoc、FFmpeg、浏览器自动化验证结果
     - 仍未完成或未验证的项目，必须明确写原因
   - 目标是尽可能完成全部交付；不要只输出诊断报告。
```

## 当前人为破坏点

这次我已经把以下本地 runtime pack 入口重命名为 `.broken-by-codex-20260726140103`：

- `pandoc/bin/pandoc`
- `ffmpeg/bin/ffmpeg`
- `ffmpeg/bin/ffprobe`
- `pillow/PIL`
- `large-document/fitz`
- `large-document/duckdb`
- `pro-pdf/docling`
- `web-automation/browsers`

恢复脚本：

```bash
node /Users/zhangqin/aicode/ceshitermianl/output/lily-dependency-break-20260726140103/restore-lily-dependencies.mjs
```

如果 Lily 的自动修复正常，上述部分可能会被 runtime pack repair/reinstall 覆盖修好；恢复脚本遇到已存在的目标会跳过。
