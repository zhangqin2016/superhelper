---
name: lily-browser-qa
description: Use when a web page, local app, dashboard, form, generated HTML, React/Vue app, or browser-visible artifact needs to be verified by actually opening it. Covers running a dev server when needed, checking desktop/mobile viewports, clicking through primary flows, inspecting console errors, validating loading/empty/error states, capturing screenshots, and fixing regressions before delivery.
---

# Lily 浏览器验收

本技能把浏览器验证变成网页/应用交付的默认门禁。只要产物能在浏览器里打开，就不要只靠模型想象它“应该没问题”。

## 何时使用

- 用户要求做网页、后台、仪表盘、小工具、HTML/React/Vue 应用。
- 修改了前端页面、组件、样式、交互、表单、上传、弹窗、导航或图表。
- 用户反馈“页面不对、按钮没反应、布局错、打不开、空白、报错”。
- 交付前需要证明页面能打开、能操作、移动端/桌面端正常。

纯脚本、纯后端、纯文档任务不用本技能，除非最终产物包含浏览器页面。

## 验收流程

1. **确定打开方式**：已有 dev server 就复用；没有但项目需要服务就启动；单文件 HTML 可直接打开。
2. **等待页面稳定**：不要截图空白页；等待主要内容、资源和首屏状态出现。
3. **检查主路径**：点击主要按钮，填写关键表单，触发常见状态。
4. **看控制台和网络错误**：有错误先判断是否影响用户路径；影响则修。
5. **验证布局**：至少检查一个桌面宽度和一个移动端宽度；确认文字不溢出、控件不重叠。
6. **验证状态**：加载、空状态、错误提示、禁用态、成功态要合理。
7. **修复后复验**：发现问题修完必须重新打开或重新截图确认。
8. **交付证据**：说明验证过的页面、路径、视口或命令；不能验证时说明原因。

## 质量红线

- 页面空白、控制台致命错误、主按钮不可点，不算完成。
- 移动端明显横向溢出、文字遮挡、按钮挤压，不算完成。
- 表单提交无反馈、加载状态卡住、错误提示不可读，不算完成。
- 只说“应该可以”而没有打开或说明无法打开，不算完成。

## 和其他技能配合

- 和 `lily-coding-core` 配合：代码实现后做浏览器验收。
- 和 `lily-ui-quality` 配合：发现视觉或交互问题后按 UI 质量标准修。
- 和文档/媒体技能配合：当交付物是 HTML 报告、网页预览或可视化页面时使用。
