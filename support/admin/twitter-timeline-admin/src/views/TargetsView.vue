<script setup>
import { computed, reactive, ref, watch } from "vue";
import {
  CalendarClock,
  CheckCircle2,
  Edit3,
  ExternalLink,
  Hash,
  LoaderCircle,
  Play,
  Plus,
  Save,
  Target,
  X
} from "@lucide/vue";
import { formatTime } from "../format";
import {
  clearFeedback,
  client,
  loading,
  refreshVersion,
  showError,
  showNotice,
  syncServiceState
} from "../state";

const stats = ref({ totalTargets: 0, enabledTargets: 0, totalJobs: 0, todayJobs: 0, failedJobs: 0, totalTweets: 0 });
const schedule = reactive({ scheduleTime: "09:00", timeZone: "Asia/Shanghai", nextRunAt: null });
const targets = ref([]);
const savingTarget = ref(false);
const savingSchedule = ref(false);
const runningTargetId = ref("");
const targetForm = reactive({
  targetId: "",
  username: "",
  displayName: "",
  maxTweets: 100,
  enabled: true
});

const metrics = computed(() => [
  { label: "目标账号", value: stats.value.totalTargets, icon: Target },
  { label: "自动执行", value: stats.value.enabledTargets, icon: CheckCircle2 },
  { label: "今日任务", value: stats.value.todayJobs, icon: CalendarClock },
  { label: "累计任务", value: stats.value.totalJobs, icon: Hash }
]);
const isEditingTarget = computed(() => Boolean(targetForm.targetId));

