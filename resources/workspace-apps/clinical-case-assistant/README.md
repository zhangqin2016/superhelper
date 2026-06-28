# 临床病例参考助手 (Clinical Case Assistant)

> **面向执业医师的辅助参考工具,不是诊断系统。** 所有输出仅供医师参考,最终诊断与处置由执业医师裁定。本应用不替代任何临床判断。

一个**独立的工作台应用**:把住院病案(扫描件/PDF)整理成结构化病历,支持"问病例"和"对相似新病人给参考建议"。当前聚焦**风湿免疫单专科**。

## 设计边界(三条硬约束)

1. **独立应用,不碰平台基座** —— 作为 `.lilyspace.zip` 导入;不写平台数据库、不改全局配置。
2. **数据全在应用内** —— 所有病例数据存在本应用文件夹内(`cases/`),不外泄到共享存储。
3. **PHI 不出门** —— 本地/院内离线运行;**任何数据进入模型之前先脱敏**(见下)。

## 隐私:脱敏 fail-closed(`source/deidentify.cjs`)

每份病例在**存储或送入模型之前**强制脱敏,且失败时**多脱不少脱**(隐私失败要 fail-closed):

- 丢弃:姓名、联系人、住址、出生日期、邮编、健康卡号、电话。
- 脱敏为不可逆 token:病案号/住院号(`caseId`);身份证折叠成稳定的 `patientKey`(同一病人多次住院可关联,但不保留任何"像身份证"的字段)。
- 全文清洗:任意自由文本里的身份证号、手机/座机号、已知姓名一律打码。
- 局限(已明示,不藏):自由文本里的第三方姓名不保证全捕获 —— 所以坚持"原始病案不出本地",脱敏是纵深防御,不是放行未审文本的许可证。

## 确定性,不交给模型(`source/emr_schema.cjs`,项目 Rule 5)

化验值的 ↑/↓ 由**参考范围代码判定**(白细胞/中性粒/淋巴/血红蛋白/血小板),不让模型猜;无参考范围的指标标 `unknown`,**绝不静默判"正常"**。

## 不许变笨(项目 Rule 13)

每个能力的失败模式都退回安全基线:抽取不准→人工复核不静默采信;无证据→不出建议、退回"信息不足";化验无参考→标 unknown;急危征象→红旗置顶;脱敏失败→多脱。

## 现状

- ✅ 地基:EMR schema(确定性化验判读)+ 脱敏(fail-closed)。
- ✅ 抽取流水线:扫描件→视觉模型→结构化→**立即脱敏**(`extract_case.cjs`,`finalizeCase` 为脱敏唯一收口);病历卡渲染(`render_case.cjs`:问题列表+化验时间序列)。
- ✅ 推理层安全内核:红旗危急值(`red_flags.cjs`,确定性、强制置顶)、相似病例检索(`retrieve_cases.cjs`,带"信息不足"认怂)、建议装配(`advise.cjs`:红旗置顶+每条挂证据+无证据即隐去+非诊断声明)。
- ✅ **精度加固层(引擎无关、可测)** `verify_extraction.cjs`:确定性字段校验(日期/年龄/性别枚举/ICD格式/化验生理范围+单位/诊断↔化验一致)+ **双轨共识**(两份独立抽取比对,一致=高置信、分歧=冲突)+ 每字段置信度 + **待核对队列**(医师只看存疑项)。已接入 `finalizeCase`(支持 `second` 双轨)。
- ✅ 可导入包:`scripts/build-clinical-case-app.mjs` → `dist/workspace-apps/clinical-case-assistant-*.lilyspace.zip`(已用生产导入代码验证可解包)。
- 测试:`scripts/test-clinical-case-{deid,render,extract,reasoning,verify}.mjs`(均纯逻辑、模型可注入)。
- ⏳ 待建:**可插拔识别引擎**(本地优先:RapidOCR+Qwen-VL 基线 → MinerU2.5/PaddleOCR-VL 本地升级;商用 TextIn 仅脱敏后/私有化)、NL"问病例"问答、医师核对 UI(原图↔字段+置信度红黄绿)、真模型联调。

## 识别引擎策略(已定:可插拔·本地优先)

SOTA 是"文档解析 VLM"(MinerU2.5/PaddleOCR-VL/GLM-OCR ~95+ OmniDocBench;Qwen-VL 中文强;dots.ocr 表格)。本应用做成**可插拔引擎**:默认复用代码库现有 **RapidOCR+Qwen-VL**(离线、零新增);可一键升级为本地/院内 SOTA VLM(PHI 不出门);商用 **合合 TextIn**(医疗病历专门优化、与扫描全能王同源)仅作"脱敏后/私有化"可选项。**精度的核心在 `verify_extraction.cjs` 这层,与选哪个引擎无关。**

## 模块一览(`source/`)

| 文件 | 职责 | 模型? |
|---|---|---|
| `emr_schema.cjs` | 病历结构 + 化验↑↓(确定性) | 否 |
| `deidentify.cjs` | PHI 脱敏(fail-closed) | 否 |
| `extract_case.cjs` | 扫描件→结构化(`finalizeCase` 脱敏收口) | 是(视觉) |
| `render_case.cjs` | 病历卡渲染 | 否 |
| `red_flags.cjs` | 危急值红旗(确定性、置顶) | 否 |
| `retrieve_cases.cjs` | 相似病例检索 + 认怂 | 否 |
| `advise.cjs` | 建议装配(证据强制+非诊断) | 是(措辞,可注入) |
| `verify_extraction.cjs` | 精度加固:校验+双轨共识+置信度+待核对队列 | 否 |
