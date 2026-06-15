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
- Stronger principle the user stated (2026-06-13): **don't intervene with the agent at all — we PROVIDE our runtime and have designated skills PREFER installing it.** "不要干预 agent 我们只是提供了我们的 runtime 指定技能优先下载安装我们的 runtime." The agent is autonomous (it installs packages as any coding agent does); we don't wrap/own/intercept the install.
- Concrete outcome — runtime packs: install is done by the AGENT via skill `lily-runtime-packs` (`manage_runtime_pack.py`, fetches OUR pre-built engine from OUR CDN). `runtime-packs.js` is now a main-process **READER only** (`getRuntimePackPythonPaths` → extractor PYTHONPATH); the App-side `installPack`/`uninstall` + `runtimepacks:*` IPC were REMOVED (App-side install = intervention + was a dead duplicate of the Python installer). **Do not re-add an App-side install path.** The skill explicitly tells the agent to prefer our runtime and NOT `pip install` heavy libs from PyPI (read-only venv when packaged + PyPI slow/blocked in CN).
- Note the contrast worth remembering: the casual "agent `pip install` from PyPI" path is the UNDER-engineered one (breaks in packaged/CN); the runtime-pack "our CDN → userData → PYTHONPATH" is the robust pattern. Longer term, a single "add a Python capability" path (writable target + CN-reachable source) should serve skills + packs + agent tasks alike.
- "不要堆砌功能" — don't speculatively add surfaces. Build the asked thing; surface the natural-language path instead of inventing controls.
