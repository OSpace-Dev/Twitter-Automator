<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import {
  CalendarClock,
  Database,
  ExternalLink,
  Eye,
  FileText,
  Hash,
  LoaderCircle,
  RefreshCw,
  X,
  XCircle
} from "@lucide/vue";
import { formatTime, statusLabel, stopReasonLabel, triggerLabel } from "../format";
import {
  clearFeedback,
  client,
  loading,
  refreshVersion,
  showError,
  syncServiceState
} from "../state";

const stats = ref({ totalTargets: 0, enabledTargets: 0, totalJobs: 0, todayJobs: 0, failedJobs: 0, totalTweets: 0 });
const targets = ref([]);
const jobs = ref([]);
const selectedJob = ref(null);
const selectedJobTweets = ref([]);
const jobDrawerLoading = ref(false);
const historyFilters = reactive({
  date: "",
  username: "",
  status: "",
  triggerType: "",
  limit: 100
});

const metrics = computed(() => [
  { label: "今日任务", value: stats.value.todayJobs, icon: CalendarClock },
  { label: "任务总数", value: stats.value.totalJobs, icon: Hash },
  { label: "Tweets", value: stats.value.totalTweets, icon: Database },
  { label: "失败任务", value: stats.value.failedJobs, icon: XCircle }
]);

async function loadHistoryPage() {
  loading.value = true;
  clearFeedback();
  try {
    const [statsResult, targetsResult, jobsResult] = await Promise.all([
      client.value.getStats(),
      client.value.listTargets(),
      client.value.listJobs(historyFilters)
    ]);
    stats.value = statsResult.stats;
    syncServiceState(statsResult);
    targets.value = targetsResult.targets;
    jobs.value = jobsResult.jobs;
  } catch (cause) {
    showError(cause);
  } finally {
    loading.value = false;
  }
}

async function loadJobs() {
  loading.value = true;
  clearFeedback();
  try {
    jobs.value = (await client.value.listJobs(historyFilters)).jobs;
  } catch (cause) {
    showError(cause);
  } finally {
    loading.value = false;
  }
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
    showError(cause);
  } finally {
    jobDrawerLoading.value = false;
  }
}

function closeJob() {
  selectedJob.value = null;
  selectedJobTweets.value = [];
}

function handleEscape(event) {
  if (event.key === "Escape" && selectedJob.value) closeJob();
}

watch(refreshVersion, loadHistoryPage, { immediate: true });
onMounted(() => window.addEventListener("keydown", handleEscape));
onBeforeUnmount(() => window.removeEventListener("keydown", handleEscape));
</script>

<template>
  <section class="page-heading">
    <div><p class="eyebrow">Collection History</p><h1>数据列表</h1><p class="page-description">按日期和账号追踪每次任务，并直接查看采集到的 Tweets。</p></div>
    <span class="date-stamp">最近 {{ historyFilters.limit }} 条任务</span>
  </section>

  <section class="metric-grid metric-grid-four">
    <article v-for="metric in metrics" :key="metric.label" class="metric-card">
      <component :is="metric.icon" :size="18" />
      <div><span>{{ metric.label }}</span><strong>{{ metric.value.toLocaleString() }}</strong></div>
    </article>
  </section>

  <section class="workspace-section history-section history-page-section">
    <header class="section-heading history-heading">
      <div><p class="eyebrow">Daily History</p><h2>历史任务</h2></div>
      <form class="history-filters" @submit.prevent="loadJobs">
        <input v-model="historyFilters.date" type="date" title="执行日期" aria-label="执行日期" />
        <select v-model="historyFilters.username" title="目标账号" aria-label="目标账号">
          <option value="">全部账号</option><option v-for="target in targets" :key="target.targetId" :value="target.username">@{{ target.username }}</option>
        </select>
        <select v-model="historyFilters.status" title="任务状态" aria-label="任务状态">
          <option value="">全部状态</option><option value="queued">排队中</option><option value="dispatched">已下发</option><option value="collecting">采集中</option><option value="completed">已完成</option><option value="failed">失败</option>
        </select>
        <select v-model="historyFilters.triggerType" title="触发类型" aria-label="触发类型">
          <option value="">全部来源</option><option value="scheduled">每日自动</option><option value="manual">手动</option>
        </select>
        <button class="outline-button" type="submit"><RefreshCw :size="14" />查询</button>
      </form>
    </header>
    <div class="table-wrap">
      <table>
        <thead><tr><th>执行日期</th><th>账号</th><th>来源</th><th>状态</th><th>Tweets</th><th>创建时间</th><th>详情</th></tr></thead>
        <tbody>
          <tr v-for="job in jobs" :key="job.jobId">
            <td>{{ job.runDate || "-" }}</td>
            <td><strong>@{{ job.username }}</strong><small>{{ job.jobId.slice(0, 8) }}</small></td>
            <td>{{ triggerLabel(job.triggerType) }}</td>
            <td><span class="status-badge" :data-status="job.status">{{ statusLabel(job.status) }}</span></td>
            <td>{{ job.tweetCount }}</td>
            <td>{{ formatTime(job.createdAt) }}</td>
            <td><button class="icon-button small" title="查看任务数据" aria-label="查看任务数据" @click="openJob(job)"><Eye :size="14" /></button></td>
          </tr>
          <tr v-if="!jobs.length"><td colspan="7" class="empty-cell">该筛选条件下暂无任务</td></tr>
        </tbody>
      </table>
    </div>
  </section>

  <Teleport to="body">
    <div v-if="selectedJob" class="overlay" @click.self="closeJob">
      <aside class="job-drawer" role="dialog" aria-modal="true" :aria-label="`@${selectedJob.username} 任务数据`">
        <header class="drawer-heading">
          <div><p class="eyebrow">Task Data</p><h2>@{{ selectedJob.username }}</h2><small>{{ selectedJob.runDate || "-" }} · {{ triggerLabel(selectedJob.triggerType) }}</small></div>
          <button class="icon-button" title="关闭" aria-label="关闭任务详情" @click="closeJob"><X :size="18" /></button>
        </header>
        <div class="job-summary">
          <div><span>状态</span><strong>{{ statusLabel(selectedJob.status) }}</strong></div>
          <div><span>Tweets</span><strong>{{ selectedJob.tweetCount }}</strong></div>
          <div><span>增量起点</span><strong>{{ formatTime(selectedJob.sinceTime) }}</strong></div>
          <div><span>停止原因</span><strong>{{ stopReasonLabel(selectedJob.stopReason) }}</strong></div>
        </div>
        <div v-if="jobDrawerLoading" class="drawer-state"><LoaderCircle :size="22" class="spinning" />加载任务数据</div>
        <div v-else-if="!selectedJobTweets.length" class="drawer-state"><FileText :size="22" />当前任务没有 Tweet 数据</div>
        <div v-else class="tweet-list">
          <article v-for="tweet in selectedJobTweets" :key="`${tweet.jobId}-${tweet.id}`" class="tweet-item">
            <header><strong>@{{ tweet.authorUsername || tweet.username }}</strong><span>{{ formatTime(tweet.createdAt) }}</span></header>
            <p>{{ tweet.text || "-" }}</p>
            <footer><span>Likes {{ tweet.metrics?.likes ?? 0 }}</span><span v-if="tweet.isPinned">置顶</span><a v-if="tweet.url" :href="tweet.url" target="_blank" rel="noopener noreferrer" title="在 X 打开"><ExternalLink :size="13" /></a></footer>
          </article>
        </div>
      </aside>
    </div>
  </Teleport>
</template>
