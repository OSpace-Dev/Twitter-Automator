const DEFAULT_BRIDGE_CONFIG = {
  serverOrigin: "http://127.0.0.1:8001",
  extensionToken: "dev-twitter-timeline-extension-token"
};

const BRIDGE_CONFIG_KEY = "bridgeConfig";
const PENDING_COLLECTION_KEY = "pendingCollection";
const ACTIVE_SERVICE_TASK_KEY = "activeServiceTask";
const PANEL_LOGS_KEY = "panelLogs";
const PANEL_STATE_KEY = "panelState";
const PANEL_LOG_LIMIT = 120;
const PANEL_TEST_RELOAD_KEY = "panelTestReload";
const EXTENSION_PHASE = {
  BRIDGE_READY: "bridge_ready",
  DISPATCH_PENDING: "dispatch_pending",
  TAB_OPENED: "tab_opened",
  TAB_RELOADING: "tab_reloading",
  WAITING_CONTENT_READY: "waiting_content_ready",
  STARTING_COLLECTION: "starting_collection",
  COLLECTING: "collecting",
  COMPLETED: "completed",
  FAILED: "failed"
};

safeBootstrap("initial");

if (chrome.runtime && chrome.runtime.onInstalled && typeof chrome.runtime.onInstalled.addListener === "function") {
  chrome.runtime.onInstalled.addListener(() => {
    safeBootstrap("install");
  });
}

if (chrome.runtime && chrome.runtime.onStartup && typeof chrome.runtime.onStartup.addListener === "function") {
  chrome.runtime.onStartup.addListener(() => {
    safeBootstrap("startup");
  });
}

if (chrome.action && chrome.action.onClicked && typeof chrome.action.onClicked.addListener === "function") {
  chrome.action.onClicked.addListener((tab) => {
    void openSidePanelForTab(tab);
  });
}

if (chrome.tabs && chrome.tabs.onUpdated && typeof chrome.tabs.onUpdated.addListener === "function") {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status !== "complete") {
      return;
    }

    void resumePendingCollectionDispatch(tabId);
  });
}

if (chrome.tabs && chrome.tabs.onRemoved && typeof chrome.tabs.onRemoved.addListener === "function") {
  chrome.tabs.onRemoved.addListener((tabId) => {
    void handleTrackedTabRemoved(tabId);
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return false;
  }

  if (message.type === "TWITTER_TIMELINE_COLLECT_JOB") {
    void respondAsync(sendResponse, async () => {
      await dispatchCollectTimeline(message.payload);
      return { ok: true };
    }, "[twitter-timeline] failed to dispatch job");
    return true;
  }

  if (message.type === "TWITTER_TIMELINE_COLLECTION_DONE") {
    void respondAsync(sendResponse, async () => {
      await handleCollectionDone(message.payload);
      return { ok: true };
    }, "[twitter-timeline] collection done failed");
    return true;
  }

  if (message.type === "TWITTER_TIMELINE_COLLECTION_PROGRESS") {
    void respondAsync(sendResponse, async () => {
      await handleCollectionProgress(message.payload);
      return { ok: true };
    }, "[twitter-timeline] collection progress failed");
    return true;
  }

  if (message.type === "TWITTER_TIMELINE_CONTENT_READY") {
    void respondAsync(sendResponse, async () => {
      await handleContentReady(sender);
      return { ok: true };
    }, "[twitter-timeline] content ready handling failed");
    return true;
  }

  if (message.type === "TWITTER_TIMELINE_GET_BRIDGE_STATE") {
    void respondAsync(sendResponse, async () => {
      const bridgeConfig = await ensureBridgeConfig();
      const pendingCollection = await getPendingCollection();
      const panelState = await getPanelState();
      const panelLogs = await getPanelLogs();
      return {
        ok: true,
        pendingCollection,
        bridgeConfig,
        panelState,
        panelLogs
      };
    }, "[twitter-timeline] get bridge state failed");
    return true;
  }

  if (message.type === "TWITTER_TIMELINE_GET_BRIDGE_CONFIG") {
    void respondAsync(sendResponse, async () => {
      const bridgeConfig = await ensureBridgeConfig();
      return {
        ok: true,
        bridgeConfig
      };
    }, "[twitter-timeline] get bridge config failed");
    return true;
  }

  if (message.type === "TWITTER_TIMELINE_PANEL_CLEAR_LOGS") {
    void respondAsync(sendResponse, async () => {
      await setPanelLogs([]);
      return { ok: true };
    }, "[twitter-timeline] clear panel logs failed");
    return true;
  }

  if (message.type === "TWITTER_TIMELINE_PANEL_TEST_RELOAD") {
    void respondAsync(sendResponse, async () => {
      await handlePanelTestReload(message.payload);
      return { ok: true };
    }, "[twitter-timeline] panel test reload failed");
    return true;
  }

  return false;
});

