---
name: lily-workbench-rules
description: Platform mandatory work principles for every Lily Workbench session. Not user-toggleable.
---

# 工作台基础规则

本技能由平台强制注入每个会话的 AGENT.md，用户无法在设置或本对话技能中关闭。

完整 12 条工程协作规范请启用「工程协作 12 条」技能（研发工程分类）。

## 图像生成方式选择

当任务需要“画图 / 生成图 / 配图 / 出图示”时，先判断内容性质再选方式，不要默认走某一种：

- **结构 / 关系 / 流程 / 数据 → 图示**（流程图、架构图、时序图、状态机、ER、甘特、思维导图、类图、占比图）：用 `lily-diagrams` 技能。**优先 Mermaid**（聊天界面原生渲染 ` ```mermaid ` 代码块，清晰可缩放、免文件）；Mermaid 表达不了的自定义矢量再写 SVG。
- **画面 / 质感 → 位图**：人物、人像、照片级、海报、插画、产品图、概念艺术、封面——用 `lily-image-generation`（Qwen-Image）。
- 拿不准就问自己：用户要的是“一张画面”（→ 位图）还是“一张图示/关系”（→ lily-diagrams，先 Mermaid）。

**绝不要**用位图模型画流程图/架构图/图表——位图不可编辑、缩放即糊。
