<script setup>
import { onBeforeUnmount, onMounted, ref } from "vue";
import {
  AtSign,
  CheckCircle2,
  CircleAlert,
  Clock3,
  RefreshCw,
  Save,
  Settings,
  Target,
  X
} from "@lucide/vue";
import { getShanghaiDate } from "./format";
import {
  clearFeedback,
  connection,
  error,
  extensionClients,
  loading,
  notice,
  requestRefresh,
  saveConnection
} from "./state";

const showConnection = ref(false);

function submitConnection() {
  clearFeedback();
  saveConnection();
  showConnection.value = false;
}

function handleEscape(event) {
  if (event.key === "Escape" && showConnection.value) showConnection.value = false;
}

onMounted(() => window.addEventListener("keydown", handleEscape));
onBeforeUnmount(() => window.removeEventListener("keydown", handleEscape));
</script>

<template>
  <main class="app-shell">
    <header class="topbar">
      <RouterLink class="brand" to="/targets" aria-label="Twitter Timeline 管理台首页">
        <span class="brand-mark"><AtSign :size="20" /></span>
        <div><strong>Twitter Timeline</strong><small>Automator / 管理台</small></div>
      </RouterLink>
      <nav class="module-nav" aria-label="管理模块">
        <RouterLink to="/targets"><Target :size="16" />目标账号</RouterLink>
        <RouterLink to="/history"><Clock3 :size="16" />数据列表</RouterLink>
      </nav>
      <div class="top-actions">
        <span class="connection-state">
          <span class="status-dot" :class="{ muted: !extensionClients }"></span>
          {{ extensionClients ? `${extensionClients} 个扩展已连接` : "等待扩展连接" }}
        </span>
        <button class="icon-button" title="连接设置" aria-label="连接设置" @click="showConnection = true">
          <Settings :size="17" />
        </button>
        <button class="icon-button" title="刷新当前模块" aria-label="刷新当前模块" :disabled="loading" @click="requestRefresh">
          <RefreshCw :size="17" :class="{ spinning: loading }" />
        </button>
      </div>
    </header>

    <p v-if="error" class="feedback feedback-error"><CircleAlert :size="16" />{{ error }}</p>
    <p v-if="notice" class="feedback"><CheckCircle2 :size="16" />{{ notice }}</p>

    <RouterView />

    <footer>Twitter Automator <span>·</span> SQLite local data service <span>·</span> {{ getShanghaiDate() }}</footer>
  </main>

  <Teleport to="body">
    <div v-if="showConnection" class="overlay centered" @click.self="showConnection = false">
      <section class="connection-dialog" role="dialog" aria-modal="true" aria-label="连接设置">
        <header class="section-heading">
          <div><p class="eyebrow">Connection</p><h2>连接设置</h2></div>
          <button class="icon-button" title="关闭" aria-label="关闭连接设置" @click="showConnection = false"><X :size="17" /></button>
        </header>
        <label>API Base URL<input v-model="connection.baseUrl" type="url" /></label>
        <label>API Token<input v-model="connection.apiToken" type="password" /></label>
        <button class="solid-button wide" @click="submitConnection"><Save :size="15" />保存并重新连接</button>
      </section>
    </div>
  </Teleport>
</template>
