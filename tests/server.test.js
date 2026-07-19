const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../support/api/twitter-timeline/server");

test("manages targets, runs a collection, and queries daily history", async () => {
  const databasePath = path.join(os.tmpdir(), `twitter-timeline-server-${Date.now()}.sqlite`);
  const scheduleState = {
    scheduleTime: "09:00",
    timeZone: "Asia/Shanghai",
    nextRunAt: "2026-07-20T01:00:00.000Z"
  };
  const scheduler = {
    async start() {},
    stop() {},
    getState: () => ({ ...scheduleState }),
    reschedule(scheduleTime) {
      scheduleState.scheduleTime = scheduleTime;
      scheduleState.nextRunAt = "2026-07-20T02:30:00.000Z";
      return this.getState();
    }
  };
  const logger = Object.fromEntries(["debug", "info", "warn", "error"].map((name) => [name, () => {}]));
  const app = createApp({
    host: "127.0.0.1",
    port: 0,
    databasePath,
    apiToken: "api-test-token",
    extensionToken: "extension-test-token",
    adminOrigins: ["http://127.0.0.1:17331"],
    scheduler,
    logger,
    now: () => new Date("2026-07-19T04:00:00.000Z")
  });
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const createTargetResponse = await fetch(`${baseUrl}/api/twitter-timeline/targets`, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({
        username: "@openai",
        displayName: "OpenAI",
        maxTweets: 120,
        enabled: true
      })
    });
    assert.equal(createTargetResponse.status, 201);
    const createdTarget = (await createTargetResponse.json()).target;
    assert.equal(createdTarget.username, "openai");

    const targetsResponse = await fetch(`${baseUrl}/api/twitter-timeline/targets`, {
      headers: apiHeaders("http://127.0.0.1:17331")
    });
    assert.equal(targetsResponse.headers.get("access-control-allow-origin"), "http://127.0.0.1:17331");
    assert.equal((await targetsResponse.json()).targets.length, 1);

    const eventPromise = readSseEvent(
      `${baseUrl}/extension/events?token=extension-test-token`,
      "collect_timeline"
    );
    const runResponse = await fetch(
      `${baseUrl}/api/twitter-timeline/targets/${createdTarget.targetId}/run`,
      { method: "POST", headers: apiHeaders(), body: "{}" }
    );
    assert.equal(runResponse.status, 201);
    const runJob = (await runResponse.json()).job;
    assert.equal(runJob.runDate, "2026-07-19");
    assert.equal(runJob.triggerType, "manual");
    assert.equal(runJob.sinceTime, "2026-07-18T04:00:00.000Z");

    const collectEvent = await eventPromise;
    assert.equal(collectEvent.data.jobId, runJob.jobId);
    assert.equal(collectEvent.data.username, "openai");
    assert.equal(collectEvent.data.maxTweets, 120);

    const resultResponse = await fetch(
      `${baseUrl}/extension/jobs/${runJob.jobId}/result`,
      {
        method: "POST",
        headers: extensionHeaders(),
        body: JSON.stringify({
          status: "completed",
          activeUsername: "openai",
          capturedAt: "2026-07-19T04:05:00.000Z",
          tweets: [{
            id: "tweet-1",
            createdAt: "2026-07-19T03:30:00.000Z",
            authorUsername: "openai",
            text: "Daily update",
            metrics: { likes: 12 }
          }]
        })
      }
    );
    assert.equal(resultResponse.status, 200);

    const jobsResponse = await fetch(
      `${baseUrl}/api/twitter-timeline/jobs?date=2026-07-19&username=openai`,
      { headers: apiHeaders() }
    );
    const jobs = (await jobsResponse.json()).jobs;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, "completed");

    const tweetsResponse = await fetch(
      `${baseUrl}/api/twitter-timeline/tweets?jobId=${runJob.jobId}`,
      { headers: apiHeaders() }
    );
    assert.equal((await tweetsResponse.json()).tweets[0].text, "Daily update");

    const statsResponse = await fetch(`${baseUrl}/api/twitter-timeline/stats`, {
      headers: apiHeaders()
    });
    const stats = (await statsResponse.json()).stats;
    assert.equal(stats.totalTargets, 1);
    assert.equal(stats.todayJobs, 1);
    assert.equal(stats.totalTweets, 1);

    const settingsResponse = await fetch(`${baseUrl}/api/twitter-timeline/settings`, {
      method: "PUT",
      headers: apiHeaders(),
      body: JSON.stringify({ scheduleTime: "10:30" })
    });
    assert.equal(settingsResponse.status, 200);
    assert.equal((await settingsResponse.json()).settings.scheduleTime, "10:30");

    const disableResponse = await fetch(
      `${baseUrl}/api/twitter-timeline/targets/${createdTarget.targetId}`,
      {
        method: "PUT",
        headers: apiHeaders(),
        body: JSON.stringify({ enabled: false })
      }
    );
    assert.equal((await disableResponse.json()).target.enabled, false);
    await collectEvent.reader.cancel();
  } finally {
    await app.close();
    removeDatabase(databasePath);
  }
});

test("startup catch-up creates one scheduled job per enabled target and date", async () => {
  const databasePath = path.join(os.tmpdir(), `twitter-timeline-schedule-${Date.now()}.sqlite`);
  const logger = Object.fromEntries(["debug", "info", "warn", "error"].map((name) => [name, () => {}]));
  const options = {
    host: "127.0.0.1",
    port: 0,
    databasePath,
    logger,
    now: () => new Date("2026-07-19T02:00:00.000Z"),
    defaultScheduleTime: "09:00"
  };
  let app = createApp(options);
  try {
    app.store.createTarget({
      targetId: "scheduled-target",
      username: "karpathy",
      displayName: "Andrej Karpathy",
      maxTweets: 100,
      enabled: true
    });
    await app.listen();
    let jobs = app.store.listJobs({ runDate: "2026-07-19", triggerType: "scheduled" });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].sinceTime, "2026-07-18T02:00:00.000Z");
    await app.close();

    app = createApp(options);
    await app.listen();
    jobs = app.store.listJobs({ runDate: "2026-07-19", triggerType: "scheduled" });
    assert.equal(jobs.length, 1);
  } finally {
    if (app.server.listening) {
      await app.close();
    }
    removeDatabase(databasePath);
  }
});

function apiHeaders(origin) {
  return {
    "Content-Type": "application/json",
    Authorization: "Bearer api-test-token",
    ...(origin ? { Origin: origin } : {})
  };
}

function extensionHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: "Bearer extension-test-token"
  };
}

async function readSseEvent(url, expectedEvent) {
  const response = await fetch(url, { headers: { Accept: "text/event-stream" } });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`SSE ended before ${expectedEvent}`);
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";
    for (const chunk of chunks) {
      const lines = chunk.split("\n");
      const eventLine = lines.find((line) => line.startsWith("event: "));
      const dataLine = lines.find((line) => line.startsWith("data: "));
      if (eventLine?.slice(7) === expectedEvent && dataLine) {
        return { reader, data: JSON.parse(dataLine.slice(6)) };
      }
    }
  }
}

function removeDatabase(databasePath) {
  for (const candidate of [databasePath, `${databasePath}-shm`, `${databasePath}-wal`]) {
    fs.rmSync(candidate, { force: true });
  }
}
