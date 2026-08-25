<script setup lang="ts">
import { ref, computed, nextTick, watch } from 'vue'
import { useDataStore } from '../stores/data'
import { useChatStore } from '../stores/chat'
import { DREAM_GROUPS, type DreamConfig } from '../engine/dreamPreset'
import type { Message } from '../types'
import type { ParsedDream } from '../engine/dreamParser'

const ds = useDataStore()
const chat = useChatStore()

const draft = ref('')
const listEl = ref<HTMLElement>()
const showNewCampaign = ref(false)
const newName = ref('')
const selPreset = ref(0)
const searchOpen = ref(false)
const searchText = ref('')
const ctxBudgetSel = ref(1000000)

// ---- 存档选择弹层 ----
const showCampaigns = ref(false)

async function openCampaign(id: number) {
  await chat.openCampaign(id)
  showCampaigns.value = false
  scrollBottom()
}

async function createCampaign() {
  const name = newName.value.trim()
  if (!name) return
  const id = await ds.saveCampaign(ds.defaultCampaign({
    name,
    presetId: selPreset.value || undefined,
    ctxBudget: ctxBudgetSel.value,
  }))
  newName.value = ''
  selPreset.value = 0
  ctxBudgetSel.value = 1000000
  showNewCampaign.value = false
  await openCampaign(id)
}

function parseMsg(m: Message): ParsedDream | null {
  try { return m.parsedJson ? JSON.parse(m.parsedJson) : null } catch { return null }
}

function bodyOf(m: Message): string {
  if (m.role === 'user') return m.content
  return parseMsg(m)?.body || m.content
}

function usageOf(m: Message): { promptTokens?: number; completionTokens?: number; totalTokens?: number; costYuan?: number; peak?: boolean } | null {
  try { return m.usageJson ? JSON.parse(m.usageJson) : null } catch { return null }
}

function fmtTokens(n?: number): string {
  if (!n) return ''
  if (n >= 1e6) return Math.round(n / 1e5) / 10 + 'M'
  if (n >= 1e3) return Math.round(n / 100) / 10 + 'k'
  return String(n)
}

function scrollBottom() {
  nextTick(() => listEl.value?.scrollTo({ top: listEl.value.scrollHeight }))
}

function scrollToTop() {
  nextTick(() => listEl.value?.scrollTo({ top: 0 }))
}

/** 点击选项 → 作为用户消息发送 */
async function pickOption(opt: string) {
  draft.value = opt
  await send()
}

async function send() {
  const text = draft.value.trim()
  if (!text || chat.sending) return
  draft.value = ''
  await chat.sendUserMessage(text)
  scrollBottom()
}

watch(() => chat.messages.length, scrollBottom)

const campaignName = computed(() => chat.currentCampaign?.name || '')

// ---- 主题切换（跟随 App） ----
const isDark = ref(localStorage.getItem('dream-theme') === 'dark')
function toggleTheme() {
  isDark.value = !isDark.value
  localStorage.setItem('dream-theme', isDark.value ? 'dark' : 'light')
  document.documentElement.setAttribute('data-theme', isDark.value ? 'dark' : 'light')
}

// ---- 输出模式快捷切换（内置预设）----
const modeOptions = [
  { id: 'writing', label: '✍️ 写作' },
  { id: 'big_summary', label: '📜 总结' },
  { id: 'chat', label: '💬 聊天' },
  { id: 'create', label: '🎨 创作' },
]
const currentMode = computed(() =>
  (chat.dreamConfig()?.output_mode as string) || 'writing',
)

async function switchMode(id: string) {
  const cfg = chat.dreamConfig() as DreamConfig | null
  if (!cfg) return
  cfg.output_mode = id
  const c = chat.currentCampaign!
  c.dreamConfigJson = JSON.stringify(cfg)
  await ds.saveCampaign(c)
}

// ---- 搜索 ----
const searchResults = computed(() => {
  const q = searchText.value.trim()
  if (!q) return []
  return chat.messages.filter((m) => m.content.includes(q)).slice(-30)
})

