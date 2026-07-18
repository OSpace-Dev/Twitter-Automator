const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

class TimelineStore {
  constructor(databasePath) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec([
      "CREATE TABLE IF NOT EXISTS jobs (",
      "  job_id TEXT PRIMARY KEY,",
      "  username TEXT NOT NULL,",
      "  until_date TEXT,",
      "  max_tweets INTEGER NOT NULL,",
      "  max_scrolls INTEGER NOT NULL,",
      "  status TEXT NOT NULL,",
      "  stop_reason TEXT,",
      "  page_url TEXT,",
      "  active_username TEXT,",
      "  tweet_count INTEGER NOT NULL DEFAULT 0,",
      "  created_at TEXT NOT NULL,",
      "  updated_at TEXT NOT NULL,",
      "  dispatched_at TEXT,",
      "  completed_at TEXT,",
      "  error_json TEXT,",
      "  result_json TEXT",
      ")"
    ].join("\n"));
    this.db.exec([
      "CREATE TABLE IF NOT EXISTS tweets (",
      "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
      "  job_id TEXT NOT NULL,",
      "  username TEXT NOT NULL,",
      "  tweet_id TEXT NOT NULL,",
      "  tweet_created_at TEXT,",
      "  author_username TEXT,",
      "  text TEXT,",
      "  url TEXT,",
      "  metrics_json TEXT NOT NULL,",
      "  is_pinned INTEGER NOT NULL DEFAULT 0,",
      "  text_source TEXT,",
      "  captured_at TEXT,",
      "  source_url TEXT,",
      "  UNIQUE(job_id, tweet_id)",
      ")"
    ].join("\n"));

    this.insertJobStatement = this.db.prepare([
      "INSERT INTO jobs (",
      "  job_id, username, until_date, max_tweets, max_scrolls, status, created_at, updated_at",
      ") VALUES (",
      "  ?, ?, ?, ?, ?, ?, ?, ?",
      ")"
    ].join(" "));
    this.updateJobStatusStatement = this.db.prepare([
      "UPDATE jobs",
      "SET status = ?, updated_at = ?, page_url = COALESCE(?, page_url),",
      "  active_username = COALESCE(?, active_username),",
      "  error_json = COALESCE(?, error_json),",
      "  result_json = COALESCE(?, result_json),",
      "  stop_reason = COALESCE(?, stop_reason),",
      "  dispatched_at = CASE WHEN ? IS NOT NULL THEN ? ELSE dispatched_at END,",
      "  completed_at = CASE WHEN ? IS NOT NULL THEN ? ELSE completed_at END,",
      "  tweet_count = COALESCE(?, tweet_count)",
      "WHERE job_id = ?"
    ].join(" "));
    this.selectJobStatement = this.db.prepare("SELECT * FROM jobs WHERE job_id = ?");
    this.selectNextQueuedJobStatement = this.db.prepare([
      "SELECT * FROM jobs",
      "WHERE status = 'queued'",
      "ORDER BY created_at ASC",
      "LIMIT 1"
    ].join(" "));
    this.selectJobsStatement = this.db.prepare([
      "SELECT * FROM jobs",
      "WHERE username = COALESCE(?, username)",
      "  AND status = COALESCE(?, status)",
      "ORDER BY created_at DESC",
      "LIMIT ?"
    ].join(" "));
    this.insertTweetStatement = this.db.prepare([
      "INSERT OR REPLACE INTO tweets (",
      "  job_id, username, tweet_id, tweet_created_at, author_username, text, url,",
      "  metrics_json, is_pinned, text_source, captured_at, source_url",
      ") VALUES (",
      "  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?",
      ")"
    ].join(" "));
    this.selectTweetsStatement = this.db.prepare([
      "SELECT * FROM tweets",
      "WHERE username = COALESCE(?, username)",
      "  AND job_id = COALESCE(?, job_id)",
      "ORDER BY tweet_created_at DESC, id DESC",
      "LIMIT ?"
    ].join(" "));
  }

  createJob(input) {
    const now = new Date().toISOString();
    const record = {
      jobId: input.jobId,
      username: input.username,
      sinceTime: input.sinceTime || null,
      maxTweets: input.maxTweets,
      safetyScrollCap: input.safetyScrollCap || 0,
      status: "queued",
      createdAt: now,
      updatedAt: now
    };

    this.insertJobStatement.run(
      record.jobId,
      record.username,
      record.sinceTime,
      record.maxTweets,
      record.safetyScrollCap,
      record.status,
      record.createdAt,
      record.updatedAt
    );

    return this.getJob(record.jobId);
  }

  getJob(jobId) {
    const row = this.selectJobStatement.get(jobId);
    return row ? hydrateJob(row) : null;
  }

  getNextQueuedJob() {
    const row = this.selectNextQueuedJobStatement.get();
    return row ? hydrateJob(row) : null;
  }

  listJobs(query = {}) {
    const username = query.username || null;
    const status = query.status || null;
    const limit = Number.isFinite(query.limit) ? query.limit : 50;
    const rows = this.selectJobsStatement.all(username, status, limit);
    return rows.map(hydrateJob);
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
    try {
      this.db.exec("BEGIN");
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

  listTweets(query) {
    const username = query.username || null;
    const jobId = query.jobId || null;
    const limit = Number.isFinite(query.limit) ? query.limit : 100;
    const rows = this.selectTweetsStatement.all(username, jobId, limit);
    return rows.map(hydrateTweet);
  }

  close() {
    this.db.close();
  }
}

function hydrateJob(row) {
  return {
    jobId: row.job_id,
    username: row.username,
    sinceTime: row.until_date,
    maxTweets: row.max_tweets,
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

module.exports = {
  TimelineStore
};
