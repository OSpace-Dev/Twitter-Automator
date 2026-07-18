const LEVEL_PRIORITY = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const DEFAULT_SCOPE = "twitter-timeline-api";
const DEFAULT_LEVEL = normalizeLevel(process.env.TWITTER_TIMELINE_LOG_LEVEL || "info");

function createLogger(scope = DEFAULT_SCOPE, options = {}) {
  const loggerScope = scope || DEFAULT_SCOPE;
  const level = normalizeLevel(options.level || DEFAULT_LEVEL);
  const stream = options.stream || process.stdout;
  const errorStream = options.errorStream || process.stderr;

  return {
    debug(event, details) {
      writeLog("debug", event, details, loggerScope, level, stream, errorStream);
    },
    info(event, details) {
      writeLog("info", event, details, loggerScope, level, stream, errorStream);
    },
    warn(event, details) {
      writeLog("warn", event, details, loggerScope, level, stream, errorStream);
    },
    error(event, details) {
      writeLog("error", event, details, loggerScope, level, stream, errorStream);
    },
    child(childScope) {
      return createLogger(childScope ? `${loggerScope}:${childScope}` : loggerScope, {
        level,
        stream,
        errorStream
      });
    }
  };
}

function writeLog(level, event, details, scope, currentLevel, stream, errorStream) {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[currentLevel]) {
    return;
  }

  const payload = sanitizeDetails(details);
  const line = [
    `[${new Date().toISOString()}]`,
    level.toUpperCase().padEnd(5, " "),
    `[${scope}]`,
    event
  ].join(" ");

  const text = payload
    ? `${line} ${formatDetails(payload)}`
    : line;

  if (level === "warn" || level === "error") {
    errorStream.write(`${text}\n`);
    return;
  }

  stream.write(`${text}\n`);
}

function formatDetails(details) {
  const entries = Object.entries(details);
  if (!entries.length) {
    return "";
  }

  return entries.map(([key, value]) => `${key}=${stringifyValue(value)}`).join(" ");
}

function stringifyValue(value) {
  if (value === null) {
    return "null";
  }

  if (value === undefined) {
    return "undefined";
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}

function sanitizeDetails(details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return details ? { value: details } : null;
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(details)) {
    sanitized[key] = normalizeDetailValue(value);
  }

  return sanitized;
}

function normalizeDetailValue(value) {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack
    };
  }

  if (Array.isArray(value)) {
    return value.map(normalizeDetailValue);
  }

  if (value && typeof value === "object") {
    const normalized = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      normalized[key] = normalizeDetailValue(nestedValue);
    }
    return normalized;
  }

  return value;
}

function normalizeLevel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVEL_PRIORITY, normalized)
    ? normalized
    : "info";
}

module.exports = {
  createLogger
};
