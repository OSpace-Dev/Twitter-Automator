const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../../..");
const legacyRepoRoot = path.resolve(__dirname, "../../../../..");

function readNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function resolveDatabasePath() {
  if (process.env.TWITTER_TIMELINE_DB_PATH) {
    return process.env.TWITTER_TIMELINE_DB_PATH;
  }
  const projectPath = path.join(repoRoot, "tmp", "twitter-timeline.sqlite");
  const legacyPath = path.join(legacyRepoRoot, "tmp", "twitter-timeline.sqlite");
  return !fs.existsSync(projectPath) && fs.existsSync(legacyPath)
    ? legacyPath
    : projectPath;
}

module.exports = {
  repoRoot,
  host: process.env.TWITTER_TIMELINE_HOST || "127.0.0.1",
  port: readNumber("TWITTER_TIMELINE_PORT", 8001),
  apiToken: process.env.TWITTER_TIMELINE_API_TOKEN || "dev-twitter-timeline-api-token",
  extensionToken: process.env.TWITTER_TIMELINE_EXTENSION_TOKEN || "dev-twitter-timeline-extension-token",
  databasePath: resolveDatabasePath(),
  defaultScheduleTime: /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(process.env.TWITTER_TIMELINE_SCHEDULE_TIME || "")
    ? process.env.TWITTER_TIMELINE_SCHEDULE_TIME
    : "09:00",
  scheduleTimeZone: "Asia/Shanghai",
  adminOrigins: (process.env.TWITTER_TIMELINE_ADMIN_ORIGINS
    || "http://127.0.0.1:17331,http://localhost:17331")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
};