async function bootstrap() {
  logInfo("bootstrap_start");
  const bridgeConfig = await ensureBridgeConfig();
  await ensureOffscreenDocument();
  await maybeEnableSidePanelBehavior();
  await runtimeSendMessage({
    type: "TWITTER_TIMELINE_OFFSCREEN_CONNECT",
    payload: bridgeConfig
  }).catch(() => null);
  await resumePendingCollectionDispatch();
  await syncPanelState({ bridgeConfig, phase: EXTENSION_PHASE.BRIDGE_READY });
  logInfo("bootstrap_complete", {
    serverOrigin: bridgeConfig.serverOrigin
  });
}

async function ensureBridgeConfig() {
  const storage = await storageLocalGet(BRIDGE_CONFIG_KEY);
  return Object.assign({}, DEFAULT_BRIDGE_CONFIG, storage.bridgeConfig || {});
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen || typeof chrome.offscreen.createDocument !== "function") {
    logWarn("offscreen_unavailable");
    console.warn("[twitter-timeline] chrome.offscreen is unavailable in this browser.");
    return;
  }

  if (!chrome.runtime || typeof chrome.runtime.getURL !== "function") {
    logWarn("runtime_get_url_unavailable");
    console.warn("[twitter-timeline] chrome.runtime.getURL is unavailable.");
    return;
  }

  const offscreenUrl = chrome.runtime.getURL("offscreen.html");
  const contexts = chrome.runtime.getContexts
    ? await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl]
    })
    : [];
  if (contexts.length > 0) {
    logDebug("offscreen_already_exists");
    return;
  }

  try {
    logInfo("offscreen_create_start");
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS"],
      justification: "Maintain the local SSE connection for timeline collection tasks."
    });
    logInfo("offscreen_create_complete");
  } catch (error) {
    const message = error && error.message || String(error);
    if (message.includes("Only a single offscreen document may be created")) {
      logDebug("offscreen_create_skipped_existing");
      return;
    }

    logError("offscreen_create_failed", { error: message });
    throw error;
  }
}

async function dispatchCollectTimeline(job) {
  if (!job || !job.jobId || !job.username) {
    throw new Error("invalid_job");
  }

  await cleanupStaleManagedTaskTab(job.jobId);

  logInfo("dispatch_collect_job_received", {
    jobId: job.jobId,
    username: job.username
  });
  const targetUrl = `https://x.com/${job.username}`;
  const tab = await createManagedTaskTab(targetUrl);
  if (!tab || !tab.id) {
    logError("dispatch_collect_job_no_tab", {
      jobId: job.jobId
    });
    throw new Error("target_tab_unavailable");
  }

  await setActiveServiceTask({
    jobId: job.jobId,
    tabId: tab.id,
    windowId: tab.windowId || null,
    targetUrl,
    autoClose: true,
    createdAt: new Date().toISOString()
  });
  await setPendingCollection({
    job,
    tabId: tab.id,
    targetUrl,
    managedTab: true,
    createdAt: new Date().toISOString()
  });
  await syncPanelState({
    phase: EXTENSION_PHASE.DISPATCH_PENDING,
    activeJob: job,
    activeTabId: tab.id,
    targetUrl
  });
  await notifyOffscreenJobState(job.jobId);

  await postJobStatus(job.jobId, {
    status: "dispatched",
    pageUrl: targetUrl,
    activeUsername: job.username,
    result: {
      extensionPhase: EXTENSION_PHASE.TAB_OPENED
    }
  });

  const currentUrl = tab.url || "";
  if (currentUrl.startsWith(targetUrl)) {
    logInfo("dispatch_collect_job_reload_target_tab", {
      jobId: job.jobId,
      tabId: tab.id,
      targetUrl
    });
    await tabsReload(tab.id);
    await syncPanelState({
      phase: EXTENSION_PHASE.TAB_RELOADING,
      activeJob: job,
      activeTabId: tab.id,
      targetUrl
    });
    return;
  }

  logInfo("dispatch_collect_job_wait_target_navigation", {
    jobId: job.jobId,
    tabId: tab.id,
    currentUrl,
    targetUrl
  });
}

