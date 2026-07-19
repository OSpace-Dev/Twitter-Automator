const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

class TimelineStore {
  constructor(databasePath, defaultSettings = {}) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.migrate();
    this.initializeSettings(defaultSettings);
    this.prepare();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        until_date TEXT,
        max_tweets INTEGER NOT NULL,
        max_scrolls INTEGER NOT NULL,
        status TEXT NOT NULL,
        stop_reason TEXT,
        page_url TEXT,
        active_username TEXT,
        tweet_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        dispatched_at TEXT,
        completed_at TEXT,
        error_json TEXT,
        result_json TEXT
      );

      CREATE TABLE IF NOT EXISTS tweets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        username TEXT NOT NULL,
        tweet_id TEXT NOT NULL,
        tweet_created_at TEXT,
        author_username TEXT,
        text TEXT,
        url TEXT,
        metrics_json TEXT NOT NULL,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        text_source TEXT,
        captured_at TEXT,
        source_url TEXT,
        UNIQUE(job_id, tweet_id)
      );

      CREATE TABLE IF NOT EXISTS targets (
        target_id TEXT PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        display_name TEXT,
        max_tweets INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const jobColumns = new Set(
      this.db.prepare("PRAGMA table_info(jobs)").all().map((column) => column.name)
    );
    if (!jobColumns.has("target_id")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN target_id TEXT");
    }
    if (!jobColumns.has("trigger_type")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN trigger_type TEXT NOT NULL DEFAULT 'manual'");
    }
    if (!jobColumns.has("run_date")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN run_date TEXT");
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_jobs_status_created
      ON jobs(status, created_at);

      CREATE INDEX IF NOT EXISTS idx_jobs_run_date_created
      ON jobs(run_date DESC, created_at DESC);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_scheduled_target_date
      ON jobs(target_id, run_date)
      WHERE trigger_type = 'scheduled' AND target_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_tweets_username_created
      ON tweets(username, tweet_created_at DESC);
    `);
  }

  initializeSettings(defaultSettings) {
    const statement = this.db.prepare(`
      INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    `);
    statement.run(
      "schedule_time",
      defaultSettings.scheduleTime || "09:00",
      new Date().toISOString()
    );
  }

  prepare() {
    this.insertJobStatement = this.db.prepare(`
      INSERT INTO jobs (
        job_id, username, until_date, max_tweets, max_scrolls, status,
        created_at, updated_at, target_id, trigger_type, run_date
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.updateJobStatusStatement = this.db.prepare(`
      UPDATE jobs
      SET status = ?, updated_at = ?, page_url = COALESCE(?, page_url),
        active_username = COALESCE(?, active_username),
        error_json = COALESCE(?, error_json),
        result_json = COALESCE(?, result_json),
        stop_reason = COALESCE(?, stop_reason),
        dispatched_at = CASE WHEN ? IS NOT NULL THEN ? ELSE dispatched_at END,
        completed_at = CASE WHEN ? IS NOT NULL THEN ? ELSE completed_at END,
        tweet_count = COALESCE(?, tweet_count)
      WHERE job_id = ?
    `);
    this.selectJobStatement = this.db.prepare("SELECT * FROM jobs WHERE job_id = ?");
    this.selectNextQueuedJobStatement = this.db.prepare(`
      SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1
    `);
    this.selectJobsStatement = this.db.prepare(`
      SELECT * FROM jobs
      WHERE (? IS NULL OR username = ?)
        AND (? IS NULL OR status = ?)
        AND (? IS NULL OR run_date = ?)
        AND (? IS NULL OR trigger_type = ?)
      ORDER BY created_at DESC
      LIMIT ?
    `);
    this.insertTweetStatement = this.db.prepare(`
      INSERT OR REPLACE INTO tweets (
        job_id, username, tweet_id, tweet_created_at, author_username, text, url,
        metrics_json, is_pinned, text_source, captured_at, source_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.selectTweetsStatement = this.db.prepare(`
      SELECT * FROM tweets
      WHERE username = COALESCE(?, username)
        AND job_id = COALESCE(?, job_id)
      ORDER BY tweet_created_at DESC, id DESC
      LIMIT ?
    `);
    this.insertTargetStatement = this.db.prepare(`
      INSERT INTO targets (
        target_id, username, display_name, max_tweets, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.updateTargetStatement = this.db.prepare(`
      UPDATE targets
      SET username = ?, display_name = ?, max_tweets = ?, enabled = ?, updated_at = ?
      WHERE target_id = ?
    `);
    this.deleteTargetStatement = this.db.prepare("DELETE FROM targets WHERE target_id = ?");
    this.upsertSettingStatement = this.db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
  }

  createJob(input) {
    const now = new Date().toISOString();
    this.insertJobStatement.run(
      input.jobId,
      input.username,
      input.sinceTime || null,
      input.maxTweets,
      input.safetyScrollCap || 0,
      "queued",
      now,
      now,
      input.targetId || null,
      input.triggerType || "manual",
      input.runDate || null
    );
    return this.getJob(input.jobId);
  }

  ensureScheduledJob(input) {
    const existing = this.db.prepare(`
      SELECT * FROM jobs
      WHERE target_id = ? AND run_date = ? AND trigger_type = 'scheduled'
      LIMIT 1
    `).get(input.targetId, input.runDate);
    return existing ? hydrateJob(existing) : this.createJob({ ...input, triggerType: "scheduled" });
  }

  getJob(jobId) {
    const row = this.selectJobStatement.get(jobId);
    return row ? hydrateJob(row) : null;
  }

  getNextQueuedJob() {
    const row = this.selectNextQueuedJobStatement.get();
    return row ? hydrateJob(row) : null;
  }

  getLastCompletedJobCreatedAt(username) {
    const row = this.db.prepare(`
      SELECT created_at AS createdAt FROM jobs
      WHERE username = ? AND status = 'completed'
      ORDER BY created_at DESC LIMIT 1
    `).get(username);
    return row?.createdAt || null;
  }

  listJobs(query = {}) {
    const username = query.username || null;
    const status = query.status || null;
    const runDate = query.runDate || null;
    const triggerType = query.triggerType || null;
    const limit = Number.isFinite(query.limit) ? query.limit : 50;
    return this.selectJobsStatement.all(
      username, username,
      status, status,
      runDate, runDate,
      triggerType, triggerType,
      limit
    ).map(hydrateJob);
  }

  updateJobStatus(jobId, patch) {
    const now = new Date().toISOString();
    const errorJson = patch.errors ? JSON.stringify(patch.errors) : null;
    const resultJson = patch.result ? JSON.stringify(patch.result) : null;
    const dispatchedAt = patch.status === "dispatched" ? now : null;
    const completedAt = isTerminalStatus(patch.status) ? now : null;
    this.updateJobStatusStatement.run(
      patch.status,
      now,
      patch.pageUrl || null,
      patch.activeUsername || null,
      errorJson,
      resultJson,
      patch.stopReason || null,
      dispatchedAt,
      dispatchedAt,
      completedAt,
      completedAt,
      Number.isFinite(patch.tweetCount) ? patch.tweetCount : null,
      jobId
    );
    return this.getJob(jobId);
  }

  completeJob(jobId, payload) {
    const tweets = Array.isArray(payload.tweets) ? payload.tweets : [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const tweet of tweets) {
        this.insertTweetStatement.run(
          jobId,
          payload.username,
          String(tweet.id || ""),
          tweet.createdAt || null,
          tweet.authorUsername || null,
          tweet.text || "",
          tweet.url || null,
          JSON.stringify(tweet.metrics || {}),
          tweet.isPinned ? 1 : 0,
          tweet.textSource || null,
          payload.capturedAt || new Date().toISOString(),
          payload.sourceUrl || null
        );
      }
      const job = this.updateJobStatus(jobId, {
        status: payload.status || "completed",
        pageUrl: payload.pageUrl || null,
        activeUsername: payload.activeUsername || payload.username,
        stopReason: payload.stopReason || null,
        tweetCount: tweets.length,
        errors: payload.errors || [],
        result: {
          captures: payload.captureCount || 0,
          collection: payload.collection || null
        }
      });
      this.db.exec("COMMIT");
      return job;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listTweets(query = {}) {
    const username = query.username || null;
    const jobId = query.jobId || null;
    const limit = Number.isFinite(query.limit) ? query.limit : 100;
    return this.selectTweetsStatement.all(username, jobId, limit).map(hydrateTweet);
  }

  createTarget(input) {
    const now = new Date().toISOString();
    this.insertTargetStatement.run(
      input.targetId,
      input.username,
      input.displayName || null,
      input.maxTweets,
      input.enabled ? 1 : 0,
      now,
      now
    );
    return this.getTarget(input.targetId);
  }

  getTarget(targetId) {
    const row = this.db.prepare("SELECT * FROM targets WHERE target_id = ?").get(targetId);
    return row ? hydrateTarget(row) : null;
  }

  getTargetByUsername(username) {
    const row = this.db.prepare(`
      SELECT * FROM targets WHERE username = ? COLLATE NOCASE LIMIT 1
    `).get(username);
    return row ? hydrateTarget(row) : null;
  }

  listTargets({ enabledOnly = false } = {}) {
    const rows = enabledOnly
      ? this.db.prepare("SELECT * FROM targets WHERE enabled = 1 ORDER BY username ASC").all()
      : this.db.prepare("SELECT * FROM targets ORDER BY created_at DESC").all();
    return rows.map(hydrateTarget);
  }

  updateTarget(targetId, input) {
    this.updateTargetStatement.run(
      input.username,
      input.displayName || null,
      input.maxTweets,
      input.enabled ? 1 : 0,
      new Date().toISOString(),
      targetId
    );
    return this.getTarget(targetId);
  }

  deleteTarget(targetId) {
    return this.deleteTargetStatement.run(targetId).changes > 0;
  }

  getSettings() {
    const values = Object.fromEntries(
      this.db.prepare("SELECT key, value FROM settings").all().map((row) => [row.key, row.value])
    );
    return { scheduleTime: values.schedule_time || "09:00" };
  }

  updateSettings(settings) {
    this.upsertSettingStatement.run(
      "schedule_time",
      settings.scheduleTime,
      new Date().toISOString()
    );
    return this.getSettings();
  }

  getStats(today) {
    const targetStats = this.db.prepare(`
      SELECT COUNT(*) AS totalTargets,
        SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabledTargets
      FROM targets
    `).get();
    const jobStats = this.db.prepare(`
      SELECT COUNT(*) AS totalJobs,
        SUM(CASE WHEN run_date = ? THEN 1 ELSE 0 END) AS todayJobs,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedJobs
      FROM jobs
    `).get(today);
    const tweetStats = this.db.prepare("SELECT COUNT(*) AS totalTweets FROM tweets").get();
    return {
      totalTargets: Number(targetStats.totalTargets || 0),
      enabledTargets: Number(targetStats.enabledTargets || 0),
      totalJobs: Number(jobStats.totalJobs || 0),
      todayJobs: Number(jobStats.todayJobs || 0),
      failedJobs: Number(jobStats.failedJobs || 0),
      totalTweets: Number(tweetStats.totalTweets || 0)
    };
  }

  close() {
    this.db.close();
  }
}

function hydrateJob(row) {
  return {
    jobId: row.job_id,
    targetId: row.target_id || null,
    username: row.username,
    sinceTime: row.until_date,
    maxTweets: row.max_tweets,
    triggerType: row.trigger_type || "manual",
    runDate: row.run_date || null,
    status: row.status,
    stopReason: row.stop_reason,
    pageUrl: row.page_url,
    activeUsername: row.active_username,
    tweetCount: row.tweet_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dispatchedAt: row.dispatched_at,
    completedAt: row.completed_at,
    errors: parseJson(row.error_json, []),
    result: parseJson(row.result_json, null)
  };
}

function hydrateTarget(row) {
  return {
    targetId: row.target_id,
    username: row.username,
    displayName: row.display_name,
    maxTweets: row.max_tweets,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function hydrateTweet(row) {
  return {
    jobId: row.job_id,
    username: row.username,
    id: row.tweet_id,
    createdAt: row.tweet_created_at,
    authorUsername: row.author_username,
    text: row.text,
    url: row.url,
    metrics: parseJson(row.metrics_json, {}),
    isPinned: Boolean(row.is_pinned),
    textSource: row.text_source,
    capturedAt: row.captured_at,
    sourceUrl: row.source_url
  };
}

function parseJson(value, fallback) {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function isTerminalStatus(status) {
  return status === "completed" || status === "failed";
}

module.exports = { TimelineStore };
