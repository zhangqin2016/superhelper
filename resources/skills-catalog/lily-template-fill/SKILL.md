---
name: template-fill
description: "Use this skill when the user wants to fill an existing Word (.docx) template with data — mail-merge style. Triggers: 用模板生成合同/offer/发票/证书/通知书, 套用模板, 批量填充, 'fill this template', 'mail merge', producing many documents from one template plus a data table. The template already contains placeholders like {{ name }} or {%p for row in rows %}. Do NOT use this to author a brand-new document from scratch (use the docx skill) or to read/extract content from a document."
license: Proprietary
intent: >-
  把一份带占位符的 Word 模板 + 结构化数据，确定性地渲染成填好的 .docx。
  占位符替换由代码做（docxtpl/Jinja2），模型只负责把用户的自然语言或上传数据
  整理成 {占位符: 值} 的映射，并在有占位符缺数据时如实告知用户。
type: reference
---

# Template Fill (.docx)

Fill an existing Word template that contains Jinja2 placeholders with structured
data, producing a new filled `.docx`. The substitution is deterministic — it runs
in Python (`docxtpl`), not in the model. Your job is only to turn what the user
gives you into the data mapping, then report the result honestly.

## Placeholder syntax (how a template is authored)

A template is a normal `.docx` whose text contains:

- `{{ customer_name }}` — a single value.
- `{%p for item in items %}` … `{%p endfor %}` — repeat the whole paragraph (use
  `{%tr ... %}` to repeat a table row, `{%tc ... %}` a table cell).
- `{{ item.price }}` — nested field when a value is an object.

If the user hasn't authored placeholders yet, explain this syntax or use the
`docx` skill to create the template first.

## Workflow

1. **Inspect the template** to learn exactly which placeholders it declares —
   never guess the names:

   ```bash
   python scripts/fill_template.py inspect /path/to/template.docx
   # → {"ok": true, "variables": ["customer_name", "items", ...]}
   ```

2. **Build the data mapping** (this is the judgment part). Map the user's text,
   uploaded table, or answers onto the declared variable names. Write it to a
   JSON object file, e.g. `data.json`:

   ```json
   { "customer_name": "张三", "items": [ {"name": "服务费", "price": "¥1200"} ] }
   ```

3. **Fill**:

   ```bash
   python scripts/fill_template.py fill /path/to/template.docx data.json /path/to/output.docx
   # → {"ok": true, "output": "...", "missing": [], "provided": [...]}
   ```

4. **Report honestly.** If `missing` is non-empty, those placeholders had no data
   and were left blank — tell the user which ones and ask for the values rather
   than shipping a document with silent gaps.

## Batch (many documents from one data table)

When the user has a table of N rows and wants one document per row, loop: write
each row to a small JSON object and call `fill` with a distinct output path. Keep
the loop in code/shell — it's a deterministic transform, not a model task.

## Notes

- The data file must be a JSON **object** (`{...}`), not an array, at the top
  level. For lists inside the document, put them under a key (`"items": [...]`).
- Output is always a new file; the template is never modified in place.
- Errors come back as `{"ok": false, "error": "..."}` with a non-zero exit code.
