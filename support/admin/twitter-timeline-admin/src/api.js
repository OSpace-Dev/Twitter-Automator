const DEFAULT_BASE_URL = "http://127.0.0.1:8001";
const DEFAULT_TOKEN = "dev-twitter-timeline-api-token";

function buildHeaders(token) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token || DEFAULT_TOKEN}`
  };
}

async function requestJson(path, options = {}) {
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `request_failed_${response.status}`);
  }

  return payload;
}

export function createApiClient(settings) {
  const baseUrl = (settings.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
  const token = settings.apiToken || DEFAULT_TOKEN;

  return {
    async createJob(input) {
      return requestJson(`${baseUrl}/api/twitter-timeline/jobs`, {
        method: "POST",
        headers: buildHeaders(token),
        body: JSON.stringify(input)
      });
    },
    async listJobs(filters = {}) {
      const search = new URLSearchParams();
      if (filters.username) {
        search.set("username", filters.username);
      }
      if (filters.status) {
        search.set("status", filters.status);
      }
      if (filters.limit) {
        search.set("limit", String(filters.limit));
      }

      return requestJson(`${baseUrl}/api/twitter-timeline/jobs?${search.toString()}`, {
        headers: buildHeaders(token)
      });
    },
    async getJob(jobId) {
      return requestJson(`${baseUrl}/api/twitter-timeline/jobs/${jobId}`, {
        headers: buildHeaders(token)
      });
    },
    async listTweets(filters = {}) {
      const search = new URLSearchParams();
      if (filters.username) {
        search.set("username", filters.username);
      }
      if (filters.jobId) {
        search.set("jobId", filters.jobId);
      }
      if (filters.limit) {
        search.set("limit", String(filters.limit));
      }

      return requestJson(`${baseUrl}/api/twitter-timeline/tweets?${search.toString()}`, {
        headers: buildHeaders(token)
      });
    }
  };
}

export { DEFAULT_BASE_URL, DEFAULT_TOKEN };
