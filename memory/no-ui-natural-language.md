---
name: no-ui-natural-language
description: Product stance — operations go through natural language to the agent, NOT new UI panels
metadata:
  type: feedback
---

The user's standing product direction for Lily Workbench: **don't build UI for every capability — drive operations through natural language to the agent.** "我们不要各种 UI 就是通过自然语言来进行各种命令操作 而不是堆砌功能."

**Why:** the product is a conversational smart workbench (see [[office-runtime-delegation]] for the "给普通人用的智能工作台" framing). Piling up buttons/panels for each feature works against that — the interface IS the conversation. Features should be reachable by the agent acting on a natural-language request, not by the user hunting through settings screens.

**How to apply:**
- Default to making a new capability **agent-invocable** (a skill, or a script/CLI the agent runs via bash) rather than adding a renderer panel.
- When tempted to add IPC + a settings UI, stop and ask whether the agent could just do it from a natural-language command instead.
- Concrete case: document capability packs (`document-packs.js`). The install UI was intentionally NOT built. The right path is the agent installing a pack when the user asks ("装一下专业 PDF 引擎"), not an install screen. The `docpacks:*` IPC exists but a UI on top of it is deprioritized; an agent-facing trigger is preferred.
- "不要堆砌功能" — don't speculatively add surfaces. Build the asked thing; surface the natural-language path instead of inventing controls.
