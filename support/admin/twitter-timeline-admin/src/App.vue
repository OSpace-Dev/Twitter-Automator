<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import {
  AtSign,
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  Database,
  Edit3,
  ExternalLink,
  Eye,
  FileText,
  Hash,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  Save,
  Settings,
  Target,
  X,
  XCircle
} from "@lucide/vue";
import { createApiClient, DEFAULT_BASE_URL, DEFAULT_TOKEN } from "./api";

const connection = reactive({
  baseUrl: localStorage.getItem("twitter-admin-base-url") || DEFAULT_BASE_URL,
  apiToken: localStorage.getItem("twitter-admin-api-token") || DEFAULT_TOKEN
});
const client = computed(() => createApiClient(connection));
const loading = ref(false);
const notice = ref("");
const error = ref("");
const extensionClients = ref(0);
const stats = ref({ totalTargets: 0, enabledTargets: 0, totalJobs: 0, todayJobs: 0, failedJobs: 0, totalTweets: 0 });
const schedule = reactive({ scheduleTime: "09:00", timeZone: "Asia/Shanghai", nextRunAt: null });
const targets = ref([]);
const jobs = ref([]);
const savingTarget = ref(false);
const savingSchedule = ref(false);
const runningTargetId = ref("");
const showConnection = ref(false);
const selectedJob = ref(null);
const selectedJobTweets = ref([]);
const jobDrawerLoading = ref(false);

const targetForm = reactive({
  targetId: "",
  username: "",
  displayName: "",
  maxTweets: 100,
  enabled: true
});
const historyFilters = reactive({
  date: "",
  username: "",
  status: "",
  triggerType: "",
  limit: 100
});

const metrics = computed(() => [
  { label: "目标账号", value: stats.value.totalTargets, icon: Target },
  { label: "自动执行", value: stats.value.enabledTargets, icon: CheckCircle2 },
  { label: "今日任务", value: stats.value.todayJobs, icon: CalendarClock },
  { label: "任务总数", value: stats.value.totalJobs, icon: Hash },
  { label: "Tweets", value: stats.value.totalTweets, icon: Database },
  { label: "失败任务", value: stats.value.failedJobs, icon: XCircle }
]);
const isEditingTarget = computed(() => Boolean(targetForm.targetId));

async function loadDashboard() {
  loading.value = true;
  clearFeedback();
  try {
    const [statsResult, settingsResult, targetsResult, jobsResult] = await Promise.all([
      client.value.getStats(),
      client.value.getSettings(),
      client.value.listTargets(),
      client.value.listJobs(historyFilters)
    ]);
    stats.value = statsResult.stats;
    extensionClients.value = statsResult.extensionClients;
    schedule.scheduleTime = settingsResult.settings.scheduleTime;
    schedule.timeZone = settingsResult.settings.timeZone;
    schedule.nextRunAt = settingsResult.schedule.nextRunAt;
    targets.value = targetsResult.targets;
    jobs.value = jobsResult.jobs;
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    loading.value = false;
  }
}

async function loadJobs() {
  clearFeedback();
  try {
    jobs.value = (await client.value.listJobs(historyFilters)).jobs;
  } catch (cause) {
    error.value = errorMessage(cause);
  }
}

async function submitTarget() {
  savingTarget.value = true;
  clearFeedback();
  try {
    const payload = {
      username: targetForm.username.trim(),
      displayName: targetForm.displayName.trim() || null,
      maxTweets: Number(targetForm.maxTweets),
      enabled: targetForm.enabled
    };
    if (targetForm.targetId) {
      await client.value.updateTarget(targetForm.targetId, payload);
    } else {
      await client.value.createTarget(payload);
    }
    const successMessage = targetForm.targetId
      ? `@${payload.username} 已更新`
      : `@${payload.username} 已添加`;
    resetTargetForm();
    await loadDashboard();
    notice.value = successMessage;
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    savingTarget.value = false;
  }
}

function editTarget(target) {
  Object.assign(targetForm, {
    targetId: target.targetId,
    username: target.username,
    displayName: target.displayName || "",
    maxTweets: target.maxTweets,
    enabled: target.enabled
  });
}

function resetTargetForm() {
  Object.assign(targetForm, {
    targetId: "",
    username: "",
    displayName: "",
    maxTweets: 100,
    enabled: true
  });
}

