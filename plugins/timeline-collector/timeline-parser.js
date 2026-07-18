(function initTimelineParser(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.TwitterTimelineParser = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function buildTimelineParser() {
  const PINNED_TEXT_MARKERS = [
    "Pinned",
    "置顶",
    "已置顶",
    "置頂",
    "已置頂"
  ];

  const USERNAME_RESERVED_SEGMENTS = new Set([
    "",
    "home",
    "explore",
    "i",
    "messages",
    "notifications",
    "search",
    "settings",
    "compose",
    "login",
    "signup"
  ]);

  function isUserTweetsUrl(url) {
    if (!url || typeof url !== "string") {
      return false;
    }

    try {
      const parsedUrl = new URL(url, "https://x.com");
      return /(^|\.)x\.com$|(^|\.)twitter\.com$/.test(parsedUrl.hostname)
        && parsedUrl.pathname.includes("/i/api/graphql/")
        && parsedUrl.pathname.endsWith("/UserTweets");
    } catch (_error) {
      return false;
    }
  }

  function extractUsernameFromUrl(url) {
    try {
      const parsedUrl = new URL(url);
      if (!/(^|\.)x\.com$|(^|\.)twitter\.com$/.test(parsedUrl.hostname)) {
        return "";
      }

      const segment = parsedUrl.pathname.split("/").filter(Boolean)[0] || "";
      if (USERNAME_RESERVED_SEGMENTS.has(segment.toLowerCase())) {
        return "";
      }

      return /^[A-Za-z0-9_]{1,15}$/.test(segment) ? segment : "";
    } catch (_error) {
      return "";
    }
  }

  function parseTimelinePayload(payload, options) {
    const targetUsername = normalizeUsername(options && options.username);
    const tweetsById = new Map();

    for (const entry of getTimelineEntries(payload)) {
      for (const item of getTimelineItems(entry)) {
        const tweet = normalizeTweetResult(item && item.tweetResult);
        if (!tweet) {
          continue;
        }

        const parsedTweet = toTimelineTweet(tweet, {
          fallbackUsername: targetUsername,
          isPinned: item.isPinned
        });

        if (!parsedTweet || tweetsById.has(parsedTweet.id)) {
          continue;
        }

        if (targetUsername && parsedTweet.authorUsername.toLowerCase() !== targetUsername) {
          continue;
        }

        tweetsById.set(parsedTweet.id, parsedTweet);
      }
    }

    return Array.from(tweetsById.values()).sort(compareTweetsByTimeDesc);
  }

  function parseTweetsFromDom(rootNode, options) {
    const targetUsername = normalizeUsername(options && options.username);
    const scope = rootNode && typeof rootNode.querySelectorAll === "function" ? rootNode : document;
    const articles = Array.from(scope.querySelectorAll("article"));
    const tweetsById = new Map();

    for (const article of articles) {
      const parsedTweet = parseTweetArticle(article, targetUsername);
      if (!parsedTweet || tweetsById.has(parsedTweet.id)) {
        continue;
      }

      tweetsById.set(parsedTweet.id, parsedTweet);
    }

    return Array.from(tweetsById.values()).sort(compareTweetsByTimeDesc);
  }

  function getTimelineEntries(payload) {
    const instructions = payload
      && payload.data
      && payload.data.user
      && payload.data.user.result
      && payload.data.user.result.timeline
      && payload.data.user.result.timeline.timeline
      && payload.data.user.result.timeline.timeline.instructions;

    if (!Array.isArray(instructions)) {
      return [];
    }

    const entries = [];
    for (const instruction of instructions) {
      if (instruction.entry) {
        entries.push({
          entry: instruction.entry,
          instructionType: instruction.type
        });
      }

      if (Array.isArray(instruction.entries)) {
        for (const entry of instruction.entries) {
          entries.push({
            entry,
            instructionType: instruction.type
          });
        }
      }
    }

    return entries;
  }

  function getTimelineItems(entryWrapper) {
    const entry = entryWrapper && entryWrapper.entry;
    const content = entry && entry.content;
    const items = [];

    if (!content) {
      return items;
    }

    const pinnedByContext = entryWrapper.instructionType === "TimelinePinEntry"
      || content.clientEventInfo && content.clientEventInfo.component === "pinned_tweets";

    collectItemContent(content.itemContent, pinnedByContext, items);

    if (Array.isArray(content.items)) {
      for (const moduleItem of content.items) {
        collectItemContent(
          moduleItem && moduleItem.item && moduleItem.item.itemContent,
          pinnedByContext,
          items
        );
      }
    }

    return items;
  }

  function collectItemContent(itemContent, isPinned, items) {
    const tweetResult = itemContent
      && itemContent.tweet_results
      && itemContent.tweet_results.result;

    if (!tweetResult) {
      return;
    }

    items.push({
      tweetResult,
      isPinned: Boolean(isPinned)
    });
  }

  function normalizeTweetResult(result) {
    if (!result || typeof result !== "object") {
      return null;
    }

    if (result.__typename === "TweetWithVisibilityResults") {
      return normalizeTweetResult(result.tweet);
    }

    if (result.__typename && result.__typename !== "Tweet") {
      return null;
    }

    return result.rest_id || result.legacy && result.legacy.id_str ? result : null;
  }

  function toTimelineTweet(tweet, context) {
    const legacy = tweet.legacy || {};
    const id = String(tweet.rest_id || legacy.id_str || "");
    const user = tweet.core
      && tweet.core.user_results
      && tweet.core.user_results.result;
    const authorUsername = getAuthorUsername(user, context.fallbackUsername);

    if (!id || !authorUsername) {
      return null;
    }

    const textInfo = getTweetText(tweet);
    const createdAtIso = parseTwitterDate(legacy.created_at);

    return {
      id,
      createdAt: createdAtIso || legacy.created_at || "",
      createdAtRaw: legacy.created_at || "",
      authorUsername,
      text: textInfo.text,
      url: "https://x.com/" + authorUsername + "/status/" + id,
      metrics: {
        replies: toNumber(legacy.reply_count),
        reposts: toNumber(legacy.retweet_count),
        quotes: toNumber(legacy.quote_count),
        likes: toNumber(legacy.favorite_count),
        bookmarks: toNumber(legacy.bookmark_count),
        views: toNumber(tweet.views && tweet.views.count)
      },
      isPinned: Boolean(context.isPinned),
      textSource: textInfo.source
    };
  }

  function getAuthorUsername(user, fallbackUsername) {
    const username = user
      && (user.core && user.core.screen_name
        || user.legacy && user.legacy.screen_name);

    return username || fallbackUsername || "";
  }

  function getTweetText(tweet) {
    const noteText = tweet.note_tweet
      && tweet.note_tweet.note_tweet_results
      && tweet.note_tweet.note_tweet_results.result
      && tweet.note_tweet.note_tweet_results.result.text;

    if (typeof noteText === "string" && noteText) {
      return {
        text: decodeHtmlEntities(noteText),
        source: "note_tweet"
      };
    }

    const retweetedTweet = normalizeTweetResult(
      tweet.legacy
        && tweet.legacy.retweeted_status_result
        && tweet.legacy.retweeted_status_result.result
    );

    if (retweetedTweet) {
      const retweetedText = getTweetText(retweetedTweet);
      const retweetedAuthor = getAuthorUsername(
        retweetedTweet.core
          && retweetedTweet.core.user_results
          && retweetedTweet.core.user_results.result,
        ""
      );

      return {
        text: "RT @" + retweetedAuthor + ": " + retweetedText.text,
        source: "retweeted_" + retweetedText.source
      };
    }

    return {
      text: decodeHtmlEntities(tweet.legacy && tweet.legacy.full_text || ""),
      source: "legacy_full_text"
    };
  }

  function parseTwitterDate(value) {
    if (!value) {
      return "";
    }

    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? "" : new Date(timestamp).toISOString();
  }

  function parseTweetArticle(article, targetUsername) {
    const statusLink = article.querySelector('a[href*="/status/"]');
    if (!statusLink) {
      return null;
    }

    const statusUrl = safeUrl(statusLink.getAttribute("href"));
    if (!statusUrl) {
      return null;
    }

    const statusMatch = statusUrl.match(/\/([^/]+)\/status\/(\d+)/);
    if (!statusMatch) {
      return null;
    }

    const authorUsername = normalizeUsername(statusMatch[1]);
    if (!authorUsername) {
      return null;
    }

    if (targetUsername && authorUsername !== targetUsername) {
      return null;
    }

    const textNode = article.querySelector('[data-testid="tweetText"]');
    const timeNode = article.querySelector("time");
    const timeValue = timeNode && timeNode.getAttribute("datetime") || "";
    const id = statusMatch[2];

    return {
      id,
      createdAt: timeValue,
      createdAtRaw: timeValue,
      authorUsername,
      text: textNode && textNode.innerText || "",
      url: "https://x.com/" + authorUsername + "/status/" + id,
      metrics: {
        replies: 0,
        reposts: 0,
        quotes: 0,
        likes: 0,
        bookmarks: 0,
        views: 0
      },
      isPinned: isPinnedArticle(article),
      textSource: "dom_text"
    };
  }

  function isPinnedArticle(article) {
    const textCandidates = [
      article && article.innerText || "",
      article && article.textContent || "",
      article && article.getAttribute && article.getAttribute("aria-label") || "",
      article && article.getAttribute && article.getAttribute("title") || ""
    ];

    return textCandidates.some(function hasPinnedMarker(value) {
      const text = String(value || "");
      return PINNED_TEXT_MARKERS.some(function includesMarker(marker) {
        return text.includes(marker);
      });
    });
  }

  function safeUrl(value) {
    if (!value) {
      return "";
    }

    try {
      return new URL(value, "https://x.com").pathname;
    } catch (_error) {
      return "";
    }
  }

  function compareTweetsByTimeDesc(left, right) {
    const leftTime = Date.parse(left.createdAt);
    const rightTime = Date.parse(right.createdAt);

    if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) {
      return 0;
    }

    if (Number.isNaN(leftTime)) {
      return 1;
    }

    if (Number.isNaN(rightTime)) {
      return -1;
    }

    return rightTime - leftTime;
  }

  function toNumber(value) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : 0;
  }

  function normalizeUsername(username) {
    return String(username || "").replace(/^@/, "").trim().toLowerCase();
  }

  function decodeHtmlEntities(value) {
    return String(value).replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, function decode(match, entity) {
      if (entity === "amp") {
        return "&";
      }
      if (entity === "lt") {
        return "<";
      }
      if (entity === "gt") {
        return ">";
      }
      if (entity === "quot") {
        return "\"";
      }
      if (entity === "apos") {
        return "'";
      }

      const isHex = entity.toLowerCase().startsWith("#x");
      const codePoint = Number.parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    });
  }

  return {
    isUserTweetsUrl,
    extractUsernameFromUrl,
    parseTimelinePayload,
    parseTweetsFromDom
  };
});
