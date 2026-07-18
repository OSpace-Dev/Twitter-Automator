(function initTwitterTimelineContent() {
  const parser = globalThis.TwitterTimelineParser;
  const MAX_CAPTURE_HISTORY = 100;
  const MAX_ERROR_HISTORY = 50;
  const INTERNAL_SCROLL_SAFETY_CAP = 200;
  const state = {
    tweetsById: new Map(),
    captures: [],
    errors: [],
    hookDebug: [],
    collection: null,
    injected: false,
    pageKey: getPageKey(),
    scrollTimerId: null,
    runId: 0
  };

  injectPageHook();
  announceContentReady();

  window.addEventListener("message", function onWindowMessage(event) {
    if (event.source !== window || !event.data) {
      return;
    }

    if (event.data.type !== "TWITTER_TIMELINE_USER_TWEETS") {
      if (event.data.type === "TWITTER_TIMELINE_HOOK_DEBUG") {
        handleHookDebugEvent(event.data);
      }
      return;
    }

    handleUserTweetsPayload(event.data);
  });

  chrome.runtime.onMessage.addListener(function onRuntimeMessage(message, _sender, sendResponse) {
    if (!message || !message.type) {
      return false;
    }

    if (message.type === "TWITTER_TIMELINE_GET_STATUS") {
      sendResponse(buildStatus());
      return false;
    }

    if (message.type === "TWITTER_TIMELINE_START") {
      startCollection(message.options || {});
      sendResponse(buildStatus());
      return false;
    }

    if (message.type === "TWITTER_TIMELINE_STOP") {
      stopCollection("manual_stop");
      sendResponse(buildStatus());
      return false;
    }

    if (message.type === "TWITTER_TIMELINE_CLEAR") {
      stopCollection("manual_clear");
      resetData();
      state.collection = null;
      sendResponse(buildStatus());
      return false;
    }

    return false;
  });

  function announceContentReady() {
    chrome.runtime.sendMessage({
      type: "TWITTER_TIMELINE_CONTENT_READY",
      pageUrl: location.href
    }).catch(function ignoreReadyError() {});
  }

  function injectPageHook() {
    if (state.injected) {
      return;
    }

    if (!document.documentElement && !document.head) {
      document.addEventListener("readystatechange", injectPageHook, { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("page-hook.js");
    script.async = false;
    script.onload = function onLoad() {
      script.remove();
    };
    (document.documentElement || document.head).appendChild(script);
    state.injected = true;
  }

  function handleUserTweetsPayload(data) {
    syncPageContext();
    const username = getActiveUsername();
    pushBounded(state.captures, {
      url: data.url,
      source: data.source,
      capturedAt: data.capturedAt,
      username
    }, MAX_CAPTURE_HISTORY);
    if (state.collection) {
      state.collection.lastCaptureAt = data.capturedAt || new Date().toISOString();
    }

    try {
      const tweets = parser.parseTimelinePayload(data.payload, { username });
      mergeTweets(tweets);
      evaluateCollectionStop();
    } catch (error) {
      pushBounded(state.errors, {
        message: error && error.message || String(error),
        at: new Date().toISOString()
      }, MAX_ERROR_HISTORY);
    }
  }

  function handleHookDebugEvent(data) {
    pushBounded(state.hookDebug, {
      event: data.event || "unknown",
      detail: data.detail || null,
      capturedAt: data.capturedAt || new Date().toISOString()
    }, 30);
  }

  function startCollection(options) {
    syncPageContext();
    resetData();
    clearScrollTimer();

    const currentUsername = normalizeUsername(parser.extractUsernameFromUrl(location.href));
    const explicitUsername = normalizeUsername(options.username);
    const username = currentUsername || explicitUsername;
    const sinceTime = options.sinceTime ? Date.parse(options.sinceTime) : NaN;
    state.runId += 1;

    state.collection = {
      jobId: options.jobId || "",
      username,
      usernameSource: currentUsername ? "page_url" : explicitUsername ? "explicit_input" : "unknown",
      inputUsername: explicitUsername,
      autoReport: Boolean(options.autoReport),
      sinceTime: Number.isNaN(sinceTime) ? null : sinceTime,
      maxTweets: clampNumber(options.maxTweets, 1, 500, 100),
      safetyScrollCap: INTERNAL_SCROLL_SAFETY_CAP,
      scrollDelayMs: clampNumber(options.scrollDelayMs, 1000, 8000, 5000),
      idleScrollLimit: clampNumber(options.idleScrollLimit, 2, 20, 10),
      scrollCount: 0,
      idleScrollCount: 0,
      lastScrollDebug: null,
      lastObservedTweetCount: state.tweetsById.size,
      lastCaptureAt: "",
      startedAt: new Date().toISOString(),
      running: true,
      stopReason: "",
      runId: state.runId
    };

    captureDomSnapshot("start");
    reportCollectionProgress();
    scheduleNextScroll(0, state.collection.runId);
  }

  function scheduleNextScroll(delay, runId) {
    const collection = state.collection;
    if (!collection || !collection.running || collection.runId !== runId) {
      return;
    }

    state.scrollTimerId = window.setTimeout(function onScrollTimer() {
      const activeCollection = state.collection;
      if (!activeCollection || !activeCollection.running || activeCollection.runId !== runId) {
        return;
      }

      captureDomSnapshot("scroll_tick");

      const currentCount = state.tweetsById.size;
      if (activeCollection.scrollCount > 0) {
        activeCollection.idleScrollCount = currentCount > activeCollection.lastObservedTweetCount
          ? 0
          : activeCollection.idleScrollCount + 1;
      }
      activeCollection.lastObservedTweetCount = currentCount;

      evaluateCollectionStop();
      if (!activeCollection.running) {
        return;
      }

      performScroll(activeCollection);

      activeCollection.scrollCount += 1;
      reportCollectionProgress();
      if (activeCollection.running) {
        scheduleNextScroll(activeCollection.scrollDelayMs, runId);
      }
    }, delay);
  }

  function evaluateCollectionStop() {
    const collection = state.collection;
    if (!collection || !collection.running) {
      return;
    }

    const tweets = getTweets();
    if (tweets.length >= collection.maxTweets) {
      stopCollection("max_tweets");
      return;
    }

    const oldestTime = getOldestNonPinnedTweetTime(tweets);
    if (collection.sinceTime && oldestTime && oldestTime <= collection.sinceTime) {
      stopCollection("time_threshold");
      return;
    }

    if (collection.scrollCount >= collection.safetyScrollCap) {
      stopCollection("scroll_safety_cap");
      return;
    }

    if (collection.idleScrollCount >= collection.idleScrollLimit) {
      stopCollection("idle_scrolls");
    }
  }

  function stopCollection(reason) {
    if (!state.collection) {
      return;
    }

    state.collection.running = false;
    state.collection.stopReason = reason;
    state.collection.stoppedAt = new Date().toISOString();
    clearScrollTimer();
    reportCollectionProgress();
    reportCollectionDone();
  }

  function mergeTweets(tweets) {
    let newTweetCount = 0;
    for (const tweet of tweets) {
      const existingTweet = state.tweetsById.get(tweet.id);
      if (!existingTweet) {
        newTweetCount += 1;
      }

      state.tweetsById.set(tweet.id, mergeTweetRecord(existingTweet, tweet));
    }

    if (state.collection && newTweetCount > 0) {
      state.collection.idleScrollCount = 0;
      state.collection.lastCaptureAt = new Date().toISOString();
      reportCollectionProgress();
    }

    return newTweetCount;
  }

  function getTweets() {
    return Array.from(state.tweetsById.values()).sort(function sortByTimeDesc(left, right) {
      return Date.parse(right.createdAt) - Date.parse(left.createdAt);
    });
  }

  function mergeTweetRecord(existingTweet, incomingTweet) {
    if (!existingTweet) {
      return cloneTweetRecord(incomingTweet);
    }

    const existingPriority = getTweetSourcePriority(existingTweet.textSource);
    const incomingPriority = getTweetSourcePriority(incomingTweet.textSource);
    const shouldPreferIncomingText = incomingPriority > existingPriority
      || incomingPriority === existingPriority && getTextLength(incomingTweet.text) > getTextLength(existingTweet.text);
    const preferredTextTweet = shouldPreferIncomingText ? incomingTweet : existingTweet;
    const fallbackTextTweet = shouldPreferIncomingText ? existingTweet : incomingTweet;

    return {
      id: existingTweet.id || incomingTweet.id,
      createdAt: pickPreferredString(existingTweet.createdAt, incomingTweet.createdAt),
      createdAtRaw: pickPreferredString(existingTweet.createdAtRaw, incomingTweet.createdAtRaw),
      authorUsername: pickPreferredString(existingTweet.authorUsername, incomingTweet.authorUsername),
      text: pickPreferredString(preferredTextTweet.text, fallbackTextTweet.text),
      url: pickPreferredString(existingTweet.url, incomingTweet.url),
      metrics: mergeTweetMetrics(existingTweet.metrics, incomingTweet.metrics),
      isPinned: Boolean(existingTweet.isPinned || incomingTweet.isPinned),
      textSource: pickPreferredString(preferredTextTweet.textSource, fallbackTextTweet.textSource)
    };
  }

  function cloneTweetRecord(tweet) {
    return {
      id: tweet.id,
      createdAt: tweet.createdAt,
      createdAtRaw: tweet.createdAtRaw,
      authorUsername: tweet.authorUsername,
      text: tweet.text,
      url: tweet.url,
      metrics: mergeTweetMetrics(tweet.metrics),
      isPinned: Boolean(tweet.isPinned),
      textSource: tweet.textSource
    };
  }

  function mergeTweetMetrics(existingMetrics, incomingMetrics) {
    const left = existingMetrics || {};
    const right = incomingMetrics || {};
    return {
      replies: pickPreferredMetric(left.replies, right.replies),
      reposts: pickPreferredMetric(left.reposts, right.reposts),
      quotes: pickPreferredMetric(left.quotes, right.quotes),
      likes: pickPreferredMetric(left.likes, right.likes),
      bookmarks: pickPreferredMetric(left.bookmarks, right.bookmarks),
      views: pickPreferredMetric(left.views, right.views)
    };
  }

  function pickPreferredMetric(left, right) {
    const leftValue = Number(left);
    const rightValue = Number(right);
    const leftValid = Number.isFinite(leftValue);
    const rightValid = Number.isFinite(rightValue);

    if (leftValid && rightValid) {
      return Math.max(leftValue, rightValue);
    }

    if (leftValid) {
      return leftValue;
    }

    if (rightValid) {
      return rightValue;
    }

    return 0;
  }

  function pickPreferredString(primary, fallback) {
    if (typeof primary === "string" && primary.trim()) {
      return primary;
    }

    if (typeof fallback === "string" && fallback.trim()) {
      return fallback;
    }

    return typeof primary === "string" ? primary : typeof fallback === "string" ? fallback : "";
  }

  function getTweetSourcePriority(textSource) {
    const source = String(textSource || "");
    if (source === "note_tweet") {
      return 40;
    }

    if (source.startsWith("retweeted_")) {
      return 30;
    }

    if (source === "legacy_full_text") {
      return 20;
    }

    if (source === "dom_text") {
      return 10;
    }

    return 0;
  }

  function getTextLength(value) {
    return String(value || "").trim().length;
  }

  function getExportTweets() {
    const tweets = getTweets();
    const collection = state.collection;
    if (!collection || !collection.sinceTime) {
      return applyMaxTweetsLimit(tweets, collection && collection.maxTweets || 0);
    }

    return applyMaxTweetsLimit(tweets.filter(function filterBySinceTime(tweet) {
      if (tweet.isPinned) {
        return true;
      }

      const createdAtTime = Date.parse(tweet.createdAt);
      if (!Number.isFinite(createdAtTime)) {
        return true;
      }

      return createdAtTime > collection.sinceTime;
    }), collection.maxTweets);
  }

  function getOldestNonPinnedTweetTime(tweets) {
    const times = tweets
      .filter(function isNotPinned(tweet) {
        return !tweet.isPinned;
      })
      .map(function toTime(tweet) {
        return Date.parse(tweet.createdAt);
      })
      .filter(function isValid(time) {
        return Number.isFinite(time);
      });

    return times.length ? Math.min.apply(Math, times) : null;
  }

  function buildStatus() {
    syncPageContext();
    const lastCapture = state.captures[state.captures.length - 1] || null;
    const lastHookDebug = state.hookDebug[state.hookDebug.length - 1] || null;
    return {
      ok: true,
      pageUrl: location.href,
      activeUsername: getActiveUsername(),
      isAccountPage: Boolean(parser.extractUsernameFromUrl(location.href)),
      captures: state.captures.slice(-10),
      captureCount: state.captures.length,
      lastCaptureSource: lastCapture && lastCapture.source || null,
      lastCaptureAt: lastCapture && lastCapture.capturedAt || null,
      hookDebug: state.hookDebug.slice(-10),
      lastHookDebugEvent: lastHookDebug && lastHookDebug.event || null,
      lastHookDebugAt: lastHookDebug && lastHookDebug.capturedAt || null,
      tweets: getExportTweets(),
      errors: state.errors.slice(-10),
      collection: state.collection
    };
  }

  function performScroll(collection) {
    const scrollTarget = getPreferredScrollTarget();
    const viewportHeight = scrollTarget === window
      ? window.innerHeight || 0
      : scrollTarget.clientHeight || window.innerHeight || 0;
    const topDelta = Math.max(Math.floor(viewportHeight), 1);
    const beforeTop = readScrollTop(scrollTarget);
    const maxTop = getMaxScrollTop(scrollTarget);
    const targetTop = Math.min(maxTop, beforeTop + topDelta);
    const remainingDistance = Math.max(0, maxTop - beforeTop);
    const shouldJumpToBottom = remainingDistance <= topDelta * 0.85;

    if (scrollTarget === window) {
      const nextTop = shouldJumpToBottom ? maxTop : targetTop;
      window.scrollTo({
        top: nextTop,
        left: 0,
        behavior: "auto"
      });
    } else {
      const nextTop = shouldJumpToBottom ? maxTop : targetTop;
      scrollTarget.scrollTo({
        top: nextTop,
        left: 0,
        behavior: "auto"
      });
      window.scrollBy({
        top: Math.max(220, window.innerHeight * 0.35),
        left: 0,
        behavior: "auto"
      });
    }

    const afterTop = readScrollTop(scrollTarget);
    collection.lastScrollDebug = {
      target: describeScrollTarget(scrollTarget),
      beforeTop,
      afterTop,
      delta: afterTop - beforeTop,
      maxTop,
      requestedDelta: topDelta,
      jumpedToBottom: shouldJumpToBottom,
      capturedAt: new Date().toISOString()
    };
  }

  function getPreferredScrollTarget() {
    const main = document.querySelector("main");
    const candidates = [];

    if (main) {
      candidates.push(main);
    }

    candidates.push(document.scrollingElement, document.documentElement, document.body);

    for (const candidate of candidates) {
      if (!candidate || typeof candidate.scrollBy !== "function") {
        continue;
      }

      if (candidate === window) {
        return candidate;
      }

      if (candidate.scrollHeight > candidate.clientHeight + 80) {
        return candidate;
      }
    }

    return window;
  }

  function readScrollTop(target) {
    if (target === window) {
      return window.scrollY || window.pageYOffset || 0;
    }

    return target && typeof target.scrollTop === "number" ? target.scrollTop : 0;
  }

  function getMaxScrollTop(target) {
    if (target === window) {
      const scrollingElement = document.scrollingElement || document.documentElement || document.body;
      if (!scrollingElement) {
        return 0;
      }

      return Math.max(0, (scrollingElement.scrollHeight || 0) - (window.innerHeight || 0));
    }

    if (!target) {
      return 0;
    }

    return Math.max(0, (target.scrollHeight || 0) - (target.clientHeight || 0));
  }

  function describeScrollTarget(target) {
    if (target === window) {
      return "window";
    }

    if (!target) {
      return "unknown";
    }

    const tagName = String(target.tagName || "element").toLowerCase();
    const testId = target.getAttribute && target.getAttribute("data-testid");
    const role = target.getAttribute && target.getAttribute("role");
    return [tagName, testId ? `data-testid=${testId}` : "", role ? `role=${role}` : ""]
      .filter(Boolean)
      .join(" ");
  }

  function reportCollectionProgress() {
    if (!state.collection || !state.collection.autoReport || !state.collection.jobId) {
      return;
    }

    chrome.runtime.sendMessage({
      type: "TWITTER_TIMELINE_COLLECTION_PROGRESS",
      payload: {
        jobId: state.collection.jobId,
        status: getCollectionStatus(state.collection.stopReason, true),
        pageUrl: location.href,
        activeUsername: getActiveUsername(),
        tweetCount: state.tweetsById.size,
        stopReason: state.collection.stopReason || "",
        errors: state.errors.slice(),
        collection: summarizeCollection(state.collection)
      }
    }).catch(function ignoreProgressError() {});
  }

  function reportCollectionDone() {
    if (!state.collection || !state.collection.autoReport || !state.collection.jobId || state.collection.running) {
      return;
    }

    chrome.runtime.sendMessage({
      type: "TWITTER_TIMELINE_COLLECTION_DONE",
      payload: {
        jobId: state.collection.jobId,
        status: getCollectionStatus(state.collection.stopReason, false),
        pageUrl: location.href,
        sourceUrl: location.href,
        activeUsername: getActiveUsername(),
        captureCount: state.captures.length,
        stopReason: state.collection.stopReason || "",
        collection: summarizeCollection(state.collection),
        capturedAt: new Date().toISOString(),
        errors: state.errors.slice(),
        tweets: getExportTweets()
      }
    }).catch(function ignoreDoneError() {});
  }

  function getActiveUsername() {
    return state.collection && state.collection.username
      || parser.extractUsernameFromUrl(location.href);
  }

  function syncPageContext() {
    const currentPageKey = getPageKey();
    if (state.pageKey === currentPageKey) {
      return;
    }

    state.pageKey = currentPageKey;
    stopCollection("page_changed");
    resetData();
    state.collection = null;
  }

  function getPageKey() {
    return location.origin + location.pathname;
  }

  function resetData() {
    state.tweetsById.clear();
    state.captures = [];
    state.errors = [];
    state.hookDebug = [];
  }

  function captureDomSnapshot(source) {
    syncPageContext();

    try {
      const username = getActiveUsername();
      const tweets = parser.parseTweetsFromDom(document, { username });
      if (!tweets.length) {
        return;
      }

      const newTweetCount = mergeTweets(tweets);
      if (!newTweetCount) {
        return;
      }

      pushBounded(state.captures, {
        url: location.href,
        source: `dom:${source}`,
        capturedAt: new Date().toISOString(),
        username
      }, MAX_CAPTURE_HISTORY);
    } catch (error) {
      pushBounded(state.errors, {
        message: error && error.message || String(error),
        at: new Date().toISOString()
      }, MAX_ERROR_HISTORY);
    }
  }

  function clearScrollTimer() {
    if (!state.scrollTimerId) {
      return;
    }

    window.clearTimeout(state.scrollTimerId);
    state.scrollTimerId = null;
  }

  function summarizeCollection(collection) {
    return {
      jobId: collection.jobId,
      username: collection.username,
      sinceTime: collection.sinceTime ? new Date(collection.sinceTime).toISOString() : null,
      maxTweets: collection.maxTweets,
      safetyScrollCap: collection.safetyScrollCap,
      scrollCount: collection.scrollCount,
      idleScrollCount: collection.idleScrollCount,
      lastScrollDebug: collection.lastScrollDebug || null,
      startedAt: collection.startedAt,
      stoppedAt: collection.stoppedAt || null,
      stopReason: collection.stopReason || "",
      running: collection.running
    };
  }

  function getCollectionStatus(stopReason, isRunning) {
    if (isRunning) {
      return "collecting";
    }

    if (
      stopReason === "time_threshold"
      || stopReason === "max_tweets"
      || stopReason === "scroll_safety_cap"
      || stopReason === "idle_scrolls"
    ) {
      return "completed";
    }

    if (stopReason === "manual_stop" || stopReason === "manual_clear") {
      return "cancelled";
    }

    return "failed";
  }

  function normalizeUsername(username) {
    return String(username || "").replace(/^@/, "").trim();
  }

  function pushBounded(items, value, limit) {
    items.push(value);
    if (items.length > limit) {
      items.splice(0, items.length - limit);
    }
  }

  function clampNumber(value, min, max, fallback) {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) {
      return fallback;
    }

    return Math.min(max, Math.max(min, Math.floor(numberValue)));
  }

  function applyMaxTweetsLimit(tweets, maxTweets) {
    if (!Number.isFinite(Number(maxTweets)) || Number(maxTweets) <= 0) {
      return tweets;
    }

    return tweets.slice(0, Number(maxTweets));
  }
})();
