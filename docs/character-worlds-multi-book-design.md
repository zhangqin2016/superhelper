# Multi-book merge strategy — 设计方案（§10.4.1）

Date: 2026-08-01
Status: Design proposal (not yet implemented)
Source: design spec §10.4.1 step 1–2

## 需求（设计 §10.4.1）

Resolve chat-, Persona-, character-, and optional profile-global book
revisions from the admitted binding. Apply source precedence: chat and
Persona lore first; character and global lore follow the selected merge
strategy. Source precedence breaks ties but never bypasses entry insertion
order.

## 现状

- `character_session_bindings` 只有单 `character_revision_id` pin；
  world book 是 character revision 的**单数** `characterBookRevisionId` 引用。
- `turn-world-book.js` / `world-book-activation.js` 只处理单个 book revision，
  无 chat/persona/global 概念。
- 回复变体（P3-2）与场景（group-modes）不涉 book 引用。

## 差距

1. **数据模型**：无 chat-book / persona-book / profile-global-book 概念；
   binding 不能引用多本 book。
2. **激活器**：`resolveWorldBookActivation` 输入是单 `bookRevision`，
   无 merge strategy（chat/persona 优先 + character/global 按 strategy）。
3. **迁移**：现有单 characterBookRevisionId 需保持兼容。

## 建议实施路径

### Step 1 — schema（迁移）
新增 `character_session_book_bindings`：
```sql
CREATE TABLE IF NOT EXISTS character_session_book_bindings (
  session_id TEXT NOT NULL,
  owner_scope TEXT NOT NULL,
  scope TEXT NOT NULL,          -- chat | persona | character | global
  world_book_revision_id TEXT NOT NULL,
  merge_strategy TEXT NOT NULL, -- constant | chat_first | persona_first | character_first | union
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, owner_scope, scope)
);
```
现有单 book pin 保持 `characterBookRevisionId`（迁移期视为 scope=character 单书）。

### Step 2 — 激活器多书输入
`resolveWorldBookActivation` 增加可选 `books: [{ scope, revision, mergeStrategy }]`；
- chat/persona 书恒先合并（precedence 1）
- character/global 书按 mergeStrategy 排序合并
- 条目插入顺序保持（constant 优先、非 constant 按 activation 顺序）

### Step 3 — 编译/绑定
- set-binding 接受可选 book 绑定（每 scope 一个 revision）
- snapshot 携带 books 数组（bounded）

### Step 4 — 测试 + 门禁
- merge 优先级单元测试（chat/persona > character/global，strategy 排序）
- 迁移兼容测试（旧单 book pin 行为不变）
- 确定性：同输入同合并结果（fingerprint 含 books）

## 风险
- schema 迁移需在 `store/schema.js` 加迁移版本 + 回滚测试
- binding CAS（expectedBindingVersion）语义扩展
- 多书增加编译 token 预算压力（budget 需按 book 分摊）

## 决策点
- mergeStrategy 默认值：设计未指定 → 建议 `constant`（多书常量合并，无优先级覆盖）
- profile-global book 来源：用户配置（非绑定）——Phase 3 语义索引后可接入

