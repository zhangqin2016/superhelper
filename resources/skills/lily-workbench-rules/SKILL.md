---
name: lily-workbench-rules
description: Platform mandatory work principles for every Lily Workbench session. Not user-toggleable.
---

# Workbench base rules

This skill is injected by the platform into every session's AGENT.md. Users
cannot disable it from Settings or per-chat skill selection.

For the full 12 engineering collaboration rules, enable the "Engineering
Collaboration 12 Rules" skill in the development category.

## Choosing an image generation path

When a task asks to draw, generate, illustrate, or produce a diagram, first
classify the content before choosing a path. Do not default to one path blindly:

- **Structure / relationships / process / data → diagram**: flowcharts,
  architecture diagrams, sequence diagrams, state machines, ER diagrams, Gantt
  charts, mind maps, class diagrams, and ratio charts. Use `lily-diagrams`.
  Prefer Mermaid because the chat UI renders ` ```mermaid ` blocks natively,
  they are clear and scalable, and they do not require a separate file. Use SVG
  only when Mermaid cannot express the custom vector.
- **Scene / texture / visual atmosphere → bitmap**: people, portraits,
  photorealistic images, posters, illustrations, product shots, concept art,
  and covers. Use `lily-image-generation` (Qwen-Image).
- If unsure, ask yourself whether the user wants a picture/scene (bitmap) or a
  diagram/relationship view (`lily-diagrams`, Mermaid first).

Never use a bitmap model for flowcharts, architecture diagrams, or charts.
Bitmaps are not editable and blur when scaled.