async function createManagedTaskTab(targetUrl) {
  logInfo("managed_task_tab_create", {
    targetUrl
  });
  return tabsCreate({
    url: targetUrl,
    active: true
  });
}

async function tryStartCollection(tabId, job) {
  try {
    logInfo("collection_start_message_send", {
      tabId,
      jobId: job.jobId
    });
    await syncPanelState({
      phase: EXTENSION_PHASE.STARTING_COLLECTION,
      activeJob: job,
      activeTabId: tabId
    });
    await tabsSendMessage(tabId, {
      type: "TWITTER_TIMELINE_START",
      options: {
        username: job.username,
        sinceTime: job.sinceTime,
        maxTweets: job.maxTweets,
        autoReport: true,
        jobId: job.jobId
      }
    });
    logInfo("collection_start_message_ack", {
      tabId,
      jobId: job.jobId
    });
    return true;
  } catch (error) {
    if (isRecoverableContentScriptError(error)) {
      logWarn("collection_start_wait_content_ready", {
        tabId,
        jobId: job.jobId,
        error: error && error.message || String(error)
      });
      return false;
    }

    logError("collection_start_message_failed", {
      tabId,
      jobId: job.jobId,
      error: error && error.message || String(error)
    });
    throw error;
  }
}

async function handleCollectionProgress(payload) {
  if (!payload || !payload.jobId) {
    return;
  }

  logInfo("collection_progress", {
    jobId: payload.jobId,
    status: payload.status || "collecting",
    tweetCount: payload.tweetCount || 0,
    stopReason: payload.stopReason || null,
    activeUsername: payload.activeUsername || null
  });
  await postJobStatus(payload.jobId, {
    status: payload.status || "collecting",
    pageUrl: payload.pageUrl,
    activeUsername: payload.activeUsername,
    tweetCount: payload.tweetCount,
    stopReason: payload.stopReason || null,
    errors: payload.errors || null,
    result: {
      extensionPhase: mapRuntimeStatusToExtensionPhase(payload.status, payload.stopReason),
      collection: payload.collection || null
    }
  });
  await syncPanelState({
    phase: mapRuntimeStatusToExtensionPhase(payload.status, payload.stopReason),
    lastProgress: payload,
    activeJob: payload.jobId ? { jobId: payload.jobId, username: payload.activeUsername || "" } : null
  });
  await notifyOffscreenJobState(payload.status === "collecting" ? payload.jobId : "");
}

async function handleCollectionDone(payload) {
  if (!payload || !payload.jobId) {
    return;
  }

  logInfo("collection_done", {
    jobId: payload.jobId,
    status: payload.status || "completed",
    tweetCount: Array.isArray(payload.tweets) ? payload.tweets.length : 0,
    stopReason: payload.stopReason || null
  });
  await clearPendingCollection(payload.jobId);
  await closeManagedTaskTabForJob(payload.jobId, "task_completed");
  await postJobResult(payload.jobId, payload);
  await syncPanelState({
    phase: EXTENSION_PHASE.COMPLETED,
    activeJob: null,
    activeTabId: null,
    targetUrl: null,
    lastCompleted: {
      jobId: payload.jobId,
      status: payload.status || "completed",
      stopReason: payload.stopReason || null,
      tweetCount: Array.isArray(payload.tweets) ? payload.tweets.length : 0,
      finishedAt: new Date().toISOString()
    }
  });
  await notifyOffscreenJobState("");
}

async function handleContentReady(sender) {
  if (!sender || !sender.tab || !sender.tab.id) {
    return;
  }

  logInfo("content_ready", {
    tabId: sender.tab.id,
    url: sender.tab.url || null
  });
  await syncPanelState({
    phase: EXTENSION_PHASE.WAITING_CONTENT_READY,
    activeTabId: sender.tab.id
  });
  await maybeRunPanelTestReload(sender.tab.id);
  await resumePendingCollectionDispatch(sender.tab.id);
}

