"use strict";

const { hasScheduledTaskNegation } = require("./schedule-parser");

function looksLikeScheduleContentDescription(text) {
  const source = String(text || "").trim();
  if (!source) return false;
  const hasScheduleWord =
    /(逐小时|每(?:个)?小时|每小时|每(?:个)?整点|每天|每日|每周|每月|\bhourly\b|\bdaily\b|\bweekly\b)/i.test(source);
  const hasContentWord =
    /(预报|预测|报表|图表|趋势|走势|页面|功能|方案|知识方案|文档|说明|字段|数据|列表|展示|显示|刷新频率|接口|模块|组件|策略|规则|能力)/.test(source);
  const hasCreationWord =
    /(提醒我|创建|建立|新增|设置|安排|配置|生成|开启|启用|定时|自动执行|计划任务|到点|\bschedule\b|\bremind me\b)/i.test(source);
  return hasScheduleWord && hasContentWord && !hasCreationWord;
}

function looksLikeScheduledTaskIntent(text, files = []) {
  if (Array.isArray(files) && files.length > 0) return false;
  const source = String(text || "").trim();
  if (!source || source.length > 1200) return false;
  if (hasScheduledTaskNegation(source)) return false;
  if (looksLikeScheduleContentDescription(source)) return false;

  // Unambiguous "create a scheduled task" phrasing — enough on its own.
  const explicitChineseAction =
    /(定时任务|计划任务|自动执行|创建\s*(?:定时|自动|计划|提醒|任务)|建立\s*(?:定时|自动|计划|提醒|任务)|新增\s*(?:定时|自动|计划|提醒|任务)|设置\s*(?:定时|自动|计划|提醒|任务)|安排\s*(?:定时|自动|计划|提醒|任务)|配置\s*(?:定时|自动|计划|提醒|任务))/;
  // WEAK triggers: a bare keyword that also occurs constantly in ordinary
  // questions ("schedule 这个词怎么用", "daily 构建流程坏了", "提醒我一下 CST
  // 是什么意思"). Each false positive cost a blocking parseDraftSmart() model
  // call before the real answer, so these now require a CLOCK TIME or an
  // explicit interval — something a schedule could actually be built from.
  // Without one, parseDraftSmart could not have produced a schedule anyway.
  const weakTrigger = /(提醒我|到点|定时|\bschedule[sd]?\b|\bremind me\b|\bdaily\b|\bweekly\b|\bmonthly\b|\bhourly\b)/i;
  const concreteTime =
    /([0-9０-９]{1,2}\s*[:：]\s*[0-9０-９]{2}|[0-9０-９]{1,2}\s*点|每(?:个)?整点|每隔\s*[0-9０-９]+|\bevery\s+[0-9]+\s*(?:minutes?|hours?|days?)\b|\b(?:at|by)\s+[0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?\b|\b[0-9]{1,2}\s*(?:am|pm)\b|周[一二三四五六日天]|\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b)/i;
  const chineseSchedule =
    /(每(?:天|日|周|星期|月|隔|小时|个整点)|工作日|周[一二三四五六日天](?:到|至|-|~|～)周[一二三四五六日天]|上午.+到.+每(?:个)?整点|早上.+到.+每(?:个)?整点|下午.+到.+每(?:个)?整点|晚上.+到.+每(?:个)?整点)/;
  const chineseTaskVerb =
    /(提醒|检查|巡检|汇报|发送|总结|整理|同步|抓取|运行|执行|生成|更新|通知|叫我)/;
  const explicitEnglish =
    /\b(every day|every\s+\d+\s+(minutes?|hours?|days?)|every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i;
  const explicitArabic =
    /(ذكّرني|جدول|مجدول|كل\s+(يوم|أسبوع|شهر|ساعة)|كل\s*[0-9٠-٩]+\s*(دقيقة|ساعة|يوم))/i;

  return explicitChineseAction.test(source)
    || (chineseSchedule.test(source) && chineseTaskVerb.test(source))
    || (weakTrigger.test(source) && concreteTime.test(source))
    || explicitEnglish.test(source)
    || explicitArabic.test(source);
}

module.exports = {
  hasScheduledTaskNegation,
  looksLikeScheduledTaskIntent,
};
