<script setup>
import { computed, reactive, ref, watch } from "vue";
import { createApiClient, DEFAULT_BASE_URL, DEFAULT_TOKEN } from "./api";

const settings = reactive({
  baseUrl: DEFAULT_BASE_URL,
  apiToken: DEFAULT_TOKEN
});

const jobForm = reactive({
  username: "",
  sinceTime: "",
  maxTweets: 100
});

const jobFilters = reactive({
  username: "",
  status: "",
  limit: 50
});

const tweetFilters = reactive({
  username: "",
  jobId: "",
  limit: 50
});

const jobs = ref([]);
const tweets = ref([]);
const selectedJobTweets = ref([]);
const selectedJob = ref(null);
const selectedJobId = ref("");
const creatingJob = ref(false);
const loadingJobs = ref(false);
const loadingTweets = ref(false);
const loadingJobDetail = ref(false);
const loadingSelectedJobTweets = ref(false);
const globalMessage = ref("");
const globalError = ref("");

const client = computed(() => createApiClient(settings));

const selectedJobSummary = computed(() => {
  const job = selectedJob.value;
  const result = job && job.result || {};
  const collection = result && result.collection || {};
  return {
    captures: result && result.captures || 0,
    scrollCount: collection && collection.scrollCount || 0,
    idleScrollCount: collection && collection.idleScrollCount || 0,
    safetyScrollCap: collection && collection.safetyScrollCap || 0,
    sinceTime: collection && collection.sinceTime || job && job.sinceTime || null
  };
});

watch(selectedJobId, async (jobId) => {
  if (!jobId) {
    selectedJob.value = null;
    selectedJobTweets.value = [];
    return;
  }

  await loadJobDetail(jobId);
  await loadSelectedJobTweets(jobId);
});

async function submitJob() {
  creatingJob.value = true;
  clearFeedback();
  try {
    const payload = {
      username: jobForm.username.trim(),
      sinceTime: jobForm.sinceTime ? new Date(jobForm.sinceTime).toISOString() : undefined,
      maxTweets: Number(jobForm.maxTweets)
    };
    const response = await client.value.createJob(payload);
    globalMessage.value = `任务已创建：${response.job.jobId}`;
    selectedJobId.value = response.job.jobId;
    await loadJobs();
  } catch (error) {
    globalError.value = error.message;
  } finally {
    creatingJob.value = false;
  }
}

async function loadJobs() {
  loadingJobs.value = true;
  clearFeedback();
  try {
    const response = await client.value.listJobs(jobFilters);
    jobs.value = response.jobs || [];
    if (!selectedJobId.value && jobs.value[0]) {
      selectedJobId.value = jobs.value[0].jobId;
    }
  } catch (error) {
    globalError.value = error.message;
  } finally {
    loadingJobs.value = false;
  }
}

async function loadJobDetail(jobId) {
  loadingJobDetail.value = true;
  clearFeedback();
  try {
    const response = await client.value.getJob(jobId);
    selectedJob.value = response.job;
  } catch (error) {
    globalError.value = error.message;
  } finally {
    loadingJobDetail.value = false;
  }
}

async function loadSelectedJobTweets(jobId) {
  loadingSelectedJobTweets.value = true;
  clearFeedback();
  try {
    const response = await client.value.listTweets({
      jobId,
      limit: 200
    });
    selectedJobTweets.value = response.tweets || [];
  } catch (error) {
    globalError.value = error.message;
  } finally {
    loadingSelectedJobTweets.value = false;
  }
}

async function loadTweets() {
  loadingTweets.value = true;
  clearFeedback();
  try {
    const response = await client.value.listTweets(tweetFilters);
    tweets.value = response.tweets || [];
  } catch (error) {
    globalError.value = error.message;
  } finally {
    loadingTweets.value = false;
  }
}

function selectJob(jobId) {
  selectedJobId.value = jobId;
}

function clearFeedback() {
  globalMessage.value = "";
  globalError.value = "";
}

