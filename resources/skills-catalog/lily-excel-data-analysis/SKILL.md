---
name: lily-excel-data-analysis
description: Use when the user asks to analyze spreadsheet or tabular data, find anomalies, clean messy data, identify fields, create charts, summarize conclusions, compare sheets, or produce a reviewable Excel/CSV analysis from .xlsx, .xls, .csv, .tsv, or extracted tables. Emphasizes field recognition, outlier checks, formulas/charts, and reproducible outputs.
---

# Lily Excel Data Analysis

Analyze tabular data in a way the user can audit. Prefer clear assumptions,
visible calculations, and reproducible outputs over opaque one-shot answers.

## When to Use

- The user asks to analyze a spreadsheet, CSV/TSV, or extracted table.
- The task includes cleaning, deduping, field recognition, anomaly detection,
  missing values, trend analysis, grouping, pivot-like summaries, charts, or
  conclusions.
- The user wants an Excel workbook, chart, cleaned table, or written summary
  derived from spreadsheet data.
- PDF/Word tables have been extracted and need structured analysis.

## When Not to Use

- The primary deliverable is only editing spreadsheet formatting or formulas:
  use the spreadsheet tooling skill directly.
- The user asks for a database/ETL pipeline or app code rather than an Excel
  analysis deliverable.
- The user asks for a visual slide deck from already-finished analysis: use PPT
  skills and then `lily-ppt-design-qa`.
- The source is a hard PDF table that has not been reliably extracted: route
  through `lily-pdf-extraction-router` first.

## Analysis Workflow

1. Inventory the workbook: sheets, dimensions, header rows, merged cells,
   hidden rows/columns, formulas, filters, charts, and obvious data regions.
2. Identify fields:
   - infer column meaning, units, dates, currencies, IDs, categories, and free
     text;
   - normalize header names only in a new cleaned output, not destructively in
     the user's source file;
   - preserve source sheet names and row references for traceability.
3. Profile data quality:
   - missing values, duplicates, invalid dates, inconsistent categories,
     mixed units, text numbers, impossible negatives, and suspicious zeros;
   - outliers by distribution, business rules, and time-series jumps;
   - formula errors and stale calculated values when formulas exist.
4. Clean with an audit trail:
   - write cleaned data to a new sheet/file;
   - keep a `Data quality` or `Cleaning log` sheet with rules applied and row
     counts before/after;
   - never overwrite the only copy of user data.
5. Analyze:
   - use pandas for exploration, grouping, joins, and statistics;
   - use Excel formulas for workbook calculations that users may later change;
   - use pivots/tables/charts when they help the user inspect the result.
6. Produce conclusions:
   - separate findings from assumptions;
   - cite sheet/column/row ranges behind important claims;
   - include anomalies that need user confirmation rather than silently fixing
     ambiguous data.
7. Verify the output:
   - reopen the workbook or exported file;
   - recalculate formulas when formulas were added or changed;
   - check chart ranges and that summary numbers match source data.

## Formulas, Charts, and Reviewability

- Prefer formulas in generated workbooks for totals, percentages, ratios, and
  checks the user may edit later.
- Use charts only when the data shape supports them; label axes, units, and
  series clearly.
- Add source references: sheet, column, row range, and filtering rule.
- For anomaly lists, include enough columns for the user to find the original
  record.
- If a written summary is delivered, also provide the workbook or extracted
  table path when possible so the conclusion can be checked.

## Quality Red Lines

- Do not make business conclusions from columns whose meaning is uncertain.
- Do not delete rows as "bad" without listing the rule and affected count.
- Do not hide formula errors, stale formulas, or chart ranges that no longer
  match the data.
- Do not mix currencies, units, or date granularities without normalizing or
  flagging the issue.
- Do not claim exhaustive anomaly detection; state the checks actually run.

## Coordination

- Start from `lily-office-intent` for mixed Office tasks such as "PDF report to
  Excel analysis" or "spreadsheet summary to PPT".
- Use `lily-pdf-extraction-router` before analyzing tables from complex PDFs.
- Use `document-verify` when the final deliverable is an Excel workbook whose
  visual layout, charts, printed pages, or exported PDF must look right.
- Use `runtime-packs` only if LibreOffice conversion/recalculation is missing or
  the source PDF extraction requires a heavier PDF engine.