// ---- 思维链折叠状态（按消息 id 记录） ----
const expandedReasoning = ref<Set<number>>(new Set())
function toggleReasoning(id?: number) {
  if (!id) return
  const s = new Set(expandedReasoning.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  expandedReasoning.value = s
}
/** 剪掉正文里残留的 think 标签片段（模型有时把思考写进正文） */
function stripThinkTag(text: string): string {
  return text.replace(/⟦THINK⟧|<\/?think>|<\/?THINK>|<\|open\|>think<\|sep\|>/gi, '').trim()
}

async function jumpToMsg(id: number) {
  searchOpen.value = false
  // 简单滚动到目标：将消息列表 scroll 到消息附近（按 idx 估算）
  const idx = chat.messages.findIndex((m) => m.id === id)
  if (idx >= 0) {
    nextTick(() => {
      const els = listEl.value?.querySelectorAll('[data-msg]')
      els?.[idx]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }
}
</script>

<template>
  <div>
    <!-- 头部：存档切换 -->
    <header class="chat-header" @click="showCampaigns = true">
      <div style="font-size:18px">📖</div>
      <div style="flex:1; min-width:0">
        <div class="campaign-name">{{ campaignName || '未选择存档' }}</div>
        <div class="hint">
          点按切换存档 · {{ chat.messages.length }} 条 ·
          {{ fmtTokens(chat.totalTokens) }} token
          <template v-if="chat.totalCost"> · ¥{{ chat.totalCost.toFixed(3) }}</template>
        </div>
      </div>
      <button class="btn btn-ghost btn-sm" @click.stop="toggleTheme">{{ isDark ? '☀️' : '🌙' }}</button>
      <button class="btn btn-ghost btn-sm" @click.stop="searchOpen = !searchOpen">🔍</button>
      <button class="btn btn-soft btn-sm" @click.stop="showNewCampaign = true">＋ 新档</button>
    </header>

    <!-- 搜索条 -->
    <div v-if="searchOpen" class="search-bar">
      <input v-model="searchText" placeholder="搜索这段梦境…" autofocus />
      <div v-if="searchResults.length" class="search-results">
        <div
          v-for="r in searchResults"
          :key="r.id"
          class="search-item"
          @click="jumpToMsg(r.id!)"
        >
          <span class="search-role">{{ r.role === 'user' ? '梦客' : '思客' }}</span>
          {{ bodyOf(r).slice(0, 40) }}
        </div>
      </div>
    </div>

    <!-- 快捷工具栏：模式切换 + 压缩 -->
    <div v-if="chat.currentCampaignId && chat.dreamConfig()" class="quickbar">
      <div class="mode-tabs">
        <button
          v-for="opt in modeOptions"
          :key="opt.id"
          class="btn btn-sm"
          :class="currentMode === opt.id ? 'btn-primary' : 'btn-ghost'"
          @click="switchMode(opt.id)"
        >{{ opt.label }}</button>
      </div>
      <button
        class="btn btn-warm btn-sm"
        :disabled="chat.compacting"
        @click="chat.compactContext()"
      >{{ chat.compacting ? '压缩中…' : '🗜 压缩' }}</button>
    </div>

    <!-- 消息流 -->
    <div ref="listEl" class="page" style="padding-bottom: 130px" v-if="chat.currentCampaignId">
      <div v-if="chat.messages.length === 0" class="empty-hint">
        新的梦境还未开始<br />写下你的第一句话吧 ✨
      </div>

      <template v-for="(m, idx) in chat.messages" :key="m.id ?? idx">
        <div :data-msg="true">
          <!-- 前情摘要卡 -->
          <div v-if="idx === 0 && chat.currentCampaign?.summary" class="msg-scene" style="background: var(--warm-soft); color: var(--warm)">
            📜 <b>前情摘要</b>：{{ chat.currentCampaign.summary.slice(0, 200) }}
          </div>

          <!-- 场景卡 -->
          <div v-if="m.role === 'assistant' && parseMsg(m)?.scene" class="msg-scene">
            <span v-if="parseMsg(m)!.scene!.date"><b>🗓</b>{{ parseMsg(m)!.scene!.date }}</span>
            <span v-if="parseMsg(m)!.scene!.time"><b>🕐</b>{{ parseMsg(m)!.scene!.time }}</span>
            <span v-if="parseMsg(m)!.scene!.location"><b>📍</b>{{ parseMsg(m)!.scene!.location }}</span>
          </div>

          <!-- 消息体 -->
          <div v-if="m.role === 'user'" class="msg-card msg-user">{{ m.content }}</div>
          <template v-else>
            <!-- 思维链（可折叠） -->
            <div v-if="m.reasoning" class="reasoning-block">
              <button class="reasoning-toggle" @click="toggleReasoning(m.id)">
                <span class="reasoning-icon">{{ expandedReasoning.has(m.id!) ? '▼' : '▶' }}</span>
                思维链（{{ fmtTokens(m.reasoning.length) }} 字符）
              </button>
              <div v-if="expandedReasoning.has(m.id!)" class="reasoning-body">{{ m.reasoning }}</div>
            </div>
            <div class="msg-card">{{ bodyOf(m) }}</div>
          </template>

          <!-- token 统计 -->
          <div v-if="m.role === 'assistant' && usageOf(m)" class="msg-usage">
            ↑ {{ fmtTokens(usageOf(m)!.promptTokens) }} ↓ {{ fmtTokens(usageOf(m)!.completionTokens) }}
            共 {{ fmtTokens(usageOf(m)!.totalTokens) }} token
            <template v-if="usageOf(m)!.costYuan"> · ¥{{ usageOf(m)!.costYuan!.toFixed(4) }}<span v-if="usageOf(m)!.peak" style="opacity:.7">（高峰）</span></template>
            <span class="msg-usage-del" @click="chat.regenerate()">↻ 重发</span>
          </div>

          <!-- 后置格式（状态栏等） -->
          <div v-if="m.role === 'assistant' && parseMsg(m)?.afterFormat" class="after-format">
            {{ parseMsg(m)!.afterFormat }}
          </div>

          <!-- 选项按钮 -->
          <div v-if="m.role === 'assistant' && parseMsg(m)?.options?.length">
            <button
              v-for="(opt, oi) in parseMsg(m)!.options"
              :key="oi"
              class="opt-btn"
              :disabled="chat.sending"
              @click="pickOption(opt)"
            >✨ {{ opt }}</button>
          </div>
        </div>
      </template>

      <div v-if="chat.sending" class="msg-card" style="color: var(--ink-soft); font-size: 13.5px">
        思客正在编织梦境…
      </div>
      <div v-if="chat.error" class="msg-error">⚠️ {{ chat.error }}</div>
    </div>

    <div v-else class="page">
      <div class="empty-hint">
        还没有存档<br />
        点上方「＋ 新档」开始你的第一个梦境
      </div>
    </div>

    <!-- 输入栏 -->
    <div v-if="chat.currentCampaignId" class="chat-input">
      <textarea
        v-model="draft"
        placeholder="书写你的行动、话语或念头…"
        :disabled="chat.sending"
        rows="1"
        @keydown.enter.exact.prevent="send"
      ></textarea>
      <button class="send-btn" :disabled="chat.sending || !draft.trim()" @click="send">➤</button>
    </div>

    <!-- 存档选择弹层 -->
    <div v-if="showCampaigns" class="modal-mask" @click.self="showCampaigns = false">
      <div class="modal-sheet">
        <div class="modal-title">选择存档</div>
        <div v-if="!ds.campaigns.length" class="empty-hint">暂无存档</div>
        <div
          v-for="c in ds.campaigns"
          :key="c.id"
          class="list-row"
          @click="openCampaign(c.id!)"
        >
          <div>
            <div class="list-title">{{ c.name }}</div>
            <div class="list-sub">
              自动整理 {{ c.autoInterval ? `每 ${c.autoInterval} 轮` : '关闭' }} ·
              {{ (c.statTokens ?? 0) >= 1000 ? ((c.statTokens ?? 0) / 1000).toFixed(1) + 'k' : (c.statTokens ?? 0) }} token
              <template v-if="c.statCostYuan"> · ¥{{ c.statCostYuan.toFixed(3) }}</template>
              <br />更新于 {{ new Date(c.lastActive).toLocaleString() }}
            </div>
          </div>
          <button class="btn btn-danger btn-sm" @click.stop="ds.deleteCampaign(c.id!)">删</button>
        </div>
        <div style="margin-top: 14px">
          <button class="btn btn-primary btn-block" @click="showNewCampaign = true">＋ 新建存档</button>
        </div>
      </div>
    </div>

    <!-- 新建存档弹层 -->
    <div v-if="showNewCampaign" class="modal-mask" @click.self="showNewCampaign = false">
      <div class="modal-sheet">
        <div class="modal-title">新建存档</div>
        <div class="field">
          <label>存档名</label>
          <input v-model="newName" placeholder="如：我的梦境 · 夜航星海" />
        </div>
        <div class="field">
          <label>预设</label>
          <select v-model="selPreset">
            <option :value="0">梦鲸思客 · 精简（默认，可调开关）</option>
            <option v-for="p in ds.presets" :key="p.id" :value="p.id!">外部预设：{{ p.name }}</option>
          </select>
        </div>
        <div class="field">
          <label>上下文预算</label>
          <select v-model="ctxBudgetSel">
            <option :value="1000000">1M（默认）</option>
            <option :value="500000">500k</option>
            <option :value="200000">200k</option>
            <option :value="128000">128k</option>
            <option :value="0">关闭压缩</option>
          </select>
        </div>
        <button class="btn btn-primary btn-block" @click="createCampaign">创建</button>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
export default { name: 'ChatView' }
</script>
