const assert = require("assert");
const fs = require("fs");
const path = require("path");
const parser = require("../timeline-parser");

const repoRoot = path.resolve(__dirname, "../../../../..");
const samplePath = path.join(repoRoot, "docs", "something", "1.md");
const sampleMarkdown = fs.readFileSync(samplePath, "utf8");
const payload = extractFirstJsonBlock(sampleMarkdown);
const tweets = parser.parseTimelinePayload(payload, { username: "karpathy" });

assert.ok(parser.isUserTweetsUrl("https://x.com/i/api/graphql/hash/UserTweets?variables={}"));
assert.strictEqual(parser.extractUsernameFromUrl("https://x.com/karpathy"), "karpathy");
assert.ok(tweets.length >= 10, "should parse timeline tweets from sample");

const pinnedTweet = tweets.find((tweet) => tweet.id === "1617979122625712128");
assert.ok(pinnedTweet, "should parse pinned tweet");
assert.strictEqual(pinnedTweet.isPinned, true);
assert.strictEqual(pinnedTweet.text, "The hottest new programming language is English");

const longTweet = tweets.find((tweet) => tweet.id === "2064409694761054332");
assert.ok(longTweet, "should parse note tweet");
assert.strictEqual(longTweet.textSource, "note_tweet");
assert.ok(
  longTweet.text.includes("Free your mind"),
  "should prefer note_tweet text over truncated legacy.full_text"
);
assert.ok(longTweet.text.length > 500, "note tweet text should be complete enough");

const htmlEntityTweet = tweets.find((tweet) => tweet.id === "2056753169888334312");
assert.ok(htmlEntityTweet.text.includes("R&D"), "should decode common HTML entities");

const domTweets = parser.parseTweetsFromDom(createDomRoot(), { username: "karpathy" });
assert.strictEqual(domTweets.length, 1, "should parse visible timeline tweets from DOM fallback");
assert.strictEqual(domTweets[0].id, "1234567890123456789");
assert.strictEqual(domTweets[0].authorUsername, "karpathy");
assert.strictEqual(domTweets[0].textSource, "dom_text");
assert.strictEqual(domTweets[0].isPinned, true);

const localizedPinnedTweets = parser.parseTweetsFromDom(createLocalizedPinnedDomRoot(), { username: "karpathy" });
assert.strictEqual(localizedPinnedTweets.length, 1, "should parse localized pinned tweet from DOM fallback");
assert.strictEqual(localizedPinnedTweets[0].isPinned, true, "localized pinned marker should be recognized");

for (const tweet of tweets) {
  assert.ok(tweet.id, "tweet should have id");
  assert.ok(tweet.createdAt, "tweet should have createdAt");
  assert.strictEqual(tweet.authorUsername, "karpathy");
  assert.ok(tweet.url.startsWith("https://x.com/karpathy/status/"));
  assert.strictEqual(typeof tweet.metrics.likes, "number");
}

console.log(`Parsed ${tweets.length} timeline tweets from sample.`);

function extractFirstJsonBlock(markdown) {
  const match = markdown.match(/```json\s*([\s\S]*?)```/);
  if (!match) {
    throw new Error("No JSON block found in sample markdown.");
  }

  return JSON.parse(match[1]);
}

function createDomRoot() {
  return {
    querySelectorAll(selector) {
      assert.strictEqual(selector, "article");
      return [createTweetArticle()];
    }
  };
}

function createTweetArticle() {
  return {
    innerText: "Pinned tweet\nA visible DOM fallback tweet",
    textContent: "Pinned tweet\nA visible DOM fallback tweet",
    querySelector(selector) {
      if (selector === 'a[href*="/status/"]') {
        return {
          getAttribute(name) {
            assert.strictEqual(name, "href");
            return "/karpathy/status/1234567890123456789";
          }
        };
      }

      if (selector === '[data-testid="tweetText"]') {
        return {
          innerText: "A visible DOM fallback tweet"
        };
      }

      if (selector === "time") {
        return {
          getAttribute(name) {
            assert.strictEqual(name, "datetime");
            return "2026-06-21T10:00:00.000Z";
          }
        };
      }

      return null;
    }
  };
}

function createLocalizedPinnedDomRoot() {
  return {
    querySelectorAll(selector) {
      assert.strictEqual(selector, "article");
      return [{
        innerText: "置顶\n一条中文置顶推文",
        textContent: "置顶\n一条中文置顶推文",
        getAttribute(name) {
          return name === "aria-label" ? "置顶推文" : "";
        },
        querySelector(query) {
          if (query === 'a[href*="/status/"]') {
            return {
              getAttribute(name) {
                assert.strictEqual(name, "href");
                return "/karpathy/status/2234567890123456789";
              }
            };
          }

          if (query === '[data-testid="tweetText"]') {
            return {
              innerText: "一条中文置顶推文"
            };
          }

          if (query === "time") {
            return {
              getAttribute(name) {
                assert.strictEqual(name, "datetime");
                return "2024-01-01T00:00:00.000Z";
              }
            };
          }

          return null;
        }
      }];
    }
  };
}
