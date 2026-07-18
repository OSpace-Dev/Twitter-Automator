(function initSidePanel() {
  let preferredTabId = 0;
  let autoRefreshTimerId = 0;
  const AUTO_REFRESH_DELAY_MS = 1200;

  const elements = {
    stateBadge: document.getElementById("stateBadge"),
    collectionTip: document.getElementById("collectionTip"),
    usernameInput: document.getElementById("usernameInput"),
    sinceTimeInput: document.getElementById("sinceTimeInput"),
    maxTweetsInput: document.getElementById("maxTweetsInput"),
    startButton: document.getElementById("startButton"),
    stopButton: document.getElementById("stopButton"),
    testReloadButton: document.getElementById("testReloadButton"),
    refreshButton: document.getElementById("refreshButton"),
    clearButton: document.getElementById("clearButton"),
    refreshBridgeButton: document.getElementById("refreshBridgeButton"),
    refreshLogsButton: document.getElementById("refreshLogsButton"),
    clearLogsButton: document.getElementById("clearLogsButton"),
    pageLabel: document.getElementById("pageLabel"),
    captureCount: document.getElementById("captureCount"),
    tweetCount: document.getElementById("tweetCount"),
    stopReason: document.getElementById("stopReason"),
    scrollCount: document.getElementById("scrollCount"),
    idleScrollCount: document.getElementById("idleScrollCount"),
    lastCaptureSource: document.getElementById("lastCaptureSource"),
    lastCaptureAt: document.getElementById("lastCaptureAt"),
    lastHookDebugEvent: document.getElementById("lastHookDebugEvent"),
    lastHookDebugAt: document.getElementById("lastHookDebugAt"),
    resultModeBanner: document.getElementById("resultModeBanner"),
    summarySinceTime: document.getElementById("summarySinceTime"),
    summaryMaxTweets: document.getElementById("summaryMaxTweets"),
    tweetList: document.getElementById("tweetList"),
    tweetListHint: document.getElementById("tweetListHint"),
    resultOutput: document.getElementById("resultOutput"),
    bridgePhase: document.getElementById("bridgePhase"),
    pendingJobId: document.getElementById("pendingJobId"),
    pendingUsername: document.getElementById("pendingUsername"),
    pendingTabId: document.getElementById("pendingTabId"),
    pendingTargetUrl: document.getElementById("pendingTargetUrl"),
    serverOrigin: document.getElementById("serverOrigin"),
    bridgeLogsOutput: document.getElementById("bridgeLogsOutput")
  };

  elements.startButton.addEventListener("click", function onStart() {
    sendToActiveTab("TWITTER_TIMELINE_START", { options: getOptions() });
  });

  elements.stopButton.addEventListener("click", function onStop() {
    sendToPreferredTab("TWITTER_TIMELINE_STOP");
  });

  elements.clearButton.addEventListener("click", function onClear() {
    sendToPreferredTab("TWITTER_TIMELINE_CLEAR");
  });

  elements.testReloadButton.addEventListener("click", function onTestReload() {
    triggerReloadAndCollect();
  });

  elements.refreshButton.addEventListener("click", function onRefresh() {
    refreshAll();
  });

  elements.refreshBridgeButton.addEventListener("click", function onRefreshBridge() {
    refreshBridgeState(true);
  });

  elements.refreshLogsButton.addEventListener("click", function onRefreshLogs() {
    refreshBridgeState(true);
  });

  elements.clearLogsButton.addEventListener("click", function onClearLogs() {
    chrome.runtime.sendMessage({ type: "TWITTER_TIMELINE_PANEL_CLEAR_LOGS" }, function onResponse(response) {
      if (chrome.runtime.lastError) {
        renderBridgeError(chrome.runtime.lastError.message);
        return;
      }

      if (!response || !response.ok) {
        renderBridgeError(response && response.error || "clear_logs_failed");
        return;
      }

      elements.bridgeLogsOutput.value = "";
      refreshBridgeState(true);
    });
  });

  refreshAll();

  function refreshAll() {
    refreshBridgeState(true);
  }

  function getOptions() {
    return {
      username: elements.usernameInput.value.trim(),
      sinceTime: toIsoDate(elements.sinceTimeInput.value),
      maxTweets: Number(elements.maxTweetsInput.value)
    };
  }

  function sendToActiveTab(type, payload) {
    chrome.tabs.query({ active: true, currentWindow: true }, function onTabs(tabs) {
      const tab = tabs && tabs[0];
      if (!tab || !tab.id) {
        renderError("没有可用标签页");
        return;
      }

      preferredTabId = tab.id;
      sendMessageToTab(tab.id, type, payload);
    });
  }

  function sendToPreferredTab(type, payload) {
    resolvePreferredTabId(function onResolved(tabId) {
      if (!tabId) {
        renderError("没有可用标签页");
        return;
      }

      sendMessageToTab(tabId, type, payload);
    });
  }

  function sendMessageToTab(tabId, type, payload) {
    chrome.tabs.sendMessage(tabId, Object.assign({ type }, payload || {}), function onResponse(response) {
      if (chrome.runtime.lastError) {
        if (isRefreshingWindowError(chrome.runtime.lastError.message)) {
          renderRefreshingState(chrome.runtime.lastError.message);
          return;
        }

        renderError(chrome.runtime.lastError.message);
        return;
      }

      renderStatus(response);
    });
  }

  function resolvePreferredTabId(callback) {
    if (preferredTabId) {
      callback(preferredTabId);
      return;
    }

    chrome.tabs.query({ active: true, currentWindow: true }, function onTabs(tabs) {
      const tab = tabs && tabs[0];
      callback(tab && tab.id || 0);
    });
  }

  function triggerReloadAndCollect() {
    chrome.tabs.query({ active: true, currentWindow: true }, function onTabs(tabs) {
      const tab = tabs && tabs[0];
      if (!tab || !tab.id) {
        renderError("没有可用标签页");
        return;
      }

      preferredTabId = tab.id;
      chrome.runtime.sendMessage({
        type: "TWITTER_TIMELINE_PANEL_TEST_RELOAD",
        payload: {
          tabId: tab.id,
          options: getOptions()
        }
      }, function onResponse(response) {
        if (chrome.runtime.lastError) {
          renderBridgeError(chrome.runtime.lastError.message);
          return;
        }

        if (!response || !response.ok) {
          renderBridgeError(response && response.error || "test_reload_failed");
          return;
        }

        renderRefreshingState("test_reload_requested");
        refreshBridgeState(true);
      });
    });
  }

  function refreshBridgeState(shouldRefreshStatus) {
    chrome.runtime.sendMessage({ type: "TWITTER_TIMELINE_GET_BRIDGE_STATE" }, function onResponse(response) {
      if (chrome.runtime.lastError) {
        renderBridgeError(chrome.runtime.lastError.message);
        scheduleAutoRefresh();
        return;
      }

      if (!response || !response.ok) {
        renderBridgeError(response && response.error || "bridge_state_unavailable");
        scheduleAutoRefresh();
        return;
      }

      applyBridgeState(response);
      if (shouldRefreshStatus) {
        sendToPreferredTab("TWITTER_TIMELINE_GET_STATUS");
      }
    });
  }

  function applyBridgeState(response) {
    const pendingCollection = response.pendingCollection || null;
    const panelState = response.panelState || {};
    const panelLogs = Array.isArray(response.panelLogs) ? response.panelLogs : [];
    const bridgeConfig = response.bridgeConfig || {};

    preferredTabId = panelState.activeTabId
      || pendingCollection && pendingCollection.tabId
      || preferredTabId
      || 0;

    elements.bridgePhase.textContent = formatBridgePhase(panelState.phase || "");
    elements.pendingJobId.textContent = pendingCollection && pendingCollection.job && pendingCollection.job.jobId || "-";
    elements.pendingUsername.textContent = pendingCollection && pendingCollection.job && pendingCollection.job.username || "-";
    elements.pendingTabId.textContent = pendingCollection && pendingCollection.tabId ? String(pendingCollection.tabId) : preferredTabId ? String(preferredTabId) : "-";
    elements.pendingTargetUrl.textContent = pendingCollection && pendingCollection.targetUrl || panelState.targetUrl || "-";
    elements.serverOrigin.textContent = bridgeConfig.serverOrigin || "-";
    elements.bridgeLogsOutput.value = panelLogs.map(formatLogLine).join("\n");

    if (bridgeSuggestsPolling(panelState.phase)) {
      scheduleAutoRefresh();
    }
  }

  function renderStatus(status) {
    if (!status || !status.ok) {
      renderError("当前页面没有响应");
      return;
    }

    const collection = status.collection || null;
    const tweets = Array.isArray(status.tweets) ? status.tweets : [];
    const running = Boolean(collection && collection.running);

    elements.stateBadge.textContent = running ? "抓取中" : "已就绪";
    elements.stateBadge.dataset.kind = running ? "running" : "idle";
    elements.pageLabel.textContent = status.isAccountPage ? "@" + (status.activeUsername || "-") : "非账号页";
    elements.captureCount.textContent = String(status.captureCount || 0);
    elements.tweetCount.textContent = String(tweets.length);
    elements.stopReason.textContent = formatStopReason(collection && collection.stopReason || "");
    elements.scrollCount.textContent = String(collection && collection.scrollCount || 0);
    elements.idleScrollCount.textContent = String(collection && collection.idleScrollCount || 0);
    elements.lastCaptureSource.textContent = status.lastCaptureSource || "-";
    elements.lastCaptureAt.textContent = formatDisplayTime(status.lastCaptureAt);
    elements.lastHookDebugEvent.textContent = status.lastHookDebugEvent || "-";
    elements.lastHookDebugAt.textContent = formatDisplayTime(status.lastHookDebugAt);
    elements.summarySinceTime.textContent = formatDisplayTime(formatSinceTime(collection && collection.sinceTime || null));
    elements.summaryMaxTweets.textContent = collection && collection.maxTweets ? String(collection.maxTweets) : "-";
    elements.collectionTip.textContent = buildCollectionTip(status, collection);
    elements.resultModeBanner.textContent = buildResultModeText(collection, tweets.length);

    if (!elements.usernameInput.value && status.activeUsername) {
      elements.usernameInput.placeholder = status.activeUsername;
    }

    renderTweetList(tweets);

    elements.resultOutput.value = JSON.stringify({
      summary: {
        pageUrl: status.pageUrl || null,
        activeUsername: status.activeUsername || null,
        captureCount: status.captureCount || 0,
        tweetCount: tweets.length,
        stopReason: collection && collection.stopReason || null,
        scrollCount: collection && collection.scrollCount || 0,
        idleScrollCount: collection && collection.idleScrollCount || 0,
        lastCaptureSource: status.lastCaptureSource || null,
        lastCaptureAt: status.lastCaptureAt || null,
        lastHookDebugEvent: status.lastHookDebugEvent || null,
        lastHookDebugAt: status.lastHookDebugAt || null,
        sinceTime: formatSinceTime(collection && collection.sinceTime || null),
        maxTweets: collection && collection.maxTweets || null,
        resultMode: buildResultModeText(collection, tweets.length)
      },
      hookDebug: status.hookDebug || [],
      tweets,
      errors: status.errors || []
    }, null, 2);

    if (running) {
      scheduleAutoRefresh();
      return;
    }

    clearAutoRefresh();
  }

  function renderError(message) {
    elements.stateBadge.textContent = "不可用";
    elements.stateBadge.dataset.kind = "error";
    elements.pageLabel.textContent = "-";
    elements.captureCount.textContent = "0";
    elements.tweetCount.textContent = "0";
    elements.stopReason.textContent = "-";
    elements.scrollCount.textContent = "0";
    elements.idleScrollCount.textContent = "0";
    elements.lastCaptureSource.textContent = "-";
    elements.lastCaptureAt.textContent = "-";
    elements.lastHookDebugEvent.textContent = "-";
    elements.lastHookDebugAt.textContent = "-";
    elements.summarySinceTime.textContent = "-";
    elements.summaryMaxTweets.textContent = "-";
    elements.collectionTip.textContent = "请确认当前标签页已打开 X 账号页，并允许插件访问该页面。";
    elements.resultModeBanner.textContent = "当前还没有可展示的最终结果集。";
    renderTweetList([]);
    elements.resultOutput.value = message || "未知错误";
  }

  function renderRefreshingState(message) {
    elements.stateBadge.textContent = "刷新中";
    elements.stateBadge.dataset.kind = "running";
    elements.collectionTip.textContent = "测试抓取正在等待页面刷新和 content script 重新挂载。";
    elements.resultModeBanner.textContent = "页面刷新完成后，会自动开始一次新的抓取。";
    elements.resultOutput.value = JSON.stringify({
      info: "页面正在刷新，content script 还在重新挂载。",
      detail: message || null
    }, null, 2);
    scheduleAutoRefresh();
  }

  function renderBridgeError(message) {
    elements.bridgePhase.textContent = "error";
    elements.bridgeLogsOutput.value = message || "后台状态读取失败";
  }

  function renderTweetList(tweets) {
    const list = Array.isArray(tweets) ? tweets : [];
    elements.tweetListHint.textContent = list.length
      ? `共展示 ${list.length} 条符合条件的推文`
      : "当前没有符合条件的推文";

    if (!list.length) {
      elements.tweetList.className = "tweet-list empty";
      elements.tweetList.textContent = "当前还没有推文结果";
      return;
    }

    elements.tweetList.className = "tweet-list";
    elements.tweetList.innerHTML = list.map(renderTweetCard).join("");
  }

  function renderTweetCard(tweet) {
    const metrics = tweet && tweet.metrics || {};
    const previewText = tweet && tweet.text || "";
    const badge = tweet && tweet.isPinned ? '<span class="tweet-card-badge">Pinned</span>' : "";
    const source = escapeHtml(tweet && tweet.textSource || "-");
    const url = escapeHtml(tweet && tweet.url || "");

    return [
      '<article class="tweet-card">',
      '<div class="tweet-card-header">',
      '<div class="tweet-card-header-main">',
      `<span class="tweet-card-title">@${escapeHtml(tweet && tweet.authorUsername || "-")}</span>`,
      badge,
      "</div>",
      url ? `<a class="tweet-card-link" href="${url}" target="_blank" rel="noreferrer">打开推文</a>` : "",
      "</div>",
      '<div class="tweet-card-meta">',
      `<span class="tweet-card-time">${escapeHtml(formatDisplayTime(tweet && tweet.createdAt || null))}</span>`,
      `<span class="tweet-card-source">${source}</span>`,
      `<span class="tweet-card-source">ID ${escapeHtml(tweet && tweet.id || "-")}</span>`,
      "</div>",
      `<div class="tweet-card-text">${escapeHtml(previewText || "(空文本)")}</div>`,
      '<div class="tweet-card-stats">',
      `<span>点赞 ${safeNumber(metrics.likes)}</span>`,
      `<span>转推 ${safeNumber(metrics.reposts)}</span>`,
      `<span>回复 ${safeNumber(metrics.replies)}</span>`,
      `<span>浏览 ${safeNumber(metrics.views)}</span>`,
      "</div>",
      "</article>"
    ].join("");
  }

  function isRefreshingWindowError(message) {
    const text = String(message || "");
    return text.includes("Receiving end does not exist")
      || text.includes("Could not establish connection");
  }

  function scheduleAutoRefresh() {
    if (autoRefreshTimerId) {
      return;
    }

    autoRefreshTimerId = window.setTimeout(function onAutoRefresh() {
      autoRefreshTimerId = 0;
      refreshBridgeState(true);
    }, AUTO_REFRESH_DELAY_MS);
  }

  function clearAutoRefresh() {
    if (!autoRefreshTimerId) {
      return;
    }

    window.clearTimeout(autoRefreshTimerId);
    autoRefreshTimerId = 0;
  }

  function formatLogLine(logItem) {
    return `[${logItem.time || "-"}] ${logItem.level || "INFO"} ${logItem.event || "event"} ${JSON.stringify(logItem.payload || {})}`;
  }

  function toIsoDate(value) {
    if (!value) {
      return "";
    }

    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? "" : new Date(timestamp).toISOString();
  }

  function formatSinceTime(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return new Date(value).toISOString();
    }

    if (typeof value === "string") {
      const timestamp = Date.parse(value);
      return Number.isNaN(timestamp) ? value : new Date(timestamp).toISOString();
    }

    return String(value);
  }

  function formatDisplayTime(value) {
    if (!value) {
      return "-";
    }

    const timestamp = Date.parse(String(value));
    if (Number.isNaN(timestamp)) {
      return String(value);
    }

    return new Date(timestamp).toISOString();
  }

  function safeNumber(value) {
    return Number.isFinite(Number(value)) ? String(value) : "0";
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function buildCollectionTip(status, collection) {
    if (!status.isAccountPage) {
      return "当前不是 X 账号主页，建议先打开目标账号页再发起抓取。";
    }

    if (collection && collection.running) {
      return "正在自动滚动当前页面并持续刷新结果列表，你可以直接观察结果是否增长。";
    }

    if (collection && collection.stopReason === "time_threshold") {
      return "已滚动到起始时间之前，结果列表只保留符合当前时间条件的最终结果集。";
    }

    if (collection && collection.stopReason === "max_tweets") {
      return "已达到结果上限，结果列表只保留当前条件下的最终结果集。";
    }

    if (collection && !collection.sinceTime) {
      return "当前未填写起始时间，将展示本次抓取到的全部结果，直到命中结果上限或滚动停止条件。";
    }

    return "点击“测试抓取”可刷新当前页面并重新执行一次完整抓取。";
  }

  function buildResultModeText(collection, tweetCount) {
    if (!collection) {
      return "结果列表会按当前条件展示最终结果集。";
    }

    if (!collection.sinceTime) {
      return `当前未设置起始时间，展示本次抓取的最终结果集，共 ${tweetCount} 条。`;
    }

    return `当前按 sinceTime 和 maxTweets 展示最终结果集，共 ${tweetCount} 条。`;
  }

  function formatStopReason(value) {
    const reason = String(value || "");
    if (!reason) {
      return "-";
    }

    const labels = {
      max_tweets: "达到结果上限",
      time_threshold: "达到起始时间阈值",
      scroll_safety_cap: "达到滚动安全上限",
      idle_scrolls: "连续滚动无新结果",
      manual_stop: "手动停止",
      manual_clear: "手动清空",
      page_changed: "页面已切换"
    };

    return labels[reason] || reason;
  }

  function bridgeSuggestsPolling(phase) {
    return [
      "dispatch_pending",
      "tab_reloading",
      "waiting_content_ready",
      "starting_collection",
      "collecting"
    ].includes(String(phase || ""));
  }

  function formatBridgePhase(value) {
    const phase = String(value || "");
    const labels = {
      bridge_ready: "桥接已就绪",
      dispatch_pending: "任务待派发启动",
      tab_opened: "目标页已打开",
      tab_reloading: "目标页刷新中",
      waiting_content_ready: "等待页面脚本就绪",
      starting_collection: "准备开始采集",
      collecting: "采集中",
      completed: "采集完成",
      failed: "采集失败"
    };

    return labels[phase] || phase || "-";
  }
})();
