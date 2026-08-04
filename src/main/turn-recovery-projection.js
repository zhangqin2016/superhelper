"use strict";

const DISPATCH_OUTCOME_UNKNOWN_ASSISTANT = "本次回复的持久化结果无法确认（可能已完成，也可能未送达）。为避免重复执行，系统不会自动重试，请核对后手动重发。";
const DISPATCH_BLOCKED_ASSISTANT = "消息未能送达助手引擎，本次没有执行。可以安全重试。";

module.exports = { DISPATCH_OUTCOME_UNKNOWN_ASSISTANT, DISPATCH_BLOCKED_ASSISTANT };