function formatStopReason(stopReason) {
  if (!stopReason) {
    return "-";
  }

  const labels = {
    time_threshold: "已滚动到起始时间之前",
    max_tweets: "达到最大推文数",
    scroll_safety_cap: "触发内部滚动安全上限",
    idle_scrolls: "连续空滚动后自然结束",
    manual_stop: "手动停止",
    manual_clear: "手动清空",
    page_changed: "页面已切换",
    dispatch_timeout: "任务下发后超时",
    extension_disconnected: "扩展连接中断",
    dispatch_write_failed: "下发任务写入失败",
    target_tab_unavailable: "目标标签页不可用",
    target_tab_closed: "目标标签页已关闭"
  };
  return labels[stopReason] || stopReason;
}

loadJobs();
</script>

<template>
  <div class="page-shell">
    <aside class="sidebar">
      <div class="brand">
        <p class="eyebrow">Local Control</p>
        <h1>Twitter Timeline Admin</h1>
        <p class="subtitle">下发最新推文抓取任务，查看执行状态、执行细节和历史 tweets。</p>
      </div>

      <section class="panel">
        <h2>连接设置</h2>
        <label>
          API Base URL
          <input v-model="settings.baseUrl" type="text">
        </label>
        <label>
          API Token
          <input v-model="settings.apiToken" type="text">
        </label>
      </section>

      <section class="panel">
        <h2>新建任务</h2>
        <label>
          用户名
          <input v-model="jobForm.username" type="text" placeholder="karpathy">
        </label>
        <label>
          起始时间
          <input v-model="jobForm.sinceTime" type="datetime-local">
        </label>
        <label>
          最大推文数
          <input v-model="jobForm.maxTweets" type="number" min="1" max="500">
        </label>
        <button class="primary" :disabled="creatingJob || !jobForm.username.trim()" @click="submitJob">
          {{ creatingJob ? "提交中..." : "下发任务" }}
        </button>
      </section>
    </aside>

    <main class="content">
      <section class="hero-card">
        <div>
          <p class="eyebrow">Operations</p>
          <h2>任务与历史数据</h2>
        </div>
        <div class="status-strip">
          <span v-if="globalMessage" class="pill success">{{ globalMessage }}</span>
          <span v-if="globalError" class="pill danger">{{ globalError }}</span>
        </div>
      </section>

      <section class="grid">
        <article class="panel">
          <div class="panel-head">
            <h2>任务列表</h2>
            <button @click="loadJobs">{{ loadingJobs ? "刷新中..." : "刷新" }}</button>
          </div>
          <div class="row filters">
            <input v-model="jobFilters.username" type="text" placeholder="按用户名过滤">
            <select v-model="jobFilters.status">
              <option value="">全部状态</option>
              <option value="queued">queued</option>
              <option value="dispatched">dispatched</option>
              <option value="collecting">collecting</option>
              <option value="completed">completed</option>
              <option value="failed">failed</option>
              <option value="cancelled">cancelled</option>
            </select>
            <input v-model="jobFilters.limit" type="number" min="1" max="500">
            <button @click="loadJobs">应用</button>
          </div>

          <div class="list">
            <button
              v-for="job in jobs"
              :key="job.jobId"
              class="list-item"
              :class="{ active: job.jobId === selectedJobId }"
              @click="selectJob(job.jobId)"
            >
              <div>
                <strong>@{{ job.username }}</strong>
                <p>{{ job.jobId }}</p>
              </div>
              <span class="badge" :data-status="job.status">{{ job.status }}</span>
            </button>
            <p v-if="!jobs.length" class="empty">暂无任务数据。</p>
          </div>
        </article>

        <article class="panel">
          <div class="panel-head">
            <h2>任务详情</h2>
            <div class="inline-actions">
              <button :disabled="!selectedJobId" @click="loadJobDetail(selectedJobId)">
                {{ loadingJobDetail ? "加载中..." : "刷新详情" }}
              </button>
              <button :disabled="!selectedJobId" @click="loadSelectedJobTweets(selectedJobId)">
                {{ loadingSelectedJobTweets ? "加载中..." : "刷新 tweets" }}
              </button>
            </div>
          </div>

          <div v-if="selectedJob" class="detail">
            <div class="detail-grid">
              <div><span>Job ID</span><strong>{{ selectedJob.jobId }}</strong></div>
              <div><span>状态</span><strong>{{ selectedJob.status }}</strong></div>
              <div><span>用户名</span><strong>@{{ selectedJob.username }}</strong></div>
              <div><span>Tweet 数</span><strong>{{ selectedJob.tweetCount }}</strong></div>
              <div><span>起始时间</span><strong>{{ selectedJobSummary.sinceTime || "-" }}</strong></div>
              <div><span>最大推文数</span><strong>{{ selectedJob.maxTweets }}</strong></div>
              <div><span>创建时间</span><strong>{{ selectedJob.createdAt || "-" }}</strong></div>
              <div><span>更新时间</span><strong>{{ selectedJob.updatedAt || "-" }}</strong></div>
              <div><span>停止原因</span><strong>{{ formatStopReason(selectedJob.stopReason) }}</strong></div>
              <div><span>页面 URL</span><strong>{{ selectedJob.pageUrl || "-" }}</strong></div>
            </div>

            <div class="detail-grid">
              <div><span>捕获次数</span><strong>{{ selectedJobSummary.captures }}</strong></div>
              <div><span>滚动次数</span><strong>{{ selectedJobSummary.scrollCount }}</strong></div>
              <div><span>空滚动次数</span><strong>{{ selectedJobSummary.idleScrollCount }}</strong></div>
              <div><span>内部安全上限</span><strong>{{ selectedJobSummary.safetyScrollCap || "-" }}</strong></div>
            </div>

            <div class="json-card">
              <h3>错误</h3>
              <pre>{{ JSON.stringify(selectedJob.errors || [], null, 2) }}</pre>
            </div>

            <div class="json-card">
              <h3>结果摘要</h3>
              <pre>{{ JSON.stringify(selectedJob.result || null, null, 2) }}</pre>
            </div>

            <div class="json-card">
              <div class="panel-head compact">
                <h3>任务详情 Tweets</h3>
                <span class="detail-hint">
                  {{ loadingSelectedJobTweets ? "加载中..." : `共 ${selectedJobTweets.length} 条` }}
                </span>
              </div>
              <div v-if="selectedJobTweets.length" class="job-tweets">
                <article v-for="tweet in selectedJobTweets" :key="`${tweet.jobId}-${tweet.id}`" class="job-tweet-card">
                  <div class="job-tweet-head">
                    <strong>@{{ tweet.authorUsername || tweet.username }}</strong>
                    <span>{{ tweet.createdAt || "-" }}</span>
                  </div>
                  <p class="job-tweet-text">{{ tweet.text || "-" }}</p>
                  <div class="job-tweet-meta">
                    <span>ID: {{ tweet.id }}</span>
                    <span>Source: {{ tweet.textSource || "-" }}</span>
                    <span>Likes: {{ tweet.metrics?.likes ?? "-" }}</span>
                  </div>
                </article>
              </div>
              <p v-else class="empty">当前任务还没有可展示的 tweet 详情。</p>
            </div>
          </div>

          <p v-else class="empty">选择左侧任务后查看详情。</p>
        </article>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h2>历史 Tweets</h2>
          <button @click="loadTweets">{{ loadingTweets ? "查询中..." : "查询" }}</button>
        </div>
        <div class="row filters">
          <input v-model="tweetFilters.username" type="text" placeholder="用户名，例如 karpathy">
          <input v-model="tweetFilters.jobId" type="text" placeholder="按 jobId 过滤">
          <input v-model="tweetFilters.limit" type="number" min="1" max="500">
          <button @click="loadTweets">应用</button>
        </div>

        <div class="tweet-table-wrap">
          <table class="tweet-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>账号</th>
                <th>内容</th>
                <th>来源</th>
                <th>点赞</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="tweet in tweets" :key="`${tweet.jobId}-${tweet.id}`">
                <td>{{ tweet.createdAt || "-" }}</td>
                <td>@{{ tweet.authorUsername || tweet.username }}</td>
                <td class="tweet-text">{{ tweet.text }}</td>
                <td>{{ tweet.textSource || "-" }}</td>
                <td>{{ tweet.metrics?.likes ?? "-" }}</td>
              </tr>
              <tr v-if="!tweets.length">
                <td colspan="5" class="empty-cell">暂无 tweet 数据。</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </main>
  </div>
</template>
