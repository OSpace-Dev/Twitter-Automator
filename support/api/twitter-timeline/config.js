const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../../../../../");

function readNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

module.exports = {
  repoRoot,
  host: process.env.TWITTER_TIMELINE_HOST || "0.0.0.0",
  port: readNumber("TWITTER_TIMELINE_PORT", 8001),
  apiToken: process.env.TWITTER_TIMELINE_API_TOKEN || "dev-twitter-timeline-api-token",
  extensionToken: process.env.TWITTER_TIMELINE_EXTENSION_TOKEN || "dev-twitter-timeline-extension-token",
  databasePath: process.env.TWITTER_TIMELINE_DB_PATH
    || path.join(repoRoot, "tmp", "twitter-timeline.sqlite")
};
