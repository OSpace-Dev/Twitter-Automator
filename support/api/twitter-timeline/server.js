const http = require("node:http");
const { randomUUID } = require("node:crypto");
const { URL } = require("node:url");
const config = require("./config");
const { createLogger } = require("./logger");
const { DailyScheduler, getShanghaiDateKey } = require("./scheduler");
const { TimelineStore } = require("./store");

const DAY_MS = 24 * 60 * 60 * 1000;

function createApp(options = {}) {
  const SSE_HEARTBEAT_INTERVAL_MS = 25000;
  const appConfig = {
    host: options.host || config.host,
    port: options.port ?? config.port,
    apiToken: options.apiToken || config.apiToken,
    extensionToken: options.extensionToken || config.extensionToken,
    databasePath: options.databasePath || config.databasePath,
    dispatchTimeoutMs: options.dispatchTimeoutMs || 60000,
    defaultScheduleTime: options.defaultScheduleTime || config.defaultScheduleTime,
    adminOrigins: options.adminOrigins || config.adminOrigins
  };
  const store = options.store || new TimelineStore(appConfig.databasePath, {
    scheduleTime: appConfig.defaultScheduleTime
  });
  const logger = options.logger || createLogger("twitter-timeline-api");
  const now = options.now || (() => new Date());
  const clients = new Set();
  let activeJobId = null;
  let activeLeaseClientId = null;
  let dispatchTimeoutId = null;
  let shuttingDown = false;
  const scheduler = options.scheduler || new DailyScheduler({
    scheduleTime: store.getSettings().scheduleTime,
    now,
    async onDue(runDate, source) {
      createScheduledJobs(runDate, source);
    }
  });

  logger.info("server_init", {
    host: appConfig.host,
    port: appConfig.port,
    databasePath: appConfig.databasePath,
    dispatchTimeoutMs: appConfig.dispatchTimeoutMs
  });

  const server = http.createServer(async (request, response) => {
    const startedAt = Date.now();
    try {
      const requestUrl = new URL(request.url, `http://${request.headers.host || `${appConfig.host}:${appConfig.port}`}`);
      const pathname = requestUrl.pathname;
      const isAdminRequest = pathname === "/health" || pathname.startsWith("/api/");
      const corsAllowed = isAdminRequest
        ? applyCors(request, response, appConfig.adminOrigins)
        : true;
      logger.debug("request_start", {
        method: request.method,
        pathname,
        search: requestUrl.search
      });

      if (request.method === "OPTIONS") {
        logger.debug("request_options", { pathname });
        return corsAllowed
          ? sendNoContent(response, 204)
          : sendJson(response, 403, { ok: false, error: "origin_not_allowed" });
      }
      if (!corsAllowed) {
        return sendJson(response, 403, { ok: false, error: "origin_not_allowed" });
      }

      if (request.method === "GET" && pathname === "/health") {
        logger.debug("health_check", {
          activeJobId,
          extensionClients: clients.size
        });
        return sendJson(response, 200, {
          ok: true,
          activeJobId,
          extensionClients: clients.size,
          schedule: scheduler.getState(),
          settings: toPublicSettings(store.getSettings())
        });
      }

      if (request.method === "GET" && pathname === "/extension/events") {
        if (!isAuthorizedExtensionRequest(requestUrl, request, appConfig.extensionToken)) {
          logger.warn("extension_events_unauthorized", {
            pathname
          });
          return sendJson(response, 401, { ok: false, error: "unauthorized_extension" });
        }

        return handleExtensionEvents(request, response);
      }

      if (request.method === "POST" && /^\/extension\/jobs\/[^/]+\/status$/.test(pathname)) {
        if (!isAuthorizedBearer(request, appConfig.extensionToken)) {
          logger.warn("extension_status_unauthorized", { pathname });
          return sendJson(response, 401, { ok: false, error: "unauthorized_extension" });
        }

        const jobId = pathname.split("/")[3];
        const payload = await readJsonBody(request);
        logger.info("extension_status_received", {
          jobId,
          status: payload.status || "collecting",
          tweetCount: Number(payload.tweetCount) || 0,
          stopReason: payload.stopReason || null,
          activeUsername: payload.activeUsername || null
        });
        refreshActiveDispatchTimeout(jobId, "extension_status_received");
        const job = store.updateJobStatus(jobId, {
          status: payload.status || "collecting",
          pageUrl: payload.pageUrl || null,
          activeUsername: payload.activeUsername || null,
          stopReason: payload.stopReason || null,
          tweetCount: Number(payload.tweetCount) || null,
          errors: Array.isArray(payload.errors) ? payload.errors : null,
          result: payload.result || null
        });
        if (!job) {
          logger.warn("extension_status_job_not_found", { jobId });
          return sendJson(response, 404, { ok: false, error: "job_not_found" });
        }
        if (job && isTerminalStatus(job.status) && activeJobId === jobId) {
          clearActiveLease(jobId);
        }
        dispatchNextQueuedJob();
        return sendJson(response, 200, { ok: true, job });
      }

      if (request.method === "POST" && pathname === "/extension/heartbeat") {
        if (!isAuthorizedBearer(request, appConfig.extensionToken)) {
          logger.warn("extension_heartbeat_unauthorized", { pathname });
          return sendJson(response, 401, { ok: false, error: "unauthorized_extension" });
        }

        const payload = await readJsonBody(request);
        const clientId = payload && payload.clientId || null;
        const activeJobIdFromExtension = payload && payload.activeJobId || null;
        const client = clientId ? findClientById(clients, clientId) : null;
        if (client) {
          client.lastHeartbeatAt = new Date().toISOString();
        }

        logger.debug("extension_bridge_heartbeat_received", {
          clientId,
          activeJobId: activeJobIdFromExtension,
          activeLeaseClientId
        });
        if (activeJobIdFromExtension && activeJobIdFromExtension === activeJobId) {
          refreshActiveDispatchTimeout(activeJobIdFromExtension, "extension_bridge_heartbeat");
        }

        return sendJson(response, 200, {
          ok: true,
          activeJobId,
          activeLeaseClientId
        });
      }

      if (request.method === "POST" && /^\/extension\/jobs\/[^/]+\/result$/.test(pathname)) {
        if (!isAuthorizedBearer(request, appConfig.extensionToken)) {
          logger.warn("extension_result_unauthorized", { pathname });
          return sendJson(response, 401, { ok: false, error: "unauthorized_extension" });
        }

        const jobId = pathname.split("/")[3];
        const payload = await readJsonBody(request);
        logger.info("extension_result_received", {
          jobId,
          status: payload.status || "completed",
          tweetCount: Array.isArray(payload.tweets) ? payload.tweets.length : 0,
          stopReason: payload.stopReason || null,
          activeUsername: payload.activeUsername || null
        });
        const existingJob = store.getJob(jobId);
        if (!existingJob) {
          logger.warn("extension_result_job_not_found", { jobId });
          return sendJson(response, 404, { ok: false, error: "job_not_found" });
        }

        const job = store.completeJob(jobId, {
          status: payload.status || "completed",
          username: existingJob.username,
          tweets: payload.tweets || [],
          errors: payload.errors || [],
          stopReason: payload.stopReason || null,
          pageUrl: payload.pageUrl || null,
          activeUsername: payload.activeUsername || null,
          captureCount: Number(payload.captureCount) || 0,
          sourceUrl: payload.sourceUrl || null,
          collection: payload.collection || null,
          capturedAt: payload.capturedAt || new Date().toISOString()
        });
        if (activeJobId === jobId) {
          clearActiveLease(jobId);
        }
        dispatchNextQueuedJob();
        return sendJson(response, 200, { ok: true, job });
      }

      if (pathname.startsWith("/api/") && !isAuthorizedBearer(request, appConfig.apiToken)) {
        logger.warn("api_request_unauthorized", { pathname });
        return sendJson(response, 401, { ok: false, error: "unauthorized_api" });
      }

      if (request.method === "GET" && pathname === "/api/twitter-timeline/stats") {
        return sendJson(response, 200, {
          ok: true,
          stats: store.getStats(getShanghaiDateKey(now())),
          extensionClients: clients.size
        });
      }

      if (request.method === "GET" && pathname === "/api/twitter-timeline/settings") {
        return sendJson(response, 200, {
          ok: true,
          settings: toPublicSettings(store.getSettings()),
          schedule: scheduler.getState()
        });
      }

      if (request.method === "PUT" && pathname === "/api/twitter-timeline/settings") {
        const payload = await readJsonBody(request);
        if (!isScheduleTime(payload.scheduleTime)) {
          return sendJson(response, 400, { ok: false, error: "invalid_schedule_time" });
        }
        const settings = store.updateSettings({ scheduleTime: payload.scheduleTime });
        const schedule = scheduler.reschedule(settings.scheduleTime);
        logger.info("schedule_settings_updated", {
          scheduleTime: settings.scheduleTime,
          nextRunAt: schedule.nextRunAt
        });
        return sendJson(response, 200, {
          ok: true,
          settings: toPublicSettings(settings),
          schedule
        });
      }

      if (request.method === "GET" && pathname === "/api/twitter-timeline/targets") {
        return sendJson(response, 200, { ok: true, targets: store.listTargets() });
      }

      if (request.method === "POST" && pathname === "/api/twitter-timeline/targets") {
        const payload = await readJsonBody(request);
        const username = normalizeUsername(payload.username);
        if (!username) {
          return sendJson(response, 400, { ok: false, error: "username_required" });
        }
        if (store.getTargetByUsername(username)) {
          return sendJson(response, 409, { ok: false, error: "target_username_exists" });
        }
        const target = store.createTarget({
          targetId: randomUUID(),
          username,
          displayName: normalizeDisplayName(payload.displayName),
          maxTweets: clampNumber(payload.maxTweets, 1, 500, 100),
          enabled: payload.enabled === undefined ? true : Boolean(payload.enabled)
        });
        logger.info("target_created", { targetId: target.targetId, username: target.username });
        return sendJson(response, 201, { ok: true, target });
      }

      const targetRunMatch = pathname.match(/^\/api\/twitter-timeline\/targets\/([^/]+)\/run$/);
      if (request.method === "POST" && targetRunMatch) {
        const targetId = decodeURIComponent(targetRunMatch[1]);
        const target = store.getTarget(targetId);
        if (!target) {
          return sendJson(response, 404, { ok: false, error: "target_not_found" });
        }
        const job = createTargetJob(target, "manual", getShanghaiDateKey(now()));
        logger.info("target_manual_job_created", {
          targetId,
          jobId: job.jobId,
          username: job.username,
          sinceTime: job.sinceTime
        });
        dispatchNextQueuedJob();
        return sendJson(response, 201, { ok: true, job });
      }

      const targetMatch = pathname.match(/^\/api\/twitter-timeline\/targets\/([^/]+)$/);
      if (request.method === "PUT" && targetMatch) {
        const targetId = decodeURIComponent(targetMatch[1]);
        const existing = store.getTarget(targetId);
        if (!existing) {
          return sendJson(response, 404, { ok: false, error: "target_not_found" });
        }
        const payload = await readJsonBody(request);
        const username = payload.username === undefined
          ? existing.username
          : normalizeUsername(payload.username);
        if (!username) {
          return sendJson(response, 400, { ok: false, error: "username_required" });
        }
        const duplicate = store.getTargetByUsername(username);
        if (duplicate && duplicate.targetId !== targetId) {
          return sendJson(response, 409, { ok: false, error: "target_username_exists" });
        }
        const target = store.updateTarget(targetId, {
          username,
          displayName: payload.displayName === undefined
            ? existing.displayName
            : normalizeDisplayName(payload.displayName),
          maxTweets: payload.maxTweets === undefined
            ? existing.maxTweets
            : clampNumber(payload.maxTweets, 1, 500, existing.maxTweets),
          enabled: payload.enabled === undefined ? existing.enabled : Boolean(payload.enabled)
        });
        logger.info("target_updated", {
          targetId,
          username: target.username,
          enabled: target.enabled
        });
        return sendJson(response, 200, { ok: true, target });
      }

      if (pathname === "/api/twitter-timeline/jobs" && request.method === "POST") {
        if (!isAuthorizedBearer(request, appConfig.apiToken)) {
          logger.warn("api_create_job_unauthorized", { pathname });
          return sendJson(response, 401, { ok: false, error: "unauthorized_api" });
        }

        const payload = await readJsonBody(request);
        const username = normalizeUsername(payload.username);
        if (!username) {
          logger.warn("api_create_job_invalid_username", {
            providedUsername: payload.username || ""
          });
          return sendJson(response, 400, { ok: false, error: "username_required" });
        }

        if (payload.untilDate !== undefined) {
          logger.warn("api_create_job_legacy_field_until_date", {
            username,
            providedUntilDate: payload.untilDate
          });
          return sendJson(response, 400, { ok: false, error: "until_date_deprecated_use_since_time" });
        }

        if (payload.maxScrolls !== undefined) {
          logger.warn("api_create_job_legacy_field_max_scrolls", {
            username,
            providedMaxScrolls: payload.maxScrolls
          });
          return sendJson(response, 400, { ok: false, error: "max_scrolls_not_supported" });
        }

        const sinceTime = normalizeRequestedSinceTime(payload);
        if ((payload.sinceTime !== undefined || payload.startTime !== undefined) && !sinceTime) {
          logger.warn("api_create_job_invalid_since_time", {
            username,
            providedSinceTime: payload.sinceTime || payload.startTime || null
          });
          return sendJson(response, 400, { ok: false, error: "since_time_invalid" });
        }

        const job = store.createJob({
          jobId: randomUUID(),
          username,
          sinceTime,
          maxTweets: clampNumber(payload.maxTweets, 1, 500, 100),
          triggerType: "manual",
          runDate: getShanghaiDateKey(now())
        });
        logger.info("api_job_created", {
          jobId: job.jobId,
          username: job.username,
          sinceTime: job.sinceTime,
          maxTweets: job.maxTweets
        });
        dispatchNextQueuedJob();
        return sendJson(response, 201, { ok: true, job });
      }

      if (request.method === "GET" && pathname === "/api/twitter-timeline/jobs") {
        if (!isAuthorizedBearer(request, appConfig.apiToken)) {
          logger.warn("api_list_jobs_unauthorized", { pathname });
          return sendJson(response, 401, { ok: false, error: "unauthorized_api" });
        }

        const requestedDate = requestUrl.searchParams.get("date");
        const runDate = normalizeDateKey(requestedDate);
        if (requestedDate && !runDate) {
          return sendJson(response, 400, { ok: false, error: "invalid_date" });
        }
        const jobs = store.listJobs({
          username: normalizeUsername(requestUrl.searchParams.get("username")),
          status: normalizeStatus(requestUrl.searchParams.get("status")),
          runDate,
          triggerType: normalizeTriggerType(requestUrl.searchParams.get("triggerType")),
          limit: clampNumber(requestUrl.searchParams.get("limit"), 1, 500, 50)
        });
        logger.debug("api_list_jobs", {
          count: jobs.length,
          username: requestUrl.searchParams.get("username") || null,
          status: requestUrl.searchParams.get("status") || null
        });
        return sendJson(response, 200, { ok: true, jobs });
      }

      if (request.method === "GET" && /^\/api\/twitter-timeline\/jobs\/[^/]+$/.test(pathname)) {
        if (!isAuthorizedBearer(request, appConfig.apiToken)) {
          logger.warn("api_get_job_unauthorized", { pathname });
          return sendJson(response, 401, { ok: false, error: "unauthorized_api" });
        }

        const jobId = pathname.split("/")[4];
        const job = store.getJob(jobId);
        if (!job) {
          logger.warn("api_get_job_not_found", { jobId });
          return sendJson(response, 404, { ok: false, error: "job_not_found" });
        }

        logger.debug("api_get_job", {
          jobId,
          status: job.status,
          username: job.username
        });
        return sendJson(response, 200, { ok: true, job });
      }

      if (request.method === "GET" && pathname === "/api/twitter-timeline/tweets") {
        if (!isAuthorizedBearer(request, appConfig.apiToken)) {
          logger.warn("api_list_tweets_unauthorized", { pathname });
          return sendJson(response, 401, { ok: false, error: "unauthorized_api" });
        }

        const tweets = store.listTweets({
          username: normalizeUsername(requestUrl.searchParams.get("username")),
          jobId: requestUrl.searchParams.get("jobId") || null,
          limit: clampNumber(requestUrl.searchParams.get("limit"), 1, 500, 100)
        });
        logger.debug("api_list_tweets", {
          count: tweets.length,
          username: requestUrl.searchParams.get("username") || null,
          jobId: requestUrl.searchParams.get("jobId") || null
        });
        return sendJson(response, 200, { ok: true, tweets });
      }

      logger.warn("request_not_found", {
        method: request.method,
        pathname
      });
      return sendJson(response, 404, { ok: false, error: "not_found" });
    } catch (error) {
      logger.error("request_failed", {
        method: request.method,
        url: request.url,
        error: error && error.message || String(error)
      });
      return sendJson(response, 500, {
        ok: false,
        error: error && error.message || String(error)
      });
    } finally {
      logger.debug("request_end", {
        method: request.method,
        url: request.url,
        durationMs: Date.now() - startedAt
      });
    }
  });

  function createTargetJob(target, triggerType, runDate) {
    const previousCompletedAt = store.getLastCompletedJobCreatedAt(target.username);
    const sinceTime = previousCompletedAt
      || new Date(now().getTime() - DAY_MS).toISOString();
    return store.createJob({
      jobId: randomUUID(),
      targetId: target.targetId,
      username: target.username,
      sinceTime,
      maxTweets: target.maxTweets,
      triggerType,
      runDate
    });
  }

  function createScheduledJobs(runDate, source) {
    const targets = store.listTargets({ enabledOnly: true });
    let createdCount = 0;
    for (const target of targets) {
      const existingJobs = store.listJobs({
        username: target.username,
        runDate,
        triggerType: "scheduled",
        limit: 1
      });
      if (existingJobs.some((job) => job.targetId === target.targetId)) {
        continue;
      }
      const previousCompletedAt = store.getLastCompletedJobCreatedAt(target.username);
      const sinceTime = previousCompletedAt
        || new Date(now().getTime() - DAY_MS).toISOString();
      store.ensureScheduledJob({
        jobId: randomUUID(),
        targetId: target.targetId,
        username: target.username,
        sinceTime,
        maxTweets: target.maxTweets,
        runDate
      });
      createdCount += 1;
    }
    logger.info("scheduled_jobs_ready", {
      runDate,
      source,
      enabledTargets: targets.length,
      createdJobs: createdCount
    });
    dispatchNextQueuedJob();
  }

  function handleExtensionEvents(request, response) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });

    const client = {
      id: randomUUID(),
      response,
      lastHeartbeatAt: new Date().toISOString(),
      heartbeatId: setInterval(() => {
        try {
          response.write(serializeSseEvent("heartbeat", {
            time: new Date().toISOString(),
            activeJobId
          }));
          logger.debug("extension_sse_heartbeat_sent", {
            clientId: client.id,
            activeJobId
          });
        } catch (_error) {
          logger.warn("extension_sse_heartbeat_failed", {
            clientId: client.id
          });
          cleanup();
        }
      }, SSE_HEARTBEAT_INTERVAL_MS)
    };
    response.write(serializeSseEvent("bridge_ready", {
      ok: true,
      clientId: client.id,
      connectedAt: new Date().toISOString()
    }));
    clients.add(client);
    logger.info("extension_sse_connected", {
      clientId: client.id,
      activeClients: clients.size
    });
    dispatchNextQueuedJob();

    const cleanup = () => {
      clearInterval(client.heartbeatId);
      clients.delete(client);
      logger.info("extension_sse_disconnected", {
        clientId: client.id,
        activeClients: clients.size,
        activeJobId
      });
      if (!shuttingDown && activeLeaseClientId === client.id && activeJobId) {
        failActiveJob("extension_disconnected", "Extension SSE client disconnected during an active job.");
      }
      try {
        response.end();
      } catch (_error) {
        // ignore
      }
    };

    request.on("close", cleanup);
  }

  function dispatchNextQueuedJob() {
    if (activeJobId || clients.size === 0) {
      logger.debug("dispatch_skipped", {
        reason: activeJobId ? "active_job_exists" : "no_extension_clients",
        activeJobId,
        extensionClients: clients.size
      });
      return;
    }

    const nextJob = store.getNextQueuedJob();
    if (!nextJob) {
      logger.debug("dispatch_skipped", {
        reason: "no_queued_job"
      });
      return;
    }

    const client = getPrimaryClient(clients);
    if (!client) {
      logger.warn("dispatch_skipped", {
        reason: "no_primary_client"
      });
      return;
    }

    activeJobId = nextJob.jobId;
    activeLeaseClientId = client.id;
    const dispatchedJob = store.updateJobStatus(nextJob.jobId, { status: "dispatched" });
    const payload = {
      jobId: dispatchedJob.jobId,
      username: dispatchedJob.username,
      sinceTime: dispatchedJob.sinceTime,
      maxTweets: dispatchedJob.maxTweets
    };

    try {
      logger.info("dispatch_start", {
        jobId: dispatchedJob.jobId,
        clientId: client.id,
        username: dispatchedJob.username
      });
      client.response.write(serializeSseEvent("collect_timeline", payload));
      scheduleDispatchTimeout(dispatchedJob.jobId);
      logger.info("dispatch_sent", {
        jobId: dispatchedJob.jobId,
        clientId: client.id
      });
    } catch (_error) {
      clearInterval(client.heartbeatId);
      clients.delete(client);
      logger.error("dispatch_write_failed", {
        jobId: dispatchedJob.jobId,
        clientId: client.id
      });
      failActiveJob("dispatch_write_failed", "Failed to deliver collect_timeline event to the extension.");
    }
  }

  function scheduleDispatchTimeout(jobId) {
    clearDispatchTimeout();
    logger.debug("dispatch_timeout_scheduled", {
      jobId,
      timeoutMs: appConfig.dispatchTimeoutMs
    });
    dispatchTimeoutId = setTimeout(() => {
      if (activeJobId !== jobId) {
        return;
      }

      logger.warn("dispatch_timeout_triggered", {
        jobId
      });
      failActiveJob("dispatch_timeout", "Extension did not complete the dispatched job in time.");
    }, appConfig.dispatchTimeoutMs);
  }

  function refreshActiveDispatchTimeout(jobId, source) {
    if (!jobId || activeJobId !== jobId) {
      return;
    }

    logger.debug("dispatch_timeout_refreshed", {
      jobId,
      source,
      timeoutMs: appConfig.dispatchTimeoutMs
    });
    scheduleDispatchTimeout(jobId);
  }

  function clearDispatchTimeout() {
    if (!dispatchTimeoutId) {
      return;
    }

    clearTimeout(dispatchTimeoutId);
    dispatchTimeoutId = null;
  }

  function clearActiveLease(jobId) {
    if (!activeJobId || activeJobId !== jobId) {
      return;
    }

    logger.info("active_lease_cleared", {
      jobId,
      clientId: activeLeaseClientId
    });
    activeJobId = null;
    activeLeaseClientId = null;
    clearDispatchTimeout();
  }

  function failActiveJob(stopReason, message) {
    if (!activeJobId) {
      return;
    }

    const failedJobId = activeJobId;
    logger.error("active_job_failed", {
      jobId: failedJobId,
      stopReason,
      message
    });
    store.updateJobStatus(failedJobId, {
      status: "failed",
      stopReason,
      errors: [{ message }]
    });
    clearActiveLease(failedJobId);
    dispatchNextQueuedJob();
  }

  return {
    config: appConfig,
    store,
    server,
    scheduler,
    async listen() {
      await new Promise((resolve) => {
        server.listen(appConfig.port, appConfig.host, () => {
          logger.info("server_listening", {
            host: appConfig.host,
            port: appConfig.port
          });
          resolve();
        });
      });
      await scheduler.start();
      return server.address();
    },
    close() {
      return new Promise((resolve, reject) => {
        shuttingDown = true;
        scheduler.stop();
        logger.info("server_shutdown_start", {
          activeClients: clients.size,
          activeJobId
        });
        for (const client of clients) {
          clearInterval(client.heartbeatId);
          try {
            client.response.end();
          } catch (_error) {
            // ignore
          }
        }
        clients.clear();
        clearDispatchTimeout();
        server.close((error) => {
          if (error) {
            logger.error("server_shutdown_failed", {
              error: error && error.message || String(error)
            });
            reject(error);
            return;
          }

          if (typeof store.close === "function") {
            store.close();
          }
          logger.info("server_shutdown_complete");
          resolve();
        });
      });
    }
  };
}

