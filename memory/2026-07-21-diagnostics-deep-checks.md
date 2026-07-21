# 2026-07-21 支持诊断深检查层——"诊断全绿但就是用不了"

## 背景

客服侧最高频的疑难杂症：用户授权正常、诊断页全绿，但发消息必失败
（"Permission denied" / "Connection to the model service was interrupted"）。
根因：`support-diagnostics.js` 的 5 项检查全是浅路径——1-token ping 不带
工具定义、engineCheck 只查文件存在、没有会话库检查、没有重复/僵尸进程
检查。而真正能发现问题的深探测能力（`model-compatibility-probe.js`，带
Lily 真实工具形状的诱饵探测）早已存在，却只服务于设置页保存模型时的修
复路径，从未接进诊断。

## 改动

新建 `src/main/support-diagnostics-deep-checks.js`（四个检查函数，全部
fail-open、依赖可注入），`support-diagnostics.js` 只负责装配：

1. **model.agent_conformance**——对当前生效路由复用
   `probeCustomModelProfile`（调用时临时 `LILY_ENABLE_CAPABILITY_GRADING=0`
   跳过评分遍）。只有四个确认模型缺陷码（`MODEL_TOOL_CALLS_UNAVAILABLE` /
   `MODEL_STREAMING_NO_CONTENT` / `MODEL_REASONING_ONLY` /
   `MODEL_NO_CONTENT`）判 error；`MODEL_PROBE_TIMEOUT`、HTTP/网络错误算
   传输噪音 → warning，不与 model.connectivity 重复定罪。
2. **engine.boot**——文件存在后真实 spawn `--version`（10s 超时）。
   ENOENT/非零退出/超时 → error"文件存在但无法运行"。
3. **session.store**——`sessions.json` JSON.parse；`messages.db` 与
   `opencode.db` 用 `node:sqlite` 的 `DatabaseSync(path, {readOnly:true})`
   + `SELECT 1`。**绝不用 `store/sqlite-db.js` 的 Db 类——它会写 WAL
   pragma，诊断必须严格只读。**文件不存在=新安装=ok。
4. **environment.processes**——`ps -eo pid=,args=` / `tasklist /fo csv`，
   10s 超时或失败→跳过（ok）。匹配产品名（lily-workbench / 智能工作台 /
   智能助手 / AI Super Terminal）且排除 `--type=` 子进程后：其他安装位置
   的应用主程序（`.app/Contents/MacOS` 或 `.exe`）→ 重复实例 warning；
   其他位置的引擎/运行时进程 → 僵尸进程 warning。附 recommendedAction
   `close_duplicate_instances`。

**合法位置排除是 environment.processes 的关键**：当前安装根、当前
userData、当前引擎目录一律豁免——bundled runtime node 就住在 userData
（`Application Support/lily-workbench/runtime-bin/node`），不排除的话每
台健康机器都会误报僵尸。

渲染层 `support-diagnostics-settings.js` 按 `check.label` 通用渲染，零改动。

## 测试

`scripts/test-support-diagnostics.mjs` 扩 16 个断言：诱饵工具 400→error、
全过→ok、超时→warning、非 openai→跳过；引擎退出 0/ENOENT/超时/非零；
坏 JSON/坏 sqlite/健康/全新安装；重复实例+僵尸→warning 含路径、干净→ok、
枚举失败→跳过。全量回归维持 465/468 基线（3 个预存无关失败）。

## 经验

- "诊断正常但不能用"类问题，诊断必须复现**真实代码路径**（同样的请求
  形状、同样的 spawn、同样的 DB 打开方式），而不是另造一套浅检查。
- 深探测复用已有探针而非新写：探针版本号（PROBE_PROFILE_VERSION）演进
  时诊断自动跟上。
- fail-open 分级：只有阳性证据才出 warning/error；探测本身跑不起来一律
  ok-with-note，避免诊断自己成为新的误报源。
