"use strict";

function looksLikeScheduledTaskIntent(text, files = []) {
  if (Array.isArray(files) && files.length > 0) return false;
  const source = String(text || "").trim();
  if (!source || source.length > 1200) return false;

  const explicitChinese =
    /(定时|自动执行|计划任务|提醒我|到点|每(?:天|日|周|星期|月|隔|小时|个整点)|工作日|周[一二三四五六日天](?:到|至|-|~|～)周[一二三四五六日天]|上午.+到.+每(?:个)?整点|早上.+到.+每(?:个)?整点|下午.+到.+每(?:个)?整点|晚上.+到.+每(?:个)?整点)/;
  const explicitEnglish =
    /\b(schedule|scheduled|remind me|every day|daily|weekly|monthly|hourly|every\s+\d+\s+(minutes?|hours?|days?)|every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i;
  const explicitArabic =
    /(ذكّرني|جدول|مجدول|كل\s+(يوم|أسبوع|شهر|ساعة)|كل\s*[0-9٠-٩]+\s*(دقيقة|ساعة|يوم))/i;

  return explicitChinese.test(source) || explicitEnglish.test(source) || explicitArabic.test(source);
}

module.exports = { looksLikeScheduledTaskIntent };