async function handlePanelTestReload(payload) {
  const tabId = payload && Number(payload.tabId);
  if (!Number.isInteger(tabId) || tabId <= 0) {
    throw new Error("invalid_tab_id");
  }

  const options = sanitizePanelOptions(payload && payload.options || {});
  await storageSessionSet({
    [PANEL_TEST_RELOAD_KEY]: {
      tabId,
      options,
      requestedAt: new Date().toISOString()
    }
  });

  logInfo("panel_test_reload_requested", {
    tabId,
    username: options.username || null,
    sinceTime: options.sinceTime || null,
    maxTweets: options.maxTweets
  });

  await tabsReload(tabId);
  await syncPanelState({
    phase: EXTENSION_PHASE.TAB_RELOADING,
    activeTabId: tabId,
    targetUrl: null
  });
}

async function resumePendingCollectionDispatch(tabId) {
  try {
    const pendingCollection = await getPendingCollection();
    if (!pendingCollection || !pendingCollection.job || !pendingCollection.tabId) {
      return false;
    }

    if (tabId && pendingCollection.tabId !== tabId) {
      return false;
    }

    const tab = await tabsGet(pendingCollection.tabId).catch(() => null);
    if (!tab || !tab.id) {
      logWarn("resume_pending_no_tab", {
        jobId: pendingCollection.job.jobId
      });
      await failPendingCollection(pendingCollection, "target_tab_unavailable", "Target X tab is unavailable before collection could start.");
      return false;
    }

    if (pendingCollection.targetUrl && tab.url && !tab.url.startsWith(pendingCollection.targetUrl)) {
      logDebug("resume_pending_wait_target_url", {
        jobId: pendingCollection.job.jobId,
        tabId: tab.id,
        currentUrl: tab.url,
        targetUrl: pendingCollection.targetUrl
      });
      return false;
    }

    const started = await tryStartCollection(tab.id, pendingCollection.job);
    if (!started) {
      return false;
    }

    await clearPendingCollection(pendingCollection.job.jobId);
    await syncPanelState({
      phase: EXTENSION_PHASE.COLLECTING,
      activeJob: pendingCollection.job,
      activeTabId: tab.id,
      targetUrl: pendingCollection.targetUrl
    });
    return true;
  } catch (error) {
    logError("resume_pending_failed", {
      error: error && error.message || String(error)
    });
    console.error("[twitter-timeline] failed to resume pending dispatch", error);
    return false;
  }
}

async function maybeRunPanelTestReload(tabId) {
  const storage = await storageSessionGet(PANEL_TEST_RELOAD_KEY);
  const pendingReload = storage[PANEL_TEST_RELOAD_KEY] || null;
  if (!pendingReload || pendingReload.tabId !== tabId) {
    return false;
  }

  await storageSessionRemove(PANEL_TEST_RELOAD_KEY);
  logInfo("panel_test_reload_start", {
    tabId,
    username: pendingReload.options && pendingReload.options.username || null
  });

  const started = await tryStartCollection(tabId, Object.assign({
    jobId: "",
    username: ""
  }, pendingReload.options || {}));

  await syncPanelState({
    phase: started ? EXTENSION_PHASE.COLLECTING : EXTENSION_PHASE.WAITING_CONTENT_READY,
    activeTabId: tabId
  });

  return started;
}

async function handleTrackedTabRemoved(tabId) {
  try {
    const activeServiceTask = await getActiveServiceTask();
    if (activeServiceTask && activeServiceTask.tabId === tabId) {
      logInfo("managed_task_tab_removed", {
        tabId,
        jobId: activeServiceTask.jobId
      });
      await clearActiveServiceTask(activeServiceTask.jobId);
    }

    const pendingCollection = await getPendingCollection();
    if (!pendingCollection || pendingCollection.tabId !== tabId) {
      return;
    }

    logWarn("tracked_tab_removed", {
      tabId,
      jobId: pendingCollection.job && pendingCollection.job.jobId || null
    });
    await failPendingCollection(pendingCollection, "target_tab_closed", "Target X tab was closed before collection could start.");
  } catch (error) {
    logError("tracked_tab_removed_failed", {
      tabId,
      error: error && error.message || String(error)
    });
    console.error("[twitter-timeline] failed to handle tracked tab removal", error);
  }
}

