const state = {
  bridgeConfig: null,
  eventSource: null,
  reconnectTimerId: null,
  heartbeatTimerId: null,
  clientId: "",
  lastServerHeartbeatAt: "",
  currentJobId: ""
};

bootstrap();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) {
    return false;
  }

  if (message.type === "TWITTER_TIMELINE_OFFSCREEN_JOB_STATE") {
    state.currentJobId = message.payload && message.payload.activeJobId || "";
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) {
    return false;
  }

  if (message.type === "TWITTER_TIMELINE_OFFSCREEN_CONNECT") {
    state.bridgeConfig = message.payload || null;
    connectToServer()
      .then(() => {
        sendResponse({ ok: true });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error && error.message || String(error) });
      });
    return true;
  }

  return false;
});

async function bootstrap() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "TWITTER_TIMELINE_GET_BRIDGE_CONFIG"
    });
    if (!response || !response.ok || !response.bridgeConfig) {
      return;
    }

    state.bridgeConfig = response.bridgeConfig;
    await connectToServer();
  } catch (_error) {
    // The service worker may not be ready yet. The explicit connect message will retry later.
  }
}

async function connectToServer() {
  if (!state.bridgeConfig) {
    throw new Error("missing_bridge_config");
  }

  if (state.eventSource) {
    return;
  }

  const eventsUrl = new URL("/extension/events", state.bridgeConfig.serverOrigin);
  eventsUrl.searchParams.set("token", state.bridgeConfig.extensionToken);
  const eventSource = new EventSource(eventsUrl.toString());
  state.eventSource = eventSource;
  state.clientId = "";

  eventSource.addEventListener("bridge_ready", (event) => {
    clearReconnectTimer();
    handleServerHeartbeat();
    state.clientId = readClientIdFromEvent(event);
    startHeartbeatLoop();
    console.log("[twitter-timeline] offscreen SSE connected");
  });

  eventSource.addEventListener("heartbeat", () => {
    handleServerHeartbeat();
  });

  eventSource.addEventListener("collect_timeline", async (event) => {
    try {
      const payload = JSON.parse(event.data);
      state.currentJobId = payload && payload.jobId || "";
      const response = await chrome.runtime.sendMessage({
        type: "TWITTER_TIMELINE_COLLECT_JOB",
        payload
      });
      if (!response || !response.ok) {
        throw new Error(response && response.error || "collect_job_failed");
      }
    } catch (error) {
      console.error("[twitter-timeline] offscreen collect job failed", error);
      chrome.runtime.sendMessage({
        type: "TWITTER_TIMELINE_COLLECTION_PROGRESS",
        payload: {
          jobId: safeReadJobId(event.data),
          status: "failed",
          errors: [{ message: error && error.message || String(error) }]
        }
      }).catch(() => null);
    }
  });

  eventSource.onerror = () => {
    disconnectEventSource();
    scheduleReconnect();
  };
}

function disconnectEventSource() {
  if (!state.eventSource) {
    return;
  }

  state.eventSource.close();
  state.eventSource = null;
  stopHeartbeatLoop();
}

function scheduleReconnect() {
  if (state.reconnectTimerId || !state.bridgeConfig) {
    return;
  }

  state.reconnectTimerId = setTimeout(() => {
    state.reconnectTimerId = null;
    connectToServer().catch((error) => {
      console.error("[twitter-timeline] offscreen reconnect failed", error);
      scheduleReconnect();
    });
  }, Number(state.bridgeConfig.reconnectDelayMs) || 5000);
}

function clearReconnectTimer() {
  if (!state.reconnectTimerId) {
    return;
  }

  clearTimeout(state.reconnectTimerId);
  state.reconnectTimerId = null;
}

function handleServerHeartbeat() {
  state.lastServerHeartbeatAt = new Date().toISOString();
}

function startHeartbeatLoop() {
  stopHeartbeatLoop();
  state.heartbeatTimerId = setInterval(() => {
    postBridgeHeartbeat().catch((error) => {
      console.error("[twitter-timeline] offscreen heartbeat failed", error);
    });
  }, 25000);
}

function stopHeartbeatLoop() {
  if (!state.heartbeatTimerId) {
    return;
  }

  clearInterval(state.heartbeatTimerId);
  state.heartbeatTimerId = null;
}

async function postBridgeHeartbeat() {
  if (!state.bridgeConfig) {
    return;
  }

  const url = new URL("/extension/heartbeat", state.bridgeConfig.serverOrigin);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${state.bridgeConfig.extensionToken}`
    },
    body: JSON.stringify({
      clientId: state.clientId || null,
      activeJobId: state.currentJobId || null,
      lastServerHeartbeatAt: state.lastServerHeartbeatAt || null,
      sentAt: new Date().toISOString()
    })
  });

  if (!response.ok) {
    throw new Error(`heartbeat_post_failed_${response.status}`);
  }
}

function readClientIdFromEvent(_event) {
  try {
    const payload = JSON.parse(_event.data);
    return payload && payload.clientId || "";
  } catch (_error) {
    return "";
  }
}

function safeReadJobId(rawData) {
  try {
    const payload = JSON.parse(rawData);
    return payload && payload.jobId || "";
  } catch (_error) {
    return "";
  }
}
