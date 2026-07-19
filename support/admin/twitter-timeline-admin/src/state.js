import { computed, reactive, ref } from "vue";
import { createApiClient, DEFAULT_BASE_URL, DEFAULT_TOKEN } from "./api";

export const connection = reactive({
  baseUrl: localStorage.getItem("twitter-admin-base-url") || DEFAULT_BASE_URL,
  apiToken: localStorage.getItem("twitter-admin-api-token") || DEFAULT_TOKEN
});

export const client = computed(() => createApiClient(connection));
export const extensionClients = ref(0);
export const loading = ref(false);
export const notice = ref("");
export const error = ref("");
export const refreshVersion = ref(0);

export function clearFeedback() {
  notice.value = "";
  error.value = "";
}

export function showError(cause) {
  notice.value = "";
  error.value = cause instanceof Error ? cause.message : "请求失败";
}

export function showNotice(message) {
  error.value = "";
  notice.value = message;
}

export function syncServiceState(statsResult) {
  extensionClients.value = statsResult.extensionClients;
}

export function requestRefresh() {
  refreshVersion.value += 1;
}

export function saveConnection() {
  connection.baseUrl = connection.baseUrl.trim().replace(/\/$/, "") || DEFAULT_BASE_URL;
  connection.apiToken = connection.apiToken.trim() || DEFAULT_TOKEN;
  localStorage.setItem("twitter-admin-base-url", connection.baseUrl);
  localStorage.setItem("twitter-admin-api-token", connection.apiToken);
  requestRefresh();
}
