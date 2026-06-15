---
name: lily-ui-quality
description: Use when the task creates, edits, reviews, or verifies any visual interface or web artifact: websites, dashboards, forms, tools, landing pages, admin screens, mobile/desktop layouts, generated HTML, React/Vue components, or visual app prototypes. Enforces Lily UI quality: hierarchy, spacing, responsive layout, states, accessibility, no overlap/overflow, professional aesthetics, browser/screenshot verification when possible.
---

# Lily UI 质量门禁

本技能把前端设计、交互可用性和视觉 QA 包装成 Lily 的统一质量门禁。它适用于任何会被用户“看见”和“操作”的产物。

## 何时使用

- 生成或修改网页、后台、仪表盘、表单、小工具、HTML/React/Vue 组件。
- 用户要求“好看一点、专业一点、交互合理、适配手机、修布局”。
- 产物包含按钮、菜单、输入框、状态、列表、卡片、图表、上传、弹窗或导航。
- 需要审查截图、页面渲染、移动端/桌面端布局。

纯后端脚本、纯数据处理、纯文档任务不用本技能，除非输出是可视化页面或 UI。

## 质量标准

- **信息层级清楚**：用户第一眼知道当前页面是什么、能做什么、下一步是什么。
- **控件符合习惯**：按钮用于命令，输入/选择/开关/滑块分别承载对应交互；不要用大段文字解释 UI 怎么用。
- **状态完整**：加载、空状态、错误、禁用、成功、危险操作确认都要有合理表现。
- **响应式可靠**：移动端和桌面端都不能挤压、重叠、横向溢出或文字遮挡。
- **视觉不过度模板化**：避免廉价渐变、无意义大卡片堆叠、单一色相铺满、装饰性圆球/光斑。
- **文字适配容器**：按钮、表头、卡片、侧栏里的文字必须放得下；必要时换行或缩短文案。
- **密度匹配场景**：运营/后台/CRM/工具类界面应紧凑、安静、可扫描；创意/游戏/展示类可以更表达性。
- **可验证**：能打开页面就用浏览器看；能截图就检查桌面和移动端；发现问题要修复后再交付。

## 执行方式

1. 先判断页面类型：工具、后台、表单、仪表盘、内容页、营销页、游戏或可视化。
2. 按页面类型选择密度、导航、控件和视觉风格，不套同一套 hero/card 模板。
3. 修改 UI 时先检查现有设计系统和 CSS 变量，优先沿用本项目风格。
4. 有页面运行环境时启动或打开页面，用浏览器实际验证。
5. 检查关键断点：移动端窄屏、普通桌面、宽屏。
6. 交付时说明验证过的页面/断点；没能验证要明确说原因。

## 严禁

- 文字和控件重叠。
- 按钮文字溢出或被图标挤压。
- 用大面积单色渐变冒充设计。
- 后台工具做成营销 landing page。
- 需要用户检查实物/图片/产品时使用模糊、暗黑、裁切严重的装饰图。
- 在可运行页面未打开检查的情况下声称“视觉已验证”。