async function loadTargetsPage() {
  loading.value = true;
  clearFeedback();
  try {
    const [statsResult, settingsResult, targetsResult] = await Promise.all([
      client.value.getStats(),
      client.value.getSettings(),
      client.value.listTargets()
    ]);
    stats.value = statsResult.stats;
    syncServiceState(statsResult);
    schedule.scheduleTime = settingsResult.settings.scheduleTime;
    schedule.timeZone = settingsResult.settings.timeZone;
    schedule.nextRunAt = settingsResult.schedule.nextRunAt;
    targets.value = targetsResult.targets;
  } catch (cause) {
    showError(cause);
  } finally {
    loading.value = false;
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
    const editing = isEditingTarget.value;
    if (editing) {
      await client.value.updateTarget(targetForm.targetId, payload);
    } else {
      await client.value.createTarget(payload);
    }
    resetTargetForm();
    await loadTargetsPage();
    showNotice(`@${payload.username} ${editing ? "已更新" : "已添加"}`);
  } catch (cause) {
    showError(cause);
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
  window.scrollTo({ top: 0, behavior: "smooth" });
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

async function refreshStats() {
  const statsResult = await client.value.getStats();
  stats.value = statsResult.stats;
  syncServiceState(statsResult);
}

async function toggleTarget(target) {
  clearFeedback();
  try {
    const response = await client.value.updateTarget(target.targetId, { enabled: !target.enabled });
    targets.value = targets.value.map((item) => item.targetId === target.targetId ? response.target : item);
    await refreshStats();
  } catch (cause) {
    showError(cause);
  }
}

async function runTarget(target) {
  runningTargetId.value = target.targetId;
  clearFeedback();
  try {
    const response = await client.value.runTarget(target.targetId);
    await refreshStats();
    showNotice(`@${target.username} 任务已入队：${response.job.jobId.slice(0, 8)}，可到数据列表查看进度`);
  } catch (cause) {
    showError(cause);
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
    showNotice("每日触发时间已保存");
  } catch (cause) {
    showError(cause);
  } finally {
    savingSchedule.value = false;
  }
}

watch(refreshVersion, loadTargetsPage, { immediate: true });
</script>

<template>
  <section class="page-heading">
    <div><p class="eyebrow">Target Management</p><h1>目标账号</h1><p class="page-description">维护采集账号、单次上限与每日自动执行策略。</p></div>
    <span class="date-stamp">{{ targets.length }} 个账号 · {{ schedule.timeZone }}</span>
  </section>

  <section class="metric-grid metric-grid-four">
    <article v-for="metric in metrics" :key="metric.label" class="metric-card">
      <component :is="metric.icon" :size="18" />
      <div><span>{{ metric.label }}</span><strong>{{ metric.value.toLocaleString() }}</strong></div>
    </article>
  </section>

  <section class="operations-grid">
    <article class="workspace-section target-section">
      <header class="section-heading">
        <div><p class="eyebrow">Targets</p><h2>账号清单</h2></div>
        <span>{{ targets.length }} 个账号</span>
      </header>
      <form class="target-form" @submit.prevent="submitTarget">
        <label>用户名<input v-model="targetForm.username" required maxlength="15" placeholder="username" /></label>
        <label>显示名称<input v-model="targetForm.displayName" maxlength="100" placeholder="可选" /></label>
        <label>最大 Tweets<input v-model.number="targetForm.maxTweets" type="number" min="1" max="500" /></label>
        <label class="checkbox-field"><input v-model="targetForm.enabled" type="checkbox" /><span>每日自动执行</span></label>
        <div class="form-actions">
          <button v-if="isEditingTarget" type="button" class="text-button" @click="resetTargetForm"><X :size="14" />取消</button>
          <button class="solid-button" :disabled="savingTarget || !targetForm.username.trim()">
            <component :is="isEditingTarget ? Save : Plus" :size="15" />{{ isEditingTarget ? "保存" : "添加账号" }}
          </button>
        </div>
      </form>

      <div class="table-wrap">
        <table>
          <thead><tr><th>账号</th><th>显示名称</th><th>上限</th><th>每日自动</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="targetItem in targets" :key="targetItem.targetId">
              <td><a :href="`https://x.com/${targetItem.username}`" target="_blank" rel="noopener noreferrer" class="account-link">@{{ targetItem.username }}<ExternalLink :size="12" /></a></td>
              <td>{{ targetItem.displayName || "-" }}</td>
              <td>{{ targetItem.maxTweets }}</td>
              <td><label class="switch"><input type="checkbox" :checked="targetItem.enabled" @change="toggleTarget(targetItem)" /><span></span></label></td>
              <td>
                <div class="row-actions">
                  <button class="icon-button small" title="编辑目标" aria-label="编辑目标" @click="editTarget(targetItem)"><Edit3 :size="14" /></button>
                  <button class="icon-button small" title="立即运行" aria-label="立即运行" :disabled="runningTargetId === targetItem.targetId" @click="runTarget(targetItem)">
                    <LoaderCircle v-if="runningTargetId === targetItem.targetId" :size="14" class="spinning" /><Play v-else :size="14" />
                  </button>
                </div>
              </td>
            </tr>
            <tr v-if="!targets.length"><td colspan="5" class="empty-cell">暂无目标账号</td></tr>
          </tbody>
        </table>
      </div>
    </article>

    <article class="workspace-section schedule-section">
      <header class="section-heading"><div><p class="eyebrow">Schedule</p><h2>每日调度</h2></div><CalendarClock :size="18" /></header>
      <label class="schedule-input">触发时间<input v-model="schedule.scheduleTime" type="time" step="60" /><small>{{ schedule.timeZone }}</small></label>
      <dl class="schedule-state">
        <div><dt>下次执行</dt><dd>{{ formatTime(schedule.nextRunAt) }}</dd></div>
        <div><dt>执行范围</dt><dd>{{ stats.enabledTargets }} 个启用账号</dd></div>
      </dl>
      <button class="outline-button wide" :disabled="savingSchedule" @click="saveSchedule"><Save :size="15" />{{ savingSchedule ? "保存中" : "保存调度" }}</button>
    </article>
  </section>
</template>
