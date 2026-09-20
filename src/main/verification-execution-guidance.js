"use strict";

const copy = {
  "zh-CN": "验证执行：测试、构建或检查须在交付文件修改完成后，独立调用工具运行当前项目的最终验收命令（如 node test-summary.cjs）；不得拼接 echo、重定向、|| true 或其他命令。使用工具的真实退出码，不依赖自印 PASS。交付内容再修改须复验；勿为凑证据重复已完成的写操作。如实说明未知、失败或未执行的验证；文件存在不代表质量验收通过。",
  en: "Verification execution: when tests, builds or checks are needed, finish all deliverable edits first, then run the appropriate final check in its own tool call (for example node test-summary.cjs). Do not concatenate echo, redirects, || true or other commands. Use the actual tool exit code, not self-printed PASS text. Revalidate after later deliverable edits; never repeat completed writes just to obtain evidence. Disclose unknown, failed or unexecuted checks; file existence is not semantic acceptance.",
  ar: "اختبار/بناء/فحص: أكمل تعديلات التسليم ثم شغّل فحص المشروع النهائي بأداة مستقلة (مثل node test-summary.cjs)؛ بلا echo أو إعادة توجيه أو || true أو أمر آخر. اعتمد رمز خروج الأداة لا PASS مطبوعاً. أعد الفحص بعد التعديل؛ لا تكرر الكتابة المكتملة لجمع دليل. اذكر المجهول والفشل وغير المنفذ؛ وجود الملف لا يثبت الجودة.",
};

const acceptance = {
  "zh-CN": "验收证据：开始前保留原始验收条件，不能为了通过而降低标准或事后改评分。每项结论记录对应产物、实际检查、证据位置和通过/失败/未验证状态。来源权威性与抓取完整度分开记录；抓到全文不等于一手来源，转载和搜索摘要不能冒充原始证据。未复核数据影响的结论必须同步标注，不得在总结中声称未使用。跨产物数值检查按实体、指标、时期、单位、数值逐项对齐，精度/容差须有依据；禁止用任意数字子串或四舍五入候选命中替代一致性。网页检查实际渲染结果，不能以源码里存在常量代替可见结果。视觉检查记录实际查看的页码与总页数；渲染过不等于查看过，抽查不能宣称逐页验收。仅文件存在、脚本自印 PASS 或零退出码，都不能单独证明全部质量条件满足。",
  en: "Acceptance evidence: preserve the original acceptance criteria before execution; do not weaken checks or change scoring to obtain a pass. Tie each verdict to an artifact, performed check, evidence location and passed/failed/unverified status. Track source authority separately from retrieval completeness: full text is not proof of a primary source, and reposts/search snippets are not original evidence. Label conclusions that depend on unverified data rather than claiming such data was unused. Compare cross-artifact values by entity, metric, period, unit and value with justified precision/tolerance, never arbitrary digit substrings or rounded candidate matches. Inspect rendered web content, not merely constants in source code. Record inspected page numbers and total pages: rendering is not inspection and sampling is not an all-page audit. Existence, self-printed PASS or exit zero alone cannot prove all quality criteria.",
  ar: "احفظ شروط القبول الأصلية ولا تخففها للحصول على نجاح. اربط كل حكم بملف وفحص ودليل وحالة نجاح أو فشل أو عدم تحقق. افصل موثوقية المصدر عن اكتمال جلبه؛ النص الكامل ليس دليلاً على أنه مصدر أولي. اذكر أثر البيانات غير المتحققة على النتائج. قارن الكيان والمؤشر والفترة والوحدة والقيمة بدقة مبررة، لا بمجرد تطابق أرقام داخل نص. افحص المحتوى المعروض لا ثوابت الشفرة. سجل الصفحات التي فحصتها فعلياً وإجمالي الصفحات؛ توليد الصور ليس فحصاً وأخذ عينة ليس فحص كل الصفحات. وجود الملف أو PASS أو رمز خروج صفر وحده لا يثبت الجودة.",
};

module.exports = { verificationExecutionGuidance: locale =>
  `${copy[locale] || copy.en}\n${acceptance[locale] || acceptance.en}` };
