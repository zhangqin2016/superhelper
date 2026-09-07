"use strict";

const copy = {
  "zh-CN": "验证执行：测试、构建或检查须在交付文件修改完成后，独立调用工具运行当前项目的最终验收命令（如 node test-summary.cjs）；不得拼接 echo、重定向、|| true 或其他命令。使用工具的真实退出码，不依赖自印 PASS。交付内容再修改须复验；勿为凑证据重复已完成的写操作。如实说明未知、失败或未执行的验证；文件存在不代表质量验收通过。",
  en: "Verification execution: when tests, builds or checks are needed, finish all deliverable edits first, then run the appropriate final check in its own tool call (for example node test-summary.cjs). Do not concatenate echo, redirects, || true or other commands. Use the actual tool exit code, not self-printed PASS text. Revalidate after later deliverable edits; never repeat completed writes just to obtain evidence. Disclose unknown, failed or unexecuted checks; file existence is not semantic acceptance.",
  ar: "اختبار/بناء/فحص: أكمل تعديلات التسليم ثم شغّل فحص المشروع النهائي بأداة مستقلة (مثل node test-summary.cjs)؛ بلا echo أو إعادة توجيه أو || true أو أمر آخر. اعتمد رمز خروج الأداة لا PASS مطبوعاً. أعد الفحص بعد التعديل؛ لا تكرر الكتابة المكتملة لجمع دليل. اذكر المجهول والفشل وغير المنفذ؛ وجود الملف لا يثبت الجودة.",
};

module.exports = { verificationExecutionGuidance: locale => copy[locale] || copy.en };
