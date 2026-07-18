(function installUserTweetsHook() {
  if (window.__twitterTimelineHookInstalled) {
    return;
  }

  window.__twitterTimelineHookInstalled = true;

  postDebug("hook_installed", {
    href: window.location.href
  });

  function isUserTweetsUrl(url) {
    try {
      const parsedUrl = new URL(String(url), window.location.href);
      return parsedUrl.pathname.includes("/i/api/graphql/")
        && parsedUrl.pathname.endsWith("/UserTweets");
    } catch (_error) {
      return false;
    }
  }

  function postPayload(url, payload, source) {
    window.postMessage({
      type: "TWITTER_TIMELINE_USER_TWEETS",
      source,
      url: String(url),
      payload,
      capturedAt: new Date().toISOString()
    }, window.location.origin);
  }

  function postDebug(event, detail) {
    window.postMessage({
      type: "TWITTER_TIMELINE_HOOK_DEBUG",
      event,
      detail: detail || null,
      capturedAt: new Date().toISOString()
    }, window.location.origin);
  }

  function captureJson(url, response, source) {
    if (!isUserTweetsUrl(url) || !response || typeof response.clone !== "function") {
      return;
    }

    postDebug("usertweets_matched", {
      source,
      url: String(url)
    });

    response.clone().json()
      .then(function onJson(payload) {
        postDebug("usertweets_json_parsed", {
          source,
          url: String(url)
        });
        postPayload(url, payload, source);
      })
      .catch(function onJsonError(error) {
        postDebug("usertweets_json_parse_failed", {
          source,
          url: String(url),
          error: error && error.message || String(error)
        });
      });
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function hookedFetch(input, init) {
      const url = input && input.url || input;

      return originalFetch.apply(this, arguments).then(function onResponse(response) {
        captureJson(url, response, "fetch");
        return response;
      });
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function hookedOpen(method, url) {
    this.__twitterTimelineUrl = url;
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function hookedSend() {
    if (isUserTweetsUrl(this.__twitterTimelineUrl)) {
      postDebug("usertweets_matched", {
        source: "xhr",
        url: String(this.__twitterTimelineUrl)
      });
      this.addEventListener("loadend", function onLoadEnd() {
        try {
          postDebug("usertweets_json_parsed", {
            source: "xhr",
            url: String(this.__twitterTimelineUrl)
          });
          postPayload(
            this.__twitterTimelineUrl,
            JSON.parse(this.responseText),
            "xhr"
          );
        } catch (error) {
          postDebug("usertweets_json_parse_failed", {
            source: "xhr",
            url: String(this.__twitterTimelineUrl),
            error: error && error.message || String(error)
          });
          // X sometimes returns empty or blocked responses. They are not useful for timeline parsing.
        }
      });
    }

    return originalSend.apply(this, arguments);
  };
})();