async function toggleTarget(target) {
  clearFeedback();
  try {
    const response = await client.value.updateTarget(target.targetId, { enabled: !target.enabled });
    targets.value = targets.value.map((item) => item.targetId === target.targetId ? response.target : item);
    await refreshStats();
  } catch (cause) {
    error.value = errorMessage(cause);
  }
}

async function runTarget(target) {
  runningTargetId.value = target.targetId;
  clearFeedback();
  try {
    const response = await client.value.runTarget(target.targetId);
    historyFilters.date = response.job.runDate;
    await Promise.all([loadJobs(), refreshStats()]);
    notice.value = `@${target.username} 任务已入队：${response.job.jobId.slice(0, 8)}`;
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    runningTargetId.value = "";
  }
}

async function saveSchedule() {
  savingSchedule.value = true;
  clearFeedback();
  try {
    const response = await client.value.updateSettings({ scheduleTime: schedule.scheduleTime });
    schedule.scheduleTime = response.settings.scheduleTime;
    schedule.timeZone = response.settings.timeZone;
    schedule.nextRunAt = response.schedule.nextRunAt;
    notice.value = "每日触发时间已保存";
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    savingSchedule.value = false;
  }
}

async function refreshStats() {
  const response = await client.value.getStats();
  stats.value = response.stats;
  extensionClients.value = response.extensionClients;
}

async function openJob(job) {
  selectedJob.value = job;
  selectedJobTweets.value = [];
  jobDrawerLoading.value = true;
  clearFeedback();
  try {
    const [jobResult, tweetsResult] = await Promise.all([
      client.value.getJob(job.jobId),
      client.value.listTweets({ jobId: job.jobId, limit: 500 })
    ]);
    selectedJob.value = jobResult.job;
    selectedJobTweets.value = tweetsResult.tweets;
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    jobDrawerLoading.value = false;
  }
}

function closeJob() {
  selectedJob.value = null;
  selectedJobTweets.value = [];
}

function saveConnection() {
  connection.baseUrl = connection.baseUrl.trim().replace(/\/$/, "") || DEFAULT_BASE_URL;
  connection.apiToken = connection.apiToken.trim() || DEFAULT_TOKEN;
  localStorage.setItem("twitter-admin-base-url", connection.baseUrl);
  localStorage.setItem("twitter-admin-api-token", connection.apiToken);
  showConnection.value = false;
  loadDashboard();
}

function getShanghaiDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
}

function formatTime(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Shanghai"
  }).format(new Date(value));
}

function statusLabel(status) {
  return ({ queued: "排队中", dispatched: "已下发", collecting: "采集中", completed: "已完成", failed: "失败", cancelled: "已取消" })[status] || status;
}

function triggerLabel(triggerType) {
  return triggerType === "scheduled" ? "每日自动" : "手动";
}

function stopReasonLabel(value) {
  return ({
    time_threshold: "到达增量时间边界",
    max_tweets: "达到最大推文数",
    scroll_safety_cap: "触发滚动安全上限",
    idle_scrolls: "连续空滚动后结束",
    dispatch_timeout: "扩展执行超时",
    extension_disconnected: "扩展连接中断",
    target_tab_unavailable: "目标标签页不可用",
    target_tab_closed: "目标标签页已关闭"
  })[value] || value || "-";
}

function clearFeedback() {
  notice.value = "";
  error.value = "";
}

function errorMessage(cause) {
  return cause instanceof Error ? cause.message : "请求失败";
}

function handleEscape(event) {
  if (event.key !== "Escape") return;
  if (selectedJob.value) closeJob();
  else if (showConnection.value) showConnection.value = false;
}

onMounted(() => {
  loadDashboard();
  window.addEventListener("keydown", handleEscape);
});
onBeforeUnmount(() => window.removeEventListener("keydown", handleEscape));
</script>

