---
name: lily-image-qa
description: Use after image generation, image editing, visual recognition, or visual asset delivery to inspect whether the result is acceptable. Checks subject completeness, clarity, hands/faces/text/product edges, composition, artifacting, use-case fit, and whether the image should be retried or revised.
---

# Lily Image QA

Use this skill after visual generation, editing, recognition, or asset delivery. The goal is to decide whether the image is fit for the intended use.

## When to Use

- After generating or editing avatars, product images, posters, covers, illustrations, PPT images, characters, or video keyframes.
- When the user asks whether an image is clear, accurate, usable, flawed, or should be redone.
- After visual recognition when content, text, product details, people, or composition must be confirmed.

## Review Checklist

- Subject: main object/person/product is complete and recognizable.
- Text: visible text is readable and not garbled.
- People: faces, eyes, hands, pose, clothing, and scale are plausible.
- Products: edges, logos, labels, materials, and proportions are intact.
- Composition: crop, balance, background, lighting, and focus match the use case.
- Artifacts: no obvious blur, duplicated parts, warped shapes, extra limbs, or broken details.
- Use-case fit: avatar, poster, slide, product shot, cover, or thumbnail requirements are met.

## Output

State one of: pass, usable with minor caveat, revise, or regenerate. Include the specific issue and the shortest corrective prompt or edit instruction.
