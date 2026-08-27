<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { Capacitor } from '@capacitor/core'
import { StatusBar } from '@capacitor/status-bar'
import { useDataStore } from './stores/data'
import { useChatStore } from './stores/chat'
import { db } from './db'
import { initKeyboardHeight } from './engine/keyboard'
import ChatView from './views/ChatView.vue'
import PanelView from './views/PanelView.vue'
import SettingsView from './views/SettingsView.vue'
import Icon from './components/Icon.vue'

const ds = useDataStore()
const chat = useChatStore()
const tab = ref<'chat' | 'panel' | 'settings'>(readHash())
const toast = ref('')
let toastTimer: number | undefined

// ---- v2.0 面板红点（待确认操作 + 待确认条目） ----
const pendingBadge = ref(0)
async function refreshBadge() {
  const cid = chat.currentCampaignId
  if (!cid) { pendingBadge.value = 0; return }
  const [ops, entries] = await Promise.all([
    db.ops.where('campaignId').equals(cid).and((o) => o.status === 'pending').count(),
    (async () => {
      const c = chat.currentCampaign
      if (!c?.notebookWorldbookId) return 0
      return db.entries.where('worldbookId').equals(c.notebookWorldbookId).and((e) => e.status === 'pending').count()
    })(),
  ])
  pendingBadge.value = ops + entries
}
watch(() => [chat.currentCampaignId, chat.lastOpCount, ds.entries.length], () => refreshBadge(), { deep: true })
onMounted(refreshBadge)

// ---- 主题（深色梦境） ----
const theme = ref<'light' | 'dark'>(localStorage.getItem('dream-theme') === 'dark' ? 'dark' : 'light')
function applyTheme() {
  document.documentElement.setAttribute('data-theme', theme.value)
  localStorage.setItem('dream-theme', theme.value)
}
function toggleTheme() {
  theme.value = theme.value === 'light' ? 'dark' : 'light'
  applyTheme()
}
applyTheme()

function readHash(): 'chat' | 'panel' | 'settings' {
  const h = location.hash.replace('#/', '')
  return h === 'panel' || h === 'settings' ? h : 'chat'
}

function setTab(t: 'chat' | 'panel' | 'settings') {
  tab.value = t
  location.hash = '/' + t
}

window.addEventListener('hashchange', () => { tab.value = readHash() })

function showToast(msg: string) {
  toast.value = msg
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (toast.value = ''), 2200)
}

defineExpose({ showToast })

onMounted(async () => {
  // 键盘高度全局跟踪（--kb-h CSS 变量，输入框/底部导航避让）
  await initKeyboardHeight()
  // 原生端：WebView 不延伸到系统状态栏之下（避免顶栏与时间栏重叠）
  if (Capacitor.isNativePlatform()) {
    try {
      const sb = StatusBar as any
      await sb.setOverlaysWebView({ overlaysWebView: false })
      await sb.setBackgroundColor({ color: '#f6f4ef' })
      // 状态栏不透明 + 深色图标
      await sb.setStyle({ style: 1 /* Dark */ })
    } catch { /* 兜底：CSS safe-area 已处理 */ }
  }
  await ds.init()
  // 默认打开最近活跃存档
  const recent = ds.campaigns.sort((a, b) => b.lastActive - a.lastActive)[0]
  if (recent?.id) await chat.openCampaign(recent.id)
})
</script>

<template>
  <div style="min-height:100%">
    <ChatView v-show="tab === 'chat'" />
    <PanelView v-show="tab === 'panel'" />
    <SettingsView v-show="tab === 'settings'" />
    <nav class="tabbar">
      <button class="tab" :class="{ active: tab === 'chat' }" @click="setTab('chat')">
        <span class="ico"><Icon name="chat" :size="20" /></span>对话
      </button>
      <button class="tab" :class="{ active: tab === 'panel' }" @click="setTab('panel')">
        <span class="ico" style="position:relative"><Icon name="panel" :size="20" />
          <span v-if="pendingBadge > 0" class="tab-badge">{{ pendingBadge > 99 ? '99+' : pendingBadge }}</span>
        </span>面板
      </button>
      <button class="tab" :class="{ active: tab === 'settings' }" @click="setTab('settings')">
        <span class="ico"><Icon name="gear" :size="20" /></span>设置
      </button>
    </nav>
    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>
