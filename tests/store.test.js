const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TimelineStore } = require("../support/api/twitter-timeline/store");

test("persists targets, settings, scheduled jobs, and daily statistics", () => {
  const databasePath = path.join(os.tmpdir(), `twitter-timeline-store-${Date.now()}.sqlite`);
  const store = new TimelineStore(databasePath, { scheduleTime: "08:30" });
  try {
    const target = store.createTarget({
      targetId: "target-1",
      username: "openai",
      displayName: "OpenAI",
      maxTweets: 120,
      enabled: true
    });
    assert.equal(target.displayName, "OpenAI");
    assert.equal(store.listTargets({ enabledOnly: true }).length, 1);
    store.updateTarget(target.targetId, { ...target, enabled: false, maxTweets: 80 });
    assert.equal(store.getTarget(target.targetId).enabled, false);

    assert.equal(store.getSettings().scheduleTime, "08:30");
    store.updateSettings({ scheduleTime: "10:45" });
    assert.equal(store.getSettings().scheduleTime, "10:45");

    const input = {
      jobId: "job-1",
      targetId: target.targetId,
      username: target.username,
      sinceTime: "2026-07-18T01:00:00.000Z",
      maxTweets: 80,
      runDate: "2026-07-19"
    };
    const job = store.ensureScheduledJob(input);
    const duplicate = store.ensureScheduledJob({ ...input, jobId: "job-2" });
    assert.equal(duplicate.jobId, job.jobId);
    store.completeJob(job.jobId, {
      status: "completed",
      username: target.username,
      tweets: [{ id: "tweet-1", text: "hello", createdAt: "2026-07-19T02:00:00.000Z" }],
      capturedAt: "2026-07-19T02:05:00.000Z"
    });
    assert.equal(store.getLastCompletedJobCreatedAt(target.username), job.createdAt);
    assert.equal(store.listJobs({ runDate: "2026-07-19" }).length, 1);
    assert.equal(store.listTweets({ jobId: job.jobId })[0].text, "hello");
    assert.deepEqual(store.getStats("2026-07-19"), {
      totalTargets: 1,
      enabledTargets: 0,
      totalJobs: 1,
      todayJobs: 1,
      failedJobs: 0,
      totalTweets: 1
    });
  } finally {
    store.close();
    removeDatabase(databasePath);
  }
});

function removeDatabase(databasePath) {
  for (const candidate of [databasePath, `${databasePath}-shm`, `${databasePath}-wal`]) {
    fs.rmSync(candidate, { force: true });
  }
}
