---
name: lily-creative-director
description: Use when the user asks to create, improve, evaluate, or iterate visual/audio creative output: images, posters, covers, avatars, product shots, illustrations, concept art, video prompts, voiceover direction, thumbnails, brand visuals, or “make it prettier/more cinematic/more professional”. Expands vague prompts into production-ready creative direction with composition, style, lighting, mood, aspect ratio, usage context, local save/preview expectations, and feedback iteration.
---

# Lily Creative Director

Use this skill to turn short creative requests into reusable creative direction for images, covers, posters, videos, voiceovers, and similar media. The goal is not translation; the goal is to preserve the user's intent and add the missing production details.

**Fill the missing details from context — do not interrogate the user.** When the request is bare (e.g. just "make an image" with no subject), infer it from the CURRENT conversation and the latest deliverable (the report, dataset, or topic just discussed), pick sensible defaults, and proceed to produce the work. Do NOT reply with a generic subject/style/size questionnaire. Ask at most ONE short, context-aware question, and only when there is genuinely no usable context to infer a subject.

## When To Use

- The user wants to generate or improve images, posters, covers, avatars, product shots, illustrations, concepts, or thumbnails.
- The user wants video prompts, animation direction, storyboards, shot descriptions, or motion guidance.
- The user wants voice, narration, voiceover style, pacing, emotion, or character voice direction.
- The user says the output is not attractive, inaccurate, fake-looking, off-style, not professional enough, or needs a different feeling.

Do not use this for pure documents, code, or factual research unless the final deliverable includes creative visual or audio work.

## Creative Brief

When the user's request is short, add the missing details:

- **Use case**: avatar, cover, poster, product shot, illustration, social image, presentation artwork, character concept, video shot.
- **Subject**: person, product, scene, action, viewpoint, material, clothing, expression.
- **Composition**: close/medium/wide shot, centered, rule of thirds, negative space, foreground/midground/background, focal point.
- **Lighting**: natural light, studio light, backlight, soft light, neon, cinematic, low-key, high-key.
- **Style**: realistic, commercial photography, traditional cultural style, anime, flat illustration, 3D, film poster, minimal.
- **Aspect ratio**: 1:1 for avatars, 9:16 for mobile, 3:4 for posters, 16:9 for banners, or a ratio chosen for the user's use case.
- **Quality constraints**: sharp, complete subject, little or no generated text, no extra fingers, no distorted anatomy, no watermark.

## Type-Specific Guidance

- **People / avatars**: clear face, natural features, outfit and background that support the identity; avoid excessive smoothing or plastic texture.
- **Product shots**: believable material, clean edges, credible lighting, usable for commerce or display; do not hide the product.
- **Posters / covers**: define the key visual, title area, and hierarchy; if exact text matters, recommend post-production layout instead of asking an image model to render lots of text.
- **Characters / cultural styles**: specify era, clothing, scene, temperament, camera angle, and color palette; keep identity consistent.
- **Video**: include camera motion, duration, rhythm, subject action, scene changes, and negative constraints.
- **Voice**: include character, emotion, pace, pauses, usage context, and desired listening impression.

## Delivery Requirements

- Generated media must be saved to the current workspace or the user's requested location.
- Preview directly when possible; otherwise provide an absolute path.
- If the user asks to open or locate the result, provide a path that can be opened.
- When iterating, extract the concrete issue from feedback: subject, style, composition, color, realism, clarity, or ratio, then revise in that direction.
- Surrounding explanations should follow the primary language of the user's latest message.

## Do Not

- End with a mechanically translated prompt when the user needed creative direction.
- Generate media without a saved path.
- Ask an image model to render large amounts of exact poster text.
- Use blurry, dark, or heavily cropped visuals when the user needs a recognizable real product or person.
- Randomly change the entire style on every revision.
