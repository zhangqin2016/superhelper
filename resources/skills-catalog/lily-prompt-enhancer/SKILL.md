---
name: lily-prompt-enhancer
description: Use when the user gives a short creative request and needs it expanded into a high-quality prompt or brief for images, avatars, product shots, posters, covers, cultural-style characters, presentation illustrations, video storyboards, or visual generation. Avoid mechanical translation; enrich intent, subject, composition, style, lighting, constraints, aspect ratio, and iteration notes.
---

# Lily Prompt Enhancer

Use this skill to expand a short creative request into an executable high-quality prompt or creative brief. Preserve the user's intent; add missing details that improve generation quality.

## When To Use

- The user asks to improve, expand, or write a prompt for images, videos, avatars, posters, covers, storyboards, or visual generation.
- The user provides only a short direction, such as an avatar, product image, poster, cover, character, presentation artwork, social image, or illustration.
- A creative request needs subject, composition, style, lighting, constraints, aspect ratio, or iteration notes before generation.

## When Not To Use

- The user already asks to generate an image and the prompt is specific enough; use the generation skill and then quality-check the result.
- The user needs real-world facts, trends, competitors, or policy support; research first.
- The user needs a full creative strategy or repeated taste decisions; use `lily-creative-director` first, then use this skill to turn the direction into prompt text.

## Process

1. **Identify the use case**: avatar, product shot, poster, cover, character, presentation artwork, video storyboard, etc.
2. **Preserve the core intent**: do not change the subject, brand, identity, product type, or visual goal without permission.
3. **Add visual details**: subject, action, environment, viewpoint, composition, material, clothing, emotion, color, lighting, style, and clarity.
4. **Add output specs**: aspect ratio, shot size, negative space, text-safe area, transparent background, or plain background.
5. **Add negative constraints**: no watermark, no garbled text, no distorted hands/faces, no cropped subject, no low clarity, no fake product edges.
6. **Adapt to model weaknesses**: exact poster text should usually be handled in layout; product shots need crisp edges and believable material; people need natural hands and faces.
7. **Provide variants only when useful**: for example safe version, stronger style version, or video version. Do not dump many unrelated variants.

## Type Notes

- **Avatar**: clear face, identity signal, expression, clothing, clean background, 1:1 ratio, safe crop.
- **Product shot**: realistic material, crisp edges, studio lighting, clean background, visible selling point, no occlusion.
- **Poster / cover**: strong key visual, title-safe area, clear hierarchy; use post-production layout when complex text must be exact.
- **Character art**: era, clothing, temperament, scene, camera angle, color palette, and consistent identity.
- **Presentation artwork**: clean, useful as a background, does not fight the text, composition leaves room for content.
- **Video storyboard**: each shot should include subject action, camera motion, duration, shot size, rhythm, transition, and continuity.

## Quality Bar

- Do not merely translate a short request.
- Do not stack fashionable adjectives without subject, composition, and use case.
- Do not ask an image model to render large amounts of exact text.
- Do not ignore realism, product edges, or display use cases for product images.
- Do not produce a video storyboard without camera motion, duration, or changing action.

## Output Requirements

- Provide the enhanced main prompt first; include negative prompt only when useful.
- Use the user's current language for explanations unless the user asks for another language.
- Clearly state ratio and use case, such as 1:1 avatar, 16:9 presentation artwork, or 9:16 short video.
- For multiple outputs, keep the subject consistent and vary only angle, composition, or selected details.
- If the request is vague, provide a reasonable default version and mark the adjustable parameters.

## Relationship To Lily Creative Director

- `lily-creative-director` decides direction, taste, medium strategy, and iteration tradeoffs.
- This skill turns that direction into executable prompt text.
- When the user asks for a higher-end look, a different style, or stronger taste judgment, use `lily-creative-director` first.