function getPrimaryClient(clients) {
  return Array.from(clients).sort((left, right) => left.id.localeCompare(right.id))[0] || null;
}

function findClientById(clients, clientId) {
  return Array.from(clients).find((client) => client.id === clientId) || null;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    ...createCorsHeaders()
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendNoContent(response, statusCode) {
  response.writeHead(statusCode, {
    ...createCorsHeaders()
  });
  response.end();
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const bodyText = Buffer.concat(chunks).toString("utf8");
  return bodyText ? JSON.parse(bodyText) : {};
}

function isAuthorizedBearer(request, expectedToken) {
  const header = request.headers.authorization || "";
  return header === `Bearer ${expectedToken}`;
}

function isAuthorizedExtensionRequest(requestUrl, request, expectedToken) {
  return requestUrl.searchParams.get("token") === expectedToken
    || isAuthorizedBearer(request, expectedToken);
}

function serializeSseEvent(name, payload) {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function clampNumber(value, min, max, fallback) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.floor(numberValue)));
}

function normalizeUsername(value) {
  const normalized = String(value || "").replace(/^@/, "").trim().toLowerCase();
  return /^[a-z0-9_]{1,15}$/i.test(normalized) ? normalized : "";
}

function normalizeIsoDate(value) {
  if (!value) {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function normalizeRequestedSinceTime(payload) {
  if (payload && payload.sinceTime !== undefined) {
    return normalizeIsoDate(payload.sinceTime);
  }

  if (payload && payload.startTime !== undefined) {
    return normalizeIsoDate(payload.startTime);
  }

  return null;
}

function normalizeStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["queued", "dispatched", "collecting", "completed", "failed", "cancelled"].includes(normalized)
    ? normalized
    : null;
}

function normalizeDateKey(value) {
  const normalized = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null;
}

function normalizeTriggerType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["manual", "scheduled"].includes(normalized) ? normalized : null;
}

function normalizeDisplayName(value) {
  const normalized = String(value || "").trim();
  return normalized ? normalized.slice(0, 100) : null;
}

function isScheduleTime(value) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || ""));
}

function toPublicSettings(settings) {
  return {
    scheduleTime: settings.scheduleTime,
    timeZone: "Asia/Shanghai"
  };
}

function isTerminalStatus(status) {
  return status === "completed" || status === "failed";
}

function createCorsHeaders() {
  return {
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS"
  };
}

function applyCors(request, response, allowedOrigins = []) {
  const origin = request.headers.origin;
  if (!origin) {
    return true;
  }
  if (!allowedOrigins.includes(origin)) {
    return false;
  }
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  return true;
}

if (require.main === module) {
  const app = createApp();
  app.listen().then(() => {
    console.log(`Twitter Timeline API listening on http://${app.config.host}:${app.config.port}`);
  });
}

module.exports = {
  createApp
};
