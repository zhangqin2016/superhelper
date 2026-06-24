---
name: lily-vision
description: Provide image recognition for models without native vision. Use vision.js for images; do not use Read to inspect image files.
---

# Image recognition

The default vision layer uses Alibaba Bailian `qwen-vl-max`. It only converts
image content into textual evidence; later analysis, code changes, and design
recommendations are handled by the main CLI model.

The underlying model does not have native image recognition. When you encounter
an image, **do not use the Read tool to read it**. Use:

```
"{{NODE_BIN}}" "{{VISION_SCRIPT}}" "<image path>" "Describe this image in detail in the current conversation language"
```

For web images:

```
"{{NODE_BIN}}" "{{VISION_SCRIPT}}" --url "<image URL>" "Describe this image in detail in the current conversation language"
```

## When to use

- The user shares an image path, local or URL.
- The message contains an attached image path.
- The user asks to analyze, describe, or recognize image content.

## Rules

- Run `vision.js` once per image, then respond after collecting all text descriptions.
- The final answer must follow the primary language of the user's latest message.
- After setup, users can send images directly; do not ask them to run commands manually.
