const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const scriptPath = path.join(__dirname, "..", "content-script.js");
const scriptCode = fs.readFileSync(scriptPath, "utf8");

let domCallCount = 0;
let scheduledTimer = null;
const runtimeMessages = [];
const windowMessageListeners = [];
const runtimeMessageListeners = [];

const apiTweet = {
  id: "2064409694761054332",
  createdAt: "2026-06-21T05:10:37.000Z",
  createdAtRaw: "Sat Jun 21 05:10:37 +0000 2026",
  authorUsername: "karpathy",
  text: "Free your mind. ".repeat(60),
  url: "https://x.com/karpathy/status/2064409694761054332",
  metrics: {
    replies: 10,
    reposts: 20,
    quotes: 3,
    likes: 99,
    bookmarks: 5,
    views: 12345
  },
  isPinned: false,
  textSource: "note_tweet"
};

const domTweet = {
  id: "2064409694761054332",
  createdAt: "2026-06-21T05:10:37.000Z",
  createdAtRaw: "2026-06-21T05:10:37.000Z",
  authorUsername: "karpathy",
  text: "Free your mind.",
  url: "https://x.com/karpathy/status/2064409694761054332",
  metrics: {
    replies: 0,
    reposts: 0,
    quotes: 0,
    likes: 0,
    bookmarks: 0,
    views: 0
  },
  isPinned: false,
  textSource: "dom_text"
};

const parser = {
  extractUsernameFromUrl(url) {
    return /x\.com\/([^/?#]+)/.exec(url)?.[1] || "";
  },
  parseTimelinePayload(payload) {
    return payload === "api_payload" ? [apiTweet] : [];
  },
  parseTweetsFromDom() {
    domCallCount += 1;
    return domCallCount >= 2 ? [domTweet] : [];
  }
};

const documentMock = {
  documentElement: {
    appendChild(node) {
      if (typeof node.onload === "function") {
        node.onload();
      }
      return node;
    }
  },
  head: null,
  body: {
    scrollHeight: 4000,
    clientHeight: 1200
  },
  scrollingElement: {
    scrollHeight: 4000,
    clientHeight: 1200
  },
  createElement(tagName) {
    return {
      tagName,
      async: false,
      src: "",
      onload: null,
      remove() {}
    };
  },
  addEventListener() {},
  querySelector(selector) {
    if (selector === "main") {
      return null;
    }

    return null;
  }
};

const windowMock = {
  innerHeight: 1000,
  pageYOffset: 0,
  scrollY: 0,
  addEventListener(type, listener) {
    if (type === "message") {
      windowMessageListeners.push(listener);
    }
  },
  setTimeout(callback) {
    scheduledTimer = callback;
    return 1;
  },
  clearTimeout() {
    scheduledTimer = null;
  },
  scrollTo(options) {
    this.scrollY = options.top;
    this.pageYOffset = options.top;
  },
  scrollBy() {}
};

const chromeMock = {
  runtime: {
    getURL(file) {
      return file;
    },
    sendMessage(message) {
      runtimeMessages.push(message);
      return Promise.resolve();
    },
    onMessage: {
      addListener(listener) {
        runtimeMessageListeners.push(listener);
      }
    }
  }
};

const sandbox = {
  console,
  URL,
  Date,
  Math,
  Number,
  String,
  Boolean,
  Array,
  Object,
  Map,
  Set,
  Promise,
  chrome: chromeMock,
  document: documentMock,
  location: {
    href: "https://x.com/karpathy",
    origin: "https://x.com",
    pathname: "/karpathy"
  },
  window: windowMock,
  globalThis: null,
  TwitterTimelineParser: parser
};

sandbox.globalThis = sandbox;
windowMock.window = windowMock;
windowMock.document = documentMock;
windowMock.location = sandbox.location;
windowMock.chrome = chromeMock;

vm.runInNewContext(scriptCode, sandbox, { filename: scriptPath });

assert.strictEqual(windowMessageListeners.length, 1, "should register one window message listener");
assert.strictEqual(runtimeMessageListeners.length, 1, "should register one runtime message listener");

const onRuntimeMessage = runtimeMessageListeners[0];
const onWindowMessage = windowMessageListeners[0];

onRuntimeMessage({
  type: "TWITTER_TIMELINE_START",
  options: {
    username: "karpathy",
    maxTweets: 100,
    scrollDelayMs: 5000
  }
}, null, function noop() {});

assert.ok(typeof scheduledTimer === "function", "should schedule scroll after start");

onWindowMessage({
  source: windowMock,
  data: {
    type: "TWITTER_TIMELINE_USER_TWEETS",
    payload: "api_payload",
    source: "UserTweets",
    capturedAt: "2026-06-21T05:10:37.000Z",
    url: "https://x.com/i/api/graphql/hash/UserTweets"
  }
});

scheduledTimer();

let status = null;
onRuntimeMessage({
  type: "TWITTER_TIMELINE_GET_STATUS"
}, null, function captureStatus(response) {
  status = response;
});

assert.ok(status, "should return collection status");
assert.strictEqual(status.tweets.length, 1, "should keep one merged tweet record");
assert.strictEqual(status.tweets[0].textSource, "note_tweet", "dom fallback must not override richer API text");
assert.strictEqual(status.tweets[0].text, apiTweet.text, "should preserve full note_tweet text");
assert.ok(status.tweets[0].metrics.likes >= apiTweet.metrics.likes, "should preserve richer metrics");
assert.ok(
  runtimeMessages.some(function hasReadyMessage(message) {
    return message.type === "TWITTER_TIMELINE_CONTENT_READY";
  }),
  "should announce content readiness on load"
);

console.log("Content script merge policy preserves richer API tweet text over DOM fallback.");
