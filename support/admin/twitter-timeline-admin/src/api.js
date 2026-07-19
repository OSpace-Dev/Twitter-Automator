const DEFAULT_BASE_URL = "http://127.0.0.1:8001";
const DEFAULT_TOKEN = "dev-twitter-timeline-api-token";

function buildHeaders(token) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token || DEFAULT_TOKEN}`
  };
}

async function requestJson(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...buildHeaders(token), ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `request_failed_${response.status}`);
  }
  return payload;
}

export function createApiClient(settings) {
  const baseUrl = (settings.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
  const token = settings.apiToken || DEFAULT_TOKEN;
  const request = (path, options) => requestJson(`${baseUrl}${path}`, token, options);

  return {
    getStats: () => request("/api/twitter-timeline/stats"),
    getSettings: () => request("/api/twitter-timeline/settings"),
    updateSettings: (input) => request("/api/twitter-timeline/settings", {
      method: "PUT",
      body: JSON.stringify(input)
    }),
    listTargets: () => request("/api/twitter-timeline/targets"),
    createTarget: (input) => request("/api/twitter-timeline/targets", {
      method: "POST",
      body: JSON.stringify(input)
    }),
    updateTarget: (targetId, input) => request(`/api/twitter-timeline/targets/${encodeURIComponent(targetId)}`, {
      method: "PUT",
      body: JSON.stringify(input)
    }),
    runTarget: (targetId) => request(`/api/twitter-timeline/targets/${encodeURIComponent(targetId)}/run`, {
      method: "POST",
      body: "{}"
    }),
    listJobs(filters = {}) {
      const search = new URLSearchParams();
      if (filters.username) search.set("username", filters.username);
      if (filters.status) search.set("status", filters.status);
      if (filters.date) search.set("date", filters.date);
      if (filters.triggerType) search.set("triggerType", filters.triggerType);
      if (filters.limit) search.set("limit", String(filters.limit));
      return request(`/api/twitter-timeline/jobs?${search.toString()}`);
    },
    getJob: (jobId) => request(`/api/twitter-timeline/jobs/${encodeURIComponent(jobId)}`),
    listTweets(filters = {}) {
      const search = new URLSearchParams();
      if (filters.username) search.set("username", filters.username);
      if (filters.jobId) search.set("jobId", filters.jobId);
      if (filters.limit) search.set("limit", String(filters.limit));
      return request(`/api/twitter-timeline/tweets?${search.toString()}`);
    }
  };
}

export { DEFAULT_BASE_URL, DEFAULT_TOKEN };