async function failPendingCollection(pendingCollection, stopReason, message) {
  if (!pendingCollection || !pendingCollection.job || !pendingCollection.job.jobId) {
    return;
  }

  logError("pending_collection_failed", {
    jobId: pendingCollection.job.jobId,
    stopReason,
    message
  });
  await clearPendingCollection(pendingCollection.job.jobId);
  await closeManagedTaskTabForJob(pendingCollection.job.jobId, stopReason || "task_failed");
  await postJobStatus(pendingCollection.job.jobId, {
    status: "failed",
    stopReason,
    errors: [{ message }]
  });
  await syncPanelState({
    phase: EXTENSION_PHASE.FAILED,
    activeJob: null,
    activeTabId: null,
    targetUrl: null,
    lastCompleted: {
      jobId: pendingCollection.job.jobId,
      status: "failed",
      stopReason,
      tweetCount: 0,
      finishedAt: new Date().toISOString()
    }
  });
  await notifyOffscreenJobState("");
}

async function postJobStatus(jobId, payload) {
  const bridgeConfig = await ensureBridgeConfig();
  const url = new URL(`/extension/jobs/${jobId}/status`, bridgeConfig.serverOrigin);
  logDebug("post_job_status_start", {
    jobId,
    status: payload.status || null,
    stopReason: payload.stopReason || null
  });
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bridgeConfig.extensionToken}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    logError("post_job_status_failed", {
      jobId,
      statusCode: response.status
    });
    throw new Error(`status post failed with ${response.status}`);
  }
  logDebug("post_job_status_complete", {
    jobId,
    statusCode: response.status
  });
}

async function postJobResult(jobId, payload) {
  const bridgeConfig = await ensureBridgeConfig();
  const url = new URL(`/extension/jobs/${jobId}/result`, bridgeConfig.serverOrigin);
  logDebug("post_job_result_start", {
    jobId,
    tweetCount: Array.isArray(payload.tweets) ? payload.tweets.length : 0
  });
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bridgeConfig.extensionToken}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    logError("post_job_result_failed", {
      jobId,
      statusCode: response.status
    });
    throw new Error(`result post failed with ${response.status}`);
  }
  logDebug("post_job_result_complete", {
    jobId,
    statusCode: response.status
  });
}

function safeBootstrap(source) {
  bootstrap().catch((error) => {
    void logError("bootstrap_failed", {
      source,
      error: error && error.message || String(error)
    });
    console.error(`[twitter-timeline] bootstrap failed at ${source}`, error);
  });
}

function respondAsync(sendResponse, action, errorPrefix) {
  return action().then((payload) => {
    sendResponse(payload);
  }).catch((error) => {
    console.error(errorPrefix, error);
    sendResponse({ ok: false, error: error && error.message || String(error) });
  });
}

function runtimeSendMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }

        resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function storageLocalGet(key) {
  return storageGet(chrome.storage.local, key);
}

function storageSessionGet(key) {
  return storageGet(getSessionStorageArea(), key);
}

function storageSessionSet(items) {
  return storageSet(getSessionStorageArea(), items);
}

function storageSessionRemove(key) {
  return storageRemove(getSessionStorageArea(), key);
}

function getSessionStorageArea() {
  return chrome.storage.session || chrome.storage.local;
}

function storageGet(storageArea, key) {
  return new Promise((resolve, reject) => {
    try {
      storageArea.get(key, (value) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }

        resolve(value || {});
      });
    } catch (error) {
      reject(error);
    }
  });
}