<template>
  <main class="app-shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark"><AtSign :size="20" /></span>
        <div><strong>Twitter Timeline</strong><small>Automator / 管理台</small></div>
      </div>
      <div class="top-actions">
        <span class="connection-state"><span class="status-dot" :class="{ muted: !extensionClients }"></span>{{ extensionClients ? `${extensionClients} 个扩展已连接` : "等待扩展连接" }}</span>
        <button class="icon-button" title="连接设置" @click="showConnection = true"><Settings :size="17" /></button>
        <button class="icon-button" title="刷新全部数据" :disabled="loading" @click="loadDashboard"><RefreshCw :size="17" :class="{ spinning: loading }" /></button>
      </div>
    </header>

    <section class="page-heading">
      <div><p class="eyebrow">Operations</p><h1>采集控制台</h1></div>
      <span class="date-stamp">{{ getShanghaiDate() }} · Asia/Shanghai</span>
    </section>

    <p v-if="error" class="feedback feedback-error"><CircleAlert :size="16" />{{ error }}</p>
    <p v-if="notice" class="feedback"><CheckCircle2 :size="16" />{{ notice }}</p>

    <section class="metric-grid">
      <article v-for="metric in metrics" :key="metric.label" class="metric-card">
        <component :is="metric.icon" :size="18" />
        <div><span>{{ metric.label }}</span><strong>{{ metric.value.toLocaleString() }}</strong></div>
      </article>
    </section>

    <section class="operations-grid">
      <article class="workspace-section target-section">
        <header class="section-heading"><div><p class="eyebrow">Targets</p><h2>目标账号</h2></div><span>{{ targets.length }} 个账号</span></header>
        <form class="target-form" @submit.prevent="submitTarget">
          <label>用户名<input v-model="targetForm.username" required maxlength="15" placeholder="username" /></label>
          <label>显示名称<input v-model="targetForm.displayName" maxlength="100" placeholder="可选" /></label>
          <label>最大 Tweets<input v-model.number="targetForm.maxTweets" type="number" min="1" max="500" /></label>
          <label class="checkbox-field"><input v-model="targetForm.enabled" type="checkbox" /><span>每日自动执行</span></label>
          <div class="form-actions">
            <button v-if="isEditingTarget" type="button" class="text-button" @click="resetTargetForm"><X :size="14" />取消</button>
            <button class="solid-button" :disabled="savingTarget || !targetForm.username.trim()"><component :is="isEditingTarget ? Save : Plus" :size="15" />{{ isEditingTarget ? "保存" : "添加账号" }}</button>
          </div>
        </form>

        <div class="table-wrap">
          <table>
            <thead><tr><th>账号</th><th>显示名称</th><th>上限</th><th>每日自动</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="target in targets" :key="target.targetId">
                <td><a :href="`https://x.com/${target.username}`" target="_blank" rel="noopener noreferrer" class="account-link">@{{ target.username }}<ExternalLink :size="12" /></a></td>
                <td>{{ target.displayName || "-" }}</td>
                <td>{{ target.maxTweets }}</td>
                <td><label class="switch"><input type="checkbox" :checked="target.enabled" @change="toggleTarget(target)" /><span></span></label></td>
                <td><div class="row-actions"><button class="icon-button small" title="编辑目标" @click="editTarget(target)"><Edit3 :size="14" /></button><button class="icon-button small" title="立即运行" :disabled="runningTargetId === target.targetId" @click="runTarget(target)"><LoaderCircle v-if="runningTargetId === target.targetId" :size="14" class="spinning" /><Play v-else :size="14" /></button></div></td>
              </tr>
              <tr v-if="!targets.length"><td colspan="5" class="empty-cell">暂无目标账号</td></tr>
            </tbody>
          </table>
        </div>
      </article>

      <article class="workspace-section schedule-section">
        <header class="section-heading"><div><p class="eyebrow">Schedule</p><h2>每日调度</h2></div><CalendarClock :size="18" /></header>
        <label class="schedule-input">触发时间<input v-model="schedule.scheduleTime" type="time" step="60" /><small>{{ schedule.timeZone }}</small></label>
        <dl class="schedule-state"><div><dt>下次执行</dt><dd>{{ formatTime(schedule.nextRunAt) }}</dd></div><div><dt>执行范围</dt><dd>{{ stats.enabledTargets }} 个启用账号</dd></div></dl>
        <button class="outline-button wide" :disabled="savingSchedule" @click="saveSchedule"><Save :size="15" />{{ savingSchedule ? "保存中" : "保存调度" }}</button>
      </article>
    </section>

    <section class="workspace-section history-section">
      <header class="section-heading history-heading">
        <div><p class="eyebrow">Daily History</p><h2>每日任务数据</h2></div>
        <div class="history-filters">
          <input v-model="historyFilters.date" type="date" title="执行日期" />
          <select v-model="historyFilters.username" title="目标账号"><option value="">全部账号</option><option v-for="target in targets" :key="target.targetId" :value="target.username">@{{ target.username }}</option></select>
          <select v-model="historyFilters.status" title="任务状态"><option value="">全部状态</option><option value="queued">排队中</option><option value="dispatched">已下发</option><option value="collecting">采集中</option><option value="completed">已完成</option><option value="failed">失败</option></select>
          <select v-model="historyFilters.triggerType" title="触发类型"><option value="">全部来源</option><option value="scheduled">每日自动</option><option value="manual">手动</option></select>
          <button class="outline-button" @click="loadJobs"><RefreshCw :size="14" />查询</button>
        </div>
      </header>
      <div class="table-wrap">
        <table>
          <thead><tr><th>执行日期</th><th>账号</th><th>来源</th><th>状态</th><th>Tweets</th><th>创建时间</th><th></th></tr></thead>
          <tbody>
            <tr v-for="job in jobs" :key="job.jobId">
              <td>{{ job.runDate || "-" }}</td><td><strong>@{{ job.username }}</strong><small>{{ job.jobId.slice(0, 8) }}</small></td><td>{{ triggerLabel(job.triggerType) }}</td><td><span class="status-badge" :data-status="job.status">{{ statusLabel(job.status) }}</span></td><td>{{ job.tweetCount }}</td><td>{{ formatTime(job.createdAt) }}</td><td><button class="icon-button small" title="查看任务数据" @click="openJob(job)"><Eye :size="14" /></button></td>
            </tr>
            <tr v-if="!jobs.length"><td colspan="7" class="empty-cell">该筛选条件下暂无任务</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <footer>Twitter Automator <span>·</span> SQLite local data service</footer>
  </main>

  <Teleport to="body">
    <div v-if="selectedJob" class="overlay" @click.self="closeJob">
      <aside class="job-drawer" role="dialog" aria-modal="true" :aria-label="`@${selectedJob.username} 任务数据`">
        <header class="drawer-heading"><div><p class="eyebrow">Task Data</p><h2>@{{ selectedJob.username }}</h2><small>{{ selectedJob.runDate || "-" }} · {{ triggerLabel(selectedJob.triggerType) }}</small></div><button class="icon-button" title="关闭" @click="closeJob"><X :size="18" /></button></header>
        <div class="job-summary"><div><span>状态</span><strong>{{ statusLabel(selectedJob.status) }}</strong></div><div><span>Tweets</span><strong>{{ selectedJob.tweetCount }}</strong></div><div><span>增量起点</span><strong>{{ formatTime(selectedJob.sinceTime) }}</strong></div><div><span>停止原因</span><strong>{{ stopReasonLabel(selectedJob.stopReason) }}</strong></div></div>
        <div v-if="jobDrawerLoading" class="drawer-state"><LoaderCircle :size="22" class="spinning" />加载任务数据</div>
        <div v-else-if="!selectedJobTweets.length" class="drawer-state"><FileText :size="22" />当前任务没有 tweet 数据</div>
        <div v-else class="tweet-list">
          <article v-for="tweet in selectedJobTweets" :key="`${tweet.jobId}-${tweet.id}`" class="tweet-item">
            <header><strong>@{{ tweet.authorUsername || tweet.username }}</strong><span>{{ formatTime(tweet.createdAt) }}</span></header>
            <p>{{ tweet.text || "-" }}</p>
            <footer><span>Likes {{ tweet.metrics?.likes ?? 0 }}</span><span v-if="tweet.isPinned">置顶</span><a v-if="tweet.url" :href="tweet.url" target="_blank" rel="noopener noreferrer" title="在 X 打开"><ExternalLink :size="13" /></a></footer>
          </article>
        </div>
      </aside>
    </div>

    <div v-if="showConnection" class="overlay centered" @click.self="showConnection = false">
      <section class="connection-dialog" role="dialog" aria-modal="true" aria-label="连接设置">
        <header class="section-heading"><h2>连接设置</h2><button class="icon-button" title="关闭" @click="showConnection = false"><X :size="17" /></button></header>
        <label>API Base URL<input v-model="connection.baseUrl" type="url" /></label>
        <label>API Token<input v-model="connection.apiToken" type="password" /></label>
        <button class="solid-button wide" @click="saveConnection"><Save :size="15" />保存并重新连接</button>
      </section>
    </div>
  </Teleport>
</template>
