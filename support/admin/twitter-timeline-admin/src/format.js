export function getShanghaiDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
}

export function formatTime(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Shanghai"
  }).format(new Date(value));
}

export function statusLabel(status) {
  return ({
    queued: "排队中",
    dispatched: "已下发",
    collecting: "采集中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消"
  })[status] || status;
}

export function triggerLabel(triggerType) {
  return triggerType === "scheduled" ? "每日自动" : "手动";
}

export function stopReasonLabel(value) {
  return ({
    time_threshold: "到达增量时间边界",
    max_tweets: "达到最大推文数",
    scroll_safety_cap: "触发滚动安全上限",
    idle_scrolls: "连续空滚动后结束",
    dispatch_timeout: "扩展执行超时",
    extension_disconnected: "扩展连接中断",
    target_tab_unavailable: "目标标签页不可用",
    target_tab_closed: "目标标签页已关闭"
  })[value] || value || "-";
}
