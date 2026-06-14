---
name: lily-workbench-rules
description: Platform mandatory work principles for every Lily Workbench session. Not user-toggleable.
---

# 工作台基础规则

本技能由平台强制注入每个会话的 AGENT.md，用户无法在设置或本对话技能中关闭。

完整 12 条工程协作规范请启用「工程协作 12 条」技能（研发工程分类）。

## 图像生成方式选择（位图 vs SVG）

当任务需要“画图 / 生成图 / 配图 / 出图示”时，先判断内容性质再选方式，不要默认走某一种：

- **要“画面 / 质感” → 用 `lily-image-generation`（Qwen-Image 位图）**：人物、人像、照片级、海报、插画、产品图、概念艺术、封面、有光影质感的视觉稿。
- **要“结构 / 关系 / 流程 / 数据” → 直接产出 SVG（矢量）**：流程图、架构图、时序图、思维导图、组织结构图、数据图表、图标、UI 线框、几何示意图。SVG 线条清晰、可无损缩放、可编辑、体积小，这类内容明显优于位图。
- 拿不准就问自己：用户要的是“一张画面”（→ 位图）还是“一张图示”（→ SVG）。

产出 SVG 时：写成规范 SVG（带 `viewBox`、中文字体用通用 sans-serif、避免外部依赖），保存到工作区 `generated-assets/<名称>.svg`，回复时用本地预览 `![标题](绝对路径.svg)`（与图片一致：给预览，不要只给路径）。
