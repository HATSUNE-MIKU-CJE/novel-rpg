<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted, onUnmounted } from 'vue'
import { db } from '../db'
import { useDataStore } from '../stores/data'
import { useChatStore, type StartGamePack } from '../stores/chat'
import CharacterDetail from './CharacterDetail.vue'
import type { Message, Character, StreamKind } from '../types'
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
const charInjectSel = ref(true)

// ---- 存档选择弹层 ----
const showCampaigns = ref(false)

async function openCampaign(id: number) {
  await chat.openCampaign(id)
  showCampaigns.value = false
  scrollBottom(false)
}

async function createCampaign() {
  const name = newName.value.trim()
  if (!name) return
  const id = await ds.saveCampaign(ds.defaultCampaign({
    name,
    presetId: selPreset.value || undefined,
    ctxBudget: ctxBudgetSel.value,
    charInject: charInjectSel.value ? 1 : 0,
  }))
  newName.value = ''
  selPreset.value = 0
  ctxBudgetSel.value = 1000000
  charInjectSel.value = true
  showNewCampaign.value = false
  await openCampaign(id)
}

function parseMsg(m: Message): (ParsedDream & { kind?: string; title?: string; events?: Array<{ time?: string; place?: string; desc: string }> }) | null {
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

// ---- 滚动（消息区独立滚动；键盘弹出时整体布局高度收缩，输入框不被盖住） ----
const listPad = ref(24)
/** 键盘高度（visualViewport 与 innerHeight 的差；WebView 已自动 resize 则为 0） */
const kbHeight = ref(0)
const layoutStyle = computed(() => {
  const kb = kbHeight.value
  return kb > 0
    ? { height: `calc(100dvh - 60px - env(safe-area-inset-bottom, 0px) - ${kb}px)` }
    : undefined
})
function scrollBottom(smooth = true) {
  nextTick(() => listEl.value?.scrollTo({ top: listEl.value.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }))
}
function onViewport() {
  const vv = window.visualViewport
  if (!vv) return
  kbHeight.value = Math.max(0, window.innerHeight - vv.height)
}
onMounted(() => window.visualViewport?.addEventListener('resize', onViewport))
onUnmounted(() => window.visualViewport?.removeEventListener('resize', onViewport))

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

watch(() => chat.messages.length, () => scrollBottom())
watch(() => chat.currentStream, () => scrollBottom(false))

const campaignName = computed(() => chat.currentCampaign?.name || '')

// ---- 主题切换（跟随 App） ----
const isDark = ref(localStorage.getItem('dream-theme') === 'dark')
function toggleTheme() {
  isDark.value = !isDark.value
  localStorage.setItem('dream-theme', isDark.value ? 'dark' : 'light')
  document.documentElement.setAttribute('data-theme', isDark.value ? 'dark' : 'light')
}

// ---- 交流 / 游戏 双流切换 ----
async function switchStream(s: StreamKind) {
  await chat.switchStream(s)
  scrollBottom(false)
}

// ---- 本地轻提示 ----
const toast = ref('')
let toastTimer: number | undefined
function showToast(msg: string) {
  toast.value = msg
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (toast.value = ''), 2600)
}

// ---- 双向同步按钮 ----
async function syncFromTalk() {
  const r = await chat.syncFrom('talk')
  showToast(r.skipped ? '交流栏暂无新设定' : `已同步设定：角色 ${r.chars} · 关系 ${r.rels} · 事实 ${r.facts}（待审阅）`)
}
async function syncFromGame() {
  const r = await chat.syncFrom('game')
  showToast(r.skipped ? '游戏进程暂无新内容' : `已更新：角色 ${r.chars} · 关系 ${r.rels} · 事实 ${r.facts}（待审阅）`)
}