function storageSet(storageArea, items) {
  return new Promise((resolve, reject) => {
    try {
      storageArea.set(items, () => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }

        resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

function storageRemove(storageArea, key) {
  return new Promise((resolve, reject) => {
    try {
      storageArea.remove(key, () => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }

        resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

function tabsQuery(queryInfo) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.query(queryInfo, (tabs) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }

        resolve(tabs || []);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function tabsGet(tabId) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.get(tabId, (tab) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }

        resolve(tab);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function tabsUpdate(tabId, updateProperties) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.update(tabId, updateProperties, (tab) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }

        resolve(tab);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function tabsCreate(createProperties) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.create(createProperties, (tab) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }

        resolve(tab);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function tabsReload(tabId) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.reload(tabId, {}, function onReload() {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }

        resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

function tabsRemove(tabId) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.remove(tabId, function onRemoved() {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }

        resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

function tabsSendMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }

        resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function getPendingCollection() {
  const storage = await storageSessionGet(PENDING_COLLECTION_KEY);
  return storage[PENDING_COLLECTION_KEY] || null;
}

async function getActiveServiceTask() {
  const storage = await storageSessionGet(ACTIVE_SERVICE_TASK_KEY);
  return storage[ACTIVE_SERVICE_TASK_KEY] || null;
}

function setPendingCollection(pendingCollection) {
  return storageSessionSet({
    [PENDING_COLLECTION_KEY]: pendingCollection
  });
}

function setActiveServiceTask(activeServiceTask) {
  return storageSessionSet({
    [ACTIVE_SERVICE_TASK_KEY]: activeServiceTask
  });
}

async function clearPendingCollection(jobId) {
  const pendingCollection = await getPendingCollection();
  if (!pendingCollection) {
    return;
  }

  if (jobId && pendingCollection.job && pendingCollection.job.jobId !== jobId) {
    return;
  }

  await storageSessionRemove(PENDING_COLLECTION_KEY);
}

async function clearActiveServiceTask(jobId) {
  const activeServiceTask = await getActiveServiceTask();
  if (!activeServiceTask) {
    return;
  }

  if (jobId && activeServiceTask.jobId !== jobId) {
    return;
  }

  await storageSessionRemove(ACTIVE_SERVICE_TASK_KEY);
}

async function cleanupStaleManagedTaskTab(nextJobId) {
  const activeServiceTask = await getActiveServiceTask();
  if (!activeServiceTask || !activeServiceTask.autoClose) {
    return;
  }

  if (activeServiceTask.jobId === nextJobId) {
    return;
  }

  await closeManagedTaskTab(activeServiceTask, "cleanup_stale_task_tab");
}

async function closeManagedTaskTabForJob(jobId, reason) {
  const activeServiceTask = await getActiveServiceTask();
  if (!activeServiceTask || activeServiceTask.jobId !== jobId || !activeServiceTask.autoClose) {
    return false;
  }

  return closeManagedTaskTab(activeServiceTask, reason);
}

async function closeManagedTaskTab(activeServiceTask, reason) {
  if (!activeServiceTask || !activeServiceTask.tabId) {
    return false;
  }

  const tab = await tabsGet(activeServiceTask.tabId).catch(() => null);
  if (!tab || !tab.id) {
    logWarn("managed_task_tab_missing_on_close", {
      jobId: activeServiceTask.jobId,
      tabId: activeServiceTask.tabId,
      reason
    });
    await clearActiveServiceTask(activeServiceTask.jobId);
    return false;
  }

  const windowTabs = await tabsQuery({
    windowId: tab.windowId
  }).catch(() => []);
  const isLastTabInWindow = windowTabs.filter(function hasTabId(windowTab) {
    return windowTab && windowTab.id;
  }).length <= 1;

  if (isLastTabInWindow) {
    logInfo("managed_task_tab_create_placeholder", {
      jobId: activeServiceTask.jobId,
      windowId: tab.windowId,
      tabId: tab.id,
      reason
    });
    await tabsCreate({
      windowId: tab.windowId,
      active: false
    });
  }

  logInfo("managed_task_tab_close", {
    jobId: activeServiceTask.jobId,
    tabId: tab.id,
    windowId: tab.windowId,
    reason,
    isLastTabInWindow
  });
  await tabsRemove(tab.id);
  await clearActiveServiceTask(activeServiceTask.jobId);
  return true;
}

function isRecoverableContentScriptError(error) {
  const message = error && error.message || String(error);
  return message.includes("Receiving end does not exist")
    || message.includes("Could not establish connection")
    || message.includes("The message port closed before a response was received");
}

function sanitizePanelOptions(options) {
  return {
    username: String(options && options.username || "").trim(),
    sinceTime: options && options.sinceTime || "",
    maxTweets: clampNumber(options && options.maxTweets, 1, 500, 100)
  };
}

function clampNumber(value, min, max, fallback) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.floor(numberValue)));
}

async function openSidePanelForTab(tab) {
  if (!chrome.sidePanel || typeof chrome.sidePanel.open !== "function") {
    logWarn("side_panel_unavailable");
    return;
  }

  try {
    if (tab && tab.windowId) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
      logInfo("side_panel_opened", {
        windowId: tab.windowId,
        tabId: tab.id || null
      });
    }
  } catch (error) {
    logError("side_panel_open_failed", {
      error: error && error.message || String(error)
    });
  }
}

async function maybeEnableSidePanelBehavior() {
  if (!chrome.sidePanel || typeof chrome.sidePanel.setPanelBehavior !== "function") {
    return;
  }

  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    logInfo("side_panel_behavior_enabled");
  } catch (error) {
    logError("side_panel_behavior_failed", {
      error: error && error.message || String(error)
    });
  }
}

async function getPanelState() {
  const storage = await storageSessionGet(PANEL_STATE_KEY);
  return storage[PANEL_STATE_KEY] || {
    phase: EXTENSION_PHASE.BRIDGE_READY,
    activeJob: null,
    lastProgress: null,
    lastCompleted: null,
    activeTabId: null,
    targetUrl: null,
    bridgeConfig: null
  };
}

function setPanelState(panelState) {
  return storageSessionSet({
    [PANEL_STATE_KEY]: panelState
  });
}

async function syncPanelState(patch) {
  const currentState = await getPanelState();
  const nextState = Object.assign({}, currentState, patch || {}, {
    updatedAt: new Date().toISOString()
  });
  await setPanelState(nextState);
}

async function getPanelLogs() {
  const storage = await storageSessionGet(PANEL_LOGS_KEY);
  return Array.isArray(storage[PANEL_LOGS_KEY]) ? storage[PANEL_LOGS_KEY] : [];
}

function setPanelLogs(panelLogs) {
  return storageSessionSet({
    [PANEL_LOGS_KEY]: panelLogs
  });
}

async function appendPanelLog(level, event, payload) {
  const currentLogs = await getPanelLogs();
  currentLogs.push({
    time: new Date().toISOString(),
    level,
    event,
    payload: payload || null
  });
  if (currentLogs.length > PANEL_LOG_LIMIT) {
    currentLogs.splice(0, currentLogs.length - PANEL_LOG_LIMIT);
  }
  await setPanelLogs(currentLogs);
}

function logInfo(event, payload) {
  void appendPanelLog("INFO", event, payload);
  console.log(formatLogLine("INFO", event, payload));
}

function logWarn(event, payload) {
  void appendPanelLog("WARN", event, payload);
  console.warn(formatLogLine("WARN", event, payload));
}

function logError(event, payload) {
  void appendPanelLog("ERROR", event, payload);
  console.error(formatLogLine("ERROR", event, payload));
}

function logDebug(event, payload) {
  void appendPanelLog("DEBUG", event, payload);
  console.log(formatLogLine("DEBUG", event, payload));
}

function formatLogLine(level, event, payload) {
  return JSON.stringify({
    time: new Date().toISOString(),
    level,
    scope: "twitter-timeline-extension",
    event,
    ...payload
  });
}

function mapRuntimeStatusToExtensionPhase(status, stopReason) {
  const normalizedStatus = String(status || "").trim().toLowerCase();
  if (normalizedStatus === "collecting") {
    return EXTENSION_PHASE.COLLECTING;
  }

  if (normalizedStatus === "completed") {
    return EXTENSION_PHASE.COMPLETED;
  }

  if (normalizedStatus === "failed") {
    return EXTENSION_PHASE.FAILED;
  }

  if (normalizedStatus === "cancelled") {
    return stopReason === "manual_stop" || stopReason === "manual_clear"
      ? EXTENSION_PHASE.COMPLETED
      : EXTENSION_PHASE.FAILED;
  }

  return EXTENSION_PHASE.COLLECTING;
}

async function notifyOffscreenJobState(activeJobId) {
  try {
    await runtimeSendMessage({
      type: "TWITTER_TIMELINE_OFFSCREEN_JOB_STATE",
      payload: {
        activeJobId: activeJobId || ""
      }
    });
  } catch (_error) {
    // The offscreen document may be reconnecting. Heartbeat state will self-heal on next dispatch.
  }
}