// ---- 章节总结 ----
async function doSummary() {
  const s = await chat.generateSummary()
  if (s) { showToast(`已生成章节「${s.title}」`); scrollBottom() }
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

async function jumpToMsg(id: number) {
  searchOpen.value = false
  const idx = chat.messages.findIndex((m) => m.id === id)
  if (idx >= 0) {
    nextTick(() => {
      const els = listEl.value?.querySelectorAll('[data-msg]')
      els?.[idx]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }
}

// ---- 开始游戏向导（3+1：提炼 → 设定卡确认 → 开场白） ----
const startFlow = ref(false)
const startLoading = ref(false)
const startPack = ref<StartGamePack | null>(null)
const startChars = ref<Character[]>([])
const charDetail = ref<Character | null>(null)

async function beginStart() {
  startLoading.value = true
  startFlow.value = true
  startPack.value = null
  const pack = await chat.prepareStartGame()
  startPack.value = pack
  if (pack) {
    const cid = chat.currentCampaignId
    startChars.value = cid ? await db.characters.where('campaignId').equals(cid).toArray() : []
  }
  startLoading.value = false
}

async function confirmStart(withOpening: boolean) {
  if (!startPack.value) return
  const pack = startPack.value
  await chat.commitStartGame(pack.opening, withOpening)
  startFlow.value = false
  startPack.value = null
  showToast(withOpening ? '梦境已开启 ✨' : '梦境已开启（未写开场）✨')
  scrollBottom(false)
}

async function saveCharDetail(updated: Character) {
  charDetail.value = null
  const cid = chat.currentCampaignId
  if (cid) startChars.value = await db.characters.where('campaignId').equals(cid).toArray()
}
</script>

<template>
  <div class="chat-layout" :style="layoutStyle">
    <!-- 头部：存档切换 -->
    <header class="chat-header" @click="showCampaigns = true">
      <div style="font-size:18px">📖</div>
      <div style="flex:1; min-width:0">
        <div class="campaign-name">{{ campaignName || '未选择存档' }}</div>
        <div class="hint">
          {{ chat.currentStream === 'talk' ? '💬 交流 · 设计商谈' : '🎮 游戏 · 梦境推进' }} ·
          {{ chat.messages.length }} 条 ·
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
      <input v-model="searchText" placeholder="搜索这条梦境…" autofocus />
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

    <!-- 流切换条（交流 / 游戏） -->
    <div v-if="chat.currentCampaignId" class="stream-bar">
      <div class="stream-tabs">
        <button
          class="stream-tab"
          :class="{ active: chat.currentStream === 'talk' }"
          @click="switchStream('talk')"
        >💬 交流<span class="stream-sub">设定商谈</span></button>
        <button
          class="stream-tab"
          :class="{ active: chat.currentStream === 'game' }"
          @click="switchStream('game')"
        >🎮 游戏<span class="stream-sub">梦境推进</span></button>
      </div>
      <div class="stream-actions">
        <template v-if="chat.currentStream === 'talk'">
          <button class="btn btn-warm btn-sm" :disabled="chat.organizing" @click="syncFromGame">
            {{ chat.organizing ? '同步中…' : '↻ 更新' }}
          </button>
        </template>
        <template v-else>
          <button class="btn btn-ghost btn-sm" :disabled="chat.compacting" @click="chat.compactContext()">
            {{ chat.compacting ? '压缩中…' : '🗜 压缩' }}
          </button>
          <button class="btn btn-ghost btn-sm" :disabled="chat.organizing" @click="doSummary">📜 总结</button>
          <button class="btn btn-warm btn-sm" :disabled="chat.organizing" @click="syncFromTalk">
            {{ chat.organizing ? '同步中…' : '↻ 同步设定' }}
          </button>
        </template>
      </div>
    </div>

    <!-- 消息流 -->
    <div ref="listEl" class="chat-scroll" :style="{ paddingBottom: listPad + 'px' }" v-if="chat.currentCampaignId">
      <!-- 游戏栏 · 未开始：开始游戏入口 -->
      <div v-if="chat.currentStream === 'game' && !chat.inGame" class="start-gate card">
        <div style="font-size:34px; text-align:center; margin-top:8px">🎮</div>
        <div class="start-gate-title">梦境尚未开启</div>
        <div class="list-sub" style="text-align:center; margin-top:6px">
          先到 💬 交流栏和主持约好世界观、角色与基调<br />
          再回到这里开始你的梦境
        </div>
        <button class="btn btn-primary btn-block" style="margin-top:16px" :disabled="startLoading || chat.sending" @click="beginStart">
          🚀 开始游戏{{ startLoading ? '…' : '' }}
        </button>
      </div>

      <template v-else>
        <div v-if="chat.messages.length === 0" class="empty-hint">
          <template v-if="chat.currentStream === 'talk'">
            和 AI 组队设计你的梦境游戏吧 🌙<br />
            聊聊：想玩什么世界？扮演谁？什么基调？<br />
            聊够了，点「🎮 游戏」开始梦境
          </template>
          <template v-else>
            新的梦境还未开始<br />
            写下你的第一句话吧 ✨
          </template>
        </div>

        <template v-for="(m, idx) in chat.messages" :key="m.id ?? idx">
          <div :data-msg="true">
            <!-- 前情摘要卡（游戏流） -->
            <div v-if="idx === 0 && chat.currentStream === 'game' && chat.currentCampaign?.summary" class="msg-scene" style="background: var(--warm-soft); color: var(--warm)">
              📜 <b>前情摘要</b>：{{ chat.currentCampaign.summary.slice(0, 200) }}
            </div>

            <!-- 章节回顾卡（游戏流） -->
            <div v-if="m.role === 'assistant' && parseMsg(m)?.kind === 'summary'" class="summary-card">
              <div class="summary-title">📜 {{ parseMsg(m)!.title }}</div>
              <div v-for="(ev, ei) in (parseMsg(m)!.events || [])" :key="ei" class="summary-row">
                <span class="summary-dot">◆</span>
                <div>
                  <span v-if="ev.time" class="summary-meta">🕐 {{ ev.time }}</span>
                  <span v-if="ev.place" class="summary-meta">📍 {{ ev.place }}</span>
                  <div class="summary-desc">{{ ev.desc }}</div>
                </div>
              </div>
            </div>

            <!-- 场景卡（游戏流） -->
            <div v-else-if="m.role === 'assistant' && chat.currentStream === 'game' && parseMsg(m)?.scene" class="msg-scene">
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

            <!-- token 统计（游戏流） -->
            <div v-if="m.role === 'assistant' && chat.currentStream === 'game' && usageOf(m)" class="msg-usage">
              ↑ {{ fmtTokens(usageOf(m)!.promptTokens) }} ↓ {{ fmtTokens(usageOf(m)!.completionTokens) }}
              共 {{ fmtTokens(usageOf(m)!.totalTokens) }} token
              <template v-if="usageOf(m)!.costYuan"> · ¥{{ usageOf(m)!.costYuan!.toFixed(4) }}<span v-if="usageOf(m)!.peak" style="opacity:.7">（高峰）</span></template>
              <span class="msg-usage-del" @click="chat.regenerate()">↻ 重发</span>
            </div>

            <!-- 后置格式（状态栏等，游戏流） -->
            <div v-if="m.role === 'assistant' && chat.currentStream === 'game' && parseMsg(m)?.afterFormat" class="after-format">
              {{ parseMsg(m)!.afterFormat }}
            </div>

            <!-- 选项按钮（游戏流） -->
            <div v-if="m.role === 'assistant' && chat.currentStream === 'game' && parseMsg(m)?.options?.length">
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
          {{ chat.currentStream === 'talk' ? '思客正在思考…' : '思客正在编织梦境…' }}
        </div>
        <div v-if="chat.error" class="msg-error">⚠️ {{ chat.error }}</div>
      </template>
    </div>

    <div v-else class="chat-scroll">
      <div class="empty-hint">
        还没有存档<br />
        点上方「＋ 新档」开始你的第一个梦境
      </div>
    </div>

    <!-- 输入栏（布局底部块，键盘弹出自动上移） -->
    <div v-if="chat.currentCampaignId && !(chat.currentStream === 'game' && !chat.inGame)" class="chat-inputbar">
      <textarea
        v-model="draft"
        :placeholder="chat.currentStream === 'talk' ? '和主持聊聊设定、角色或想法…' : '书写你的行动、话语或念头…'"
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
              {{ c.gameStarted ? '🎮 游戏中' : '💬 交流中' }}
              · 自动整理 {{ c.autoInterval ? `每 ${c.autoInterval} 轮` : '关闭' }} ·
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
        <div class="field" style="display:flex; align-items:center; gap:8px">
          <input type="checkbox" v-model="charInjectSel" style="width:auto" />
          <label style="margin:0; font-size:13.5px">角色卡注入对话（AI 记得角色设定）</label>
        </div>
        <button class="btn btn-primary btn-block" @click="createCampaign">创建</button>
        <div class="list-sub" style="margin-top:8px; text-align:center">
          创建后先进入 💬 交流栏，和 AI 约定设定后再开始游戏
        </div>
      </div>
    </div>

    <!-- 开始游戏向导弹层 -->
    <div v-if="startFlow" class="modal-mask" @click.self="startLoading ? null : (startFlow = false)">
      <div class="modal-sheet">
        <div class="modal-title">{{ startLoading ? '🔮 正在提炼设定…' : '开局设定卡' }}</div>

        <div v-if="startLoading" class="empty-hint">
          把交流记录提炼成设定与角色<br />
          再请 AI 起草开场白……
        </div>

        <template v-else-if="startPack">
          <div class="field">
            <label>🌍 世界观要点（可修改）</label>
            <textarea v-model="startPack.worldview" rows="3"></textarea>
          </div>

          <div v-if="startChars.length" class="field">
            <label>👤 角色卡（点击可编辑属性）</label>
            <div class="char-card-grid">
              <div v-for="c in startChars" :key="c.id" class="char-card" @click="charDetail = c">
                <div class="char-avatar">{{ c.name.slice(0, 1) }}</div>
                <div class="list-title">{{ c.name }}</div>
                <div class="list-sub">{{ c.identity || '身份未知' }}</div>
              </div>
            </div>
          </div>

          <div class="field">
            <label>✨ 开场白（可修改，选「先不写」则不生成）</label>
            <textarea v-model="startPack.opening" rows="5"></textarea>
          </div>

          <button class="btn btn-primary btn-block" @click="confirmStart(true)">🚀 开始游戏（含开场白）</button>
          <button class="btn btn-ghost btn-block" style="margin-top:8px" @click="confirmStart(false)">开始游戏（先不写开场）</button>
        </template>

        <div v-else class="empty-hint">
          开局包生成失败：{{ chat.error || '未知错误' }}<br />
          <button class="btn btn-soft btn-sm" style="margin-top:10px" @click="beginStart">重试</button>
        </div>
      </div>
    </div>

    <!-- 角色详情弹层（开局向导内编辑） -->
    <CharacterDetail
      v-if="charDetail"
      :character="charDetail"
      :schema="chat.attrSchema()"
      @close="charDetail = null"
      @saved="saveCharDetail"
    />

    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>

<script lang="ts">
export default { name: 'ChatView' }
</script>
