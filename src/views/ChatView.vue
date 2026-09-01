<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted, onUnmounted } from 'vue'
import { db } from '../db'
import { useDataStore } from '../stores/data'
import { readBarValues } from '../engine/bars'
import { useChatStore, type StartGamePack } from '../stores/chat'
import CharacterDetail from './CharacterDetail.vue'
import Icon from '../components/Icon.vue'
import ContextRing from '../components/ContextRing.vue'
import OpCard from '../components/OpCard.vue'
import type { Message, Character, StreamKind, Op, Entry } from '../types'
import { parseDreamPlot, type ParsedDream } from '../engine/dreamParser'
import { readStatusValues } from '../engine/cards'
import { parseCharacterPayload } from '../engine/cards-v3'

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

// ---- 滚动（消息区独立滚动；键盘高度由 App.vue 全局管理 --kb-h，键盘弹出整体收缩） ----
const listPad = ref(24)
function scrollBottom(smooth = true) {
  nextTick(() => listEl.value?.scrollTo({ top: listEl.value.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }))
}
function scrollTop() {
  nextTick(() => listEl.value?.scrollTo({ top: 0, behavior: 'smooth' }))
}

// ---- 消息长按操作（重新生成 / 编辑 / 复制） ----
const longPress = ref<Message | null>(null)
const editTarget = ref<Message | null>(null)
const editMsgOpen = ref(false)
const editMsgText = ref('')
let lpTimer: number | undefined
function msgTouchStart(m: Message) {
  clearTimeout(lpTimer)
  lpTimer = window.setTimeout(() => { longPress.value = m }, 550)
}
function msgTouchEnd() { clearTimeout(lpTimer) }
async function regenerateHere() {
  const m = longPress.value
  longPress.value = null
  if (!m) return
  await chat.regenerateAt(m.seq)
  scrollBottom()
}
function startEditMsg() {
  editTarget.value = longPress.value
  editMsgText.value = editTarget.value ? bodyOf(editTarget.value) : ''
  longPress.value = null
  editMsgOpen.value = true
}
async function saveEditMsg() {
  const m = editTarget.value
  if (!m) return
  const text = editMsgText.value.trim()
  if (text && text !== m.content) {
    await chat.editMessage(m.id!, text, m.role === 'user')
    showToast('已保存修改')
  }
  editMsgOpen.value = false
  editTarget.value = null
}
async function copyMsg() {
  const m = longPress.value
  longPress.value = null
  if (!m) return
  const text = bodyOf(m)
  try {
    await navigator.clipboard.writeText(text)
    showToast('已复制')
  } catch {
    showToast('复制失败')
  }
}

// ---- 主角状态条（HUD，仅游戏栏展示） ----
const heroState = ref<{ name: string; bars: Array<{ name: string; color: string; value: number; max: number }> } | null>(null)
async function refreshHeroBars() {
  const cid = chat.currentCampaignId
  if (!cid || chat.currentStream !== 'game') { heroState.value = null; return }
  const defs = chat.barDefs()
  if (!defs.length) { heroState.value = null; return }
  // v3.1：优先读人物卡条目（kind=character 主模式，payload.barValues）；老表只读兜底
  const mainEntry = chat.mainCharacterEntry()
  if (mainEntry) {
    const p = parseCharacterPayload(mainEntry.payloadJson)
    const vals = p.barValues ?? {}
    heroState.value = {
      name: p.name || mainEntry.key,
      bars: defs.map((d) => ({ name: d.name, color: d.color, max: d.max, value: vals[d.name] ?? d.max })),
    }
    return
  }
  const chars = await db.characters.where('campaignId').equals(cid).toArray()
  const hero = chars[0]
  if (!hero) { heroState.value = null; return }
  const vals = readBarValues(hero.barValuesJson)
  heroState.value = {
    name: hero.name,
    bars: defs.map((d) => ({ name: d.name, color: d.color, max: d.max, value: vals[d.name] ?? d.max })),
  }
}
watch(() => chat.messages.length, refreshHeroBars)
watch(() => chat.currentStream, refreshHeroBars)
watch(() => chat.currentCampaignId, refreshHeroBars)
onMounted(refreshHeroBars)

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
  // AI 操作提示（v2.0：操作卡内嵌在对方消息下方，提示就地确认）
  if (chat.lastOpCount > 0) {
    showToast(`AI 提交了 ${chat.lastOpCount} 项操作，在消息下方确认`)
    chat.lastOpCount = 0
  }
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
  showToast(r.skipped ? '交流栏暂无新设定' : `已整理交流设定：角色 ${r.chars} · 关系 ${r.rels} · 新条目 ${r.facts}${r.upd ? ` · 更新 ${r.upd} 项（待确认）` : ''}`)
}
async function syncFromGame() {
  const r = await chat.syncFrom('game')
  showToast(r.skipped ? '游戏进程暂无新内容' : `已整理游戏进程：角色 ${r.chars} · 关系 ${r.rels} · 新条目 ${r.facts}${r.upd ? ` · 更新 ${r.upd} 项（待确认）` : ''}`)
}

// ---- v3.1 大整理（剧情态势简报，只进交流栏） ----
async function doBrief() {
  const b = await chat.refreshStoryBrief()
  showToast(b ? '剧情态势已更新（交流栏主持可见）' : '大整理失败，请检查 API 配置或剧情长度')
}

// ---- v2.0 消息内嵌操作卡（交流栏） ----
const msgOps = ref<Map<number, Op[]>>(new Map())
async function refreshMsgOps() {
  const cid = chat.currentCampaignId
  if (!cid) { msgOps.value = new Map(); return }
  const list = await db.ops.where('campaignId').equals(cid).and((o) => !!o.msgId).toArray()
  const map = new Map<number, Op[]>()
  for (const o of list) {
    const arr = map.get(o.msgId!) ?? []
    arr.push(o)
    map.set(o.msgId!, arr)
  }
  msgOps.value = map
}
function opsOfMsg(id?: number): Op[] { return id ? (msgOps.value.get(id) ?? []) : [] }
/** 操作目标条目（diff 预览用） */
function opTarget(op: Op): Entry | null {
  try {
    const p = JSON.parse(op.payload)
    if (p.entryId) return ds.entries.find((e) => e.id === p.entryId) ?? null
    if (p.key) {
      const keys = String(p.key).split(/[,，]/).map((k: string) => k.trim()).filter(Boolean)
      return ds.entries.find((e) => (e.key || '').split(/[,，]/).some((k) => keys.includes(k) || keys.some((x: string) => x.includes(k) || k.includes(x)))) ?? null
    }
    return null
  } catch { return null }
}
async function confirmMsgOp(op: Op) {
  const ok = await chat.executeOp(op.id!)
  showToast(ok ? '已生效' : (chat.error || '执行失败（目标不存在）'))
  await refreshMsgOps()
}
async function rejectMsgOp(op: Op) {
  await chat.rejectOp(op.id!)
  showToast('已退回，未生效')
  await refreshMsgOps()
}
watch(() => [chat.currentCampaignId, chat.lastOpCount, chat.talkMessages.length, chat.gameMessages.length], () => refreshMsgOps())
onMounted(refreshMsgOps)

/** v2.0：交流栏未整理的用户消息数（提取横幅） */
const unorganised = computed(() => {
  const c = chat.currentCampaign
  if (!c || chat.currentStream !== 'talk') return 0
  const cutoff = c.lastSyncedTalkSeq ?? 0
  return chat.talkMessages.filter((m) => m.role === 'user' && (m.seq ?? 0) > cutoff).length
})

/** v2.1：流式实时正文（游戏流边收边剥 XML，只显示正文） */
const liveBody = computed(() => {
  if (!chat.liveText) return ''
  if (chat.currentStream === 'game') {
    try { return parseDreamPlot(chat.liveText).body } catch { return chat.liveText }
  }
  return chat.liveText
})

/** v2.2 + v3.3：状态卡展示数据（血条 HUD 下方；无值字段隐藏；随主角角色卡走） */
const statusCardState = computed(() => {
  const c = chat.currentCampaign
  const def = chat.statusCard()
  if (!c || !def.enabled) return null
  // v3.3：主角人物卡 payload.status 优先，回退存档级
  const mainEntry = chat.mainCharacterEntry()
  const vals = mainEntry
    ? (parseCharacterPayload(mainEntry.payloadJson).status ?? readStatusValues(c.statusValuesJson))
    : readStatusValues(c.statusValuesJson)
  const rows = def.fields
    .filter((f) => !f.disabled)
    .map((f) => {
      const v = vals[f.label]
      const text = f.type === 'list'
        ? (Array.isArray(v) ? v.join(' · ') : (v ? String(v) : ''))
        : (typeof v === 'string' ? v : '')
      return { label: f.label, text }
    })
    .filter((x) => x.text)
  return rows.length ? rows : null
})

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
  showToast(withOpening ? '梦境已开启' : '梦境已开启（未写开场）')
  scrollBottom(false)
}

async function saveCharDetail(updated: Character) {
  charDetail.value = null
  const cid = chat.currentCampaignId
  if (cid) startChars.value = await db.characters.where('campaignId').equals(cid).toArray()
}
</script>

<template>
  <div class="chat-layout">
    <!-- 头部：存档切换 -->
    <header class="chat-header" @click="showCampaigns = true">
      <div style="color:var(--accent-deep); display:flex"><Icon name="book" :size="20" /></div>
      <div style="flex:1; min-width:0">
        <div class="campaign-name">{{ campaignName || '未选择存档' }}</div>
        <div class="hint">
          {{ chat.currentStream === 'talk' ? '交流 · 设计商谈' : '游戏 · 梦境推进' }} ·
          {{ chat.messages.length }} 条 ·
          {{ fmtTokens(chat.totalTokens) }} token
          <template v-if="chat.totalCost"> · ¥{{ chat.totalCost.toFixed(3) }}</template>
        </div>
      </div>
      <button class="btn btn-ghost btn-sm" @click.stop="toggleTheme"><Icon :name="isDark ? 'sun' : 'moon'" :size="16" /></button>
      <button class="btn btn-ghost btn-sm" @click.stop="searchOpen = !searchOpen"><Icon name="search" :size="16" /></button>
      <button class="btn btn-soft btn-sm" @click.stop="showNewCampaign = true"><Icon name="plus" :size="14" /> 新档</button>
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
        ><Icon name="chat" :size="17" /> 交流<span class="stream-sub">设定商谈</span></button>
        <button
          class="stream-tab"
          :class="{ active: chat.currentStream === 'game' }"
          @click="switchStream('game')"
        ><Icon name="gamepad" :size="17" /> 游戏<span class="stream-sub">梦境推进</span></button>
      </div>
      <div class="stream-actions">
        <template v-if="chat.currentStream === 'talk'">
          <button class="btn btn-ghost btn-sm" :disabled="chat.compacting" @click="chat.compactContext('talk')">
            {{ chat.compacting ? '压缩中…' : '压缩' }}
          </button>
          <button class="btn btn-ghost btn-sm" :disabled="chat.organizing" @click="doBrief">
            <Icon name="clipboard" :size="13" /> {{ chat.organizing ? '整理中…' : '大整理' }}
          </button>
          <button class="btn btn-warm btn-sm" :disabled="chat.organizing" @click="syncFromTalk">
            <Icon name="refresh" :size="13" /> {{ chat.organizing ? '整理中…' : '整理设定' }}
          </button>
        </template>
        <template v-else>
          <button class="btn btn-ghost btn-sm" :disabled="chat.compacting" @click="chat.compactContext('game')">
            {{ chat.compacting ? '压缩中…' : '压缩' }}
          </button>
          <button class="btn btn-ghost btn-sm" :disabled="chat.organizing" @click="doSummary"><Icon name="scroll" :size="14" /> 总结</button>
          <button class="btn btn-warm btn-sm" :disabled="chat.organizing" @click="syncFromGame">
            <Icon name="refresh" :size="13" /> {{ chat.organizing ? '整理中…' : '整理剧情' }}
          </button>
        </template>
        <ContextRing :pct="chat.ctxPressure(chat.currentStream)" :size="22" />
      </div>
    </div>

    <!-- 消息流 -->
    <div ref="listEl" class="chat-scroll" :style="{ paddingBottom: listPad + 'px' }" v-if="chat.currentCampaignId">
      <!-- v2.0：交流栏未整理提示横幅 -->
      <div v-if="unorganised > 0 && !chat.organizing" class="extract-banner" @click="syncFromTalk">
        <Icon name="sparkle" :size="14" />
        <span class="extract-banner-text">交流中还有 {{ unorganised }} 条消息未整理</span>
        <span class="extract-banner-action">{{ chat.organizing ? '整理中…' : '点击整理 →' }}</span>
      </div>
      <!-- 主角状态条（游戏栏 HUD） -->
      <div v-if="chat.currentStream === 'game' && heroState" class="hud-bars">
        <div class="hud-hero">{{ heroState.name }}</div>
        <div v-for="b in heroState.bars" :key="b.name" class="hud-row">
          <span class="hud-name">{{ b.name }}</span>
          <div class="bar-track" style="flex:1">
            <div class="bar-fill" :style="{ width: Math.min(100, (b.value / b.max) * 100) + '%', background: b.color }"></div>
          </div>
          <span class="hud-val">{{ b.value }}/{{ b.max }}</span>
        </div>
      </div>

      <!-- v2.2 状态卡（游戏流 HUD，AI 每轮自动更新） -->
      <div v-if="chat.currentStream === 'game' && statusCardState" class="status-card">
        <div class="status-card-head"><Icon name="clipboard" :size="13" /> 状态卡</div>
        <div v-for="s in statusCardState" :key="s.label" class="status-row">
          <span class="status-label">{{ s.label }}</span>
          <span class="status-val">{{ s.text }}</span>
        </div>
      </div>

      <!-- 游戏栏 · 未开始：开始游戏入口 -->
      <div v-if="chat.currentStream === 'game' && !chat.inGame" class="start-gate card">
        <div style="text-align:center; margin-top:8px; color:var(--accent)"><Icon name="gamepad" :size="40" /></div>
        <div class="start-gate-title">梦境尚未开启</div>
        <div class="list-sub" style="text-align:center; margin-top:6px">
          先到「交流」栏和主持约好世界观、角色与基调<br />
          再回到这里开始你的梦境
        </div>
        <button class="btn btn-primary btn-block" style="margin-top:16px" :disabled="startLoading || chat.sending" @click="beginStart">
          <Icon name="rocket" :size="16" /> 开始游戏{{ startLoading ? '…' : '' }}
        </button>
      </div>

      <template v-else>
        <div v-if="chat.messages.length === 0" class="empty-hint">
          <template v-if="chat.currentStream === 'talk'">
            和 AI 组队设计你的梦境游戏吧<br />
            聊聊：想玩什么世界？扮演谁？什么基调？<br />
            聊够了，点「游戏」开始梦境
          </template>
          <template v-else>
            新的梦境还未开始<br />
            写下你的第一句话吧
          </template>
        </div>

        <template v-for="(m, idx) in chat.messages" :key="m.id ?? idx">
          <div :data-msg="true">
            <!-- 前情摘要卡（游戏流） -->
            <div v-if="idx === 0 && chat.currentStream === 'game' && chat.currentCampaign?.summary" class="msg-scene" style="background: var(--warm-soft); color: var(--warm)">
              <Icon name="scroll" :size="14" /> <b>前情摘要</b>：{{ chat.currentCampaign.summary.slice(0, 200) }}
            </div>

            <!-- 章节回顾卡（游戏流） -->
            <div v-if="m.role === 'assistant' && parseMsg(m)?.kind === 'summary'" class="summary-card">
              <div class="summary-title"><Icon name="scroll" :size="15" /> {{ parseMsg(m)!.title }}</div>
              <div v-for="(ev, ei) in (parseMsg(m)!.events || [])" :key="ei" class="summary-row">
                <span class="summary-dot">◆</span>
                <div>
                  <span v-if="ev.time" class="summary-meta"><Icon name="clock" :size="12" /> {{ ev.time }}</span>
                  <span v-if="ev.place" class="summary-meta"><Icon name="pin" :size="12" /> {{ ev.place }}</span>
                  <div class="summary-desc">{{ ev.desc }}</div>
                </div>
              </div>
            </div>

            <!-- 场景卡（游戏流） -->
            <div v-else-if="m.role === 'assistant' && chat.currentStream === 'game' && parseMsg(m)?.scene" class="msg-scene">
              <span v-if="parseMsg(m)!.scene!.date"><b><Icon name="calendar" :size="13" /></b>{{ parseMsg(m)!.scene!.date }}</span>
              <span v-if="parseMsg(m)!.scene!.time"><b><Icon name="clock" :size="13" /></b>{{ parseMsg(m)!.scene!.time }}</span>
              <span v-if="parseMsg(m)!.scene!.location"><b><Icon name="pin" :size="13" /></b>{{ parseMsg(m)!.scene!.location }}</span>
            </div>

            <!-- 消息体 -->
            <div v-if="m.role === 'user'" class="msg-card msg-user" @touchstart="msgTouchStart(m)" @touchend="msgTouchEnd" @touchmove="msgTouchEnd">{{ m.content }}</div>
            <template v-else>
              <!-- 思维链（可折叠） -->
              <div v-if="m.reasoning" class="reasoning-block">
                <button class="reasoning-toggle" @click="toggleReasoning(m.id)">
                  <span class="reasoning-icon">{{ expandedReasoning.has(m.id!) ? '▾' : '▸' }}</span>
                  思维链（{{ fmtTokens(m.reasoning.length) }} 字符）
                </button>
                <div v-if="expandedReasoning.has(m.id!)" class="reasoning-body">{{ m.reasoning }}</div>
              </div>
              <div class="msg-card" @touchstart="msgTouchStart(m)" @touchend="msgTouchEnd" @touchmove="msgTouchEnd">{{ bodyOf(m) }}</div>
            </template>

            <!-- token 统计（游戏流） -->
            <div v-if="m.role === 'assistant' && chat.currentStream === 'game' && usageOf(m)" class="msg-usage">
              ↑ {{ fmtTokens(usageOf(m)!.promptTokens) }} ↓ {{ fmtTokens(usageOf(m)!.completionTokens) }}
              共 {{ fmtTokens(usageOf(m)!.totalTokens) }} token
              <template v-if="usageOf(m)!.costYuan"> · ¥{{ usageOf(m)!.costYuan!.toFixed(4) }}<span v-if="usageOf(m)!.peak" style="opacity:.7">（高峰）</span></template>
              <span class="msg-usage-del" @click="chat.regenerate()"><Icon name="refresh" :size="12" /> 重发</span>
            </div>

            <!-- 后置格式（状态栏等，游戏流；v2.1.1 屏蔽超长/复述残留，双保险） -->
            <div v-if="m.role === 'assistant' && chat.currentStream === 'game' && parseMsg(m)?.afterFormat && parseMsg(m)!.afterFormat.length <= 280" class="after-format">
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
              ><Icon name="sparkle" :size="13" /> {{ opt }}</button>
            </div>

            <!-- v2.0：操作确认卡（交流栏消息内嵌，就地确认/退回） -->
            <template v-if="m.role === 'assistant' && chat.currentStream === 'talk' && opsOfMsg(m.id)?.length">
              <OpCard
                v-for="op in opsOfMsg(m.id)"
                :key="op.id"
                :op="op"
                :target="opTarget(op)"
                :compact="true"
                @confirm="confirmMsgOp(op)"
                @reject="rejectMsgOp(op)"
              />
            </template>
          </div>
        </template>

        <div v-if="chat.sending" class="msg-card" :style="liveBody ? 'color:var(--ink); font-size:13.5px' : 'color: var(--ink-soft); font-size: 13.5px'">
          <template v-if="liveBody">
            <span class="live-text">{{ liveBody }}</span><span class="live-caret">▍</span>
          </template>
          <template v-else>
            {{ chat.currentStream === 'talk' ? '思客正在思考…' : '思客正在编织梦境…' }}
          </template>
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

    <!-- 直达顶/底（布局层右下角，不随滚动） -->
    <div v-if="chat.currentCampaignId" class="scroll-fabs">
      <button class="fab" title="回到顶部" @click="scrollTop"><Icon name="chevronUp" :size="16" /></button>
      <button class="fab" title="回到底部" @click="scrollBottom()"><Icon name="chevronDown" :size="16" /></button>
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
      <button class="send-btn" :disabled="chat.sending || !draft.trim()" @click="send"><Icon name="send" :size="17" /></button>
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
              {{ c.gameStarted ? '游戏中' : '交流中' }}
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
          创建后先进入「交流」栏，和 AI 约定设定后再开始游戏
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
            <label><Icon name="user" :size="13" /> 角色卡（点击可编辑属性）</label>
            <div class="char-card-grid">
              <div v-for="c in startChars" :key="c.id" class="char-card" @click="charDetail = c">
                <div class="char-avatar">{{ c.name.slice(0, 1) }}</div>
                <div class="list-title">{{ c.name }}</div>
                <div class="list-sub">{{ c.identity || '身份未知' }}</div>
              </div>
            </div>
          </div>

          <div class="field">
            <label><Icon name="sparkle" :size="13" /> 开场白（可修改，选「先不写」则不生成）</label>
            <textarea v-model="startPack.opening" rows="5"></textarea>
          </div>

          <button class="btn btn-primary btn-block" @click="confirmStart(true)"><Icon name="rocket" :size="15" /> 开始游戏（含开场白）</button>
          <button class="btn btn-ghost btn-block" style="margin-top:8px" @click="confirmStart(false)">开始游戏（先不写开场）</button>
        </template>

        <div v-else class="empty-hint">
          开局包生成失败：{{ chat.error || '未知错误' }}<br />
          <button class="btn btn-soft btn-sm" style="margin-top:10px" @click="beginStart">重试</button>
        </div>
      </div>
    </div>

    <!-- 消息长按操作 -->
    <div v-if="longPress" class="modal-mask" @click.self="longPress = null">
      <div class="modal-sheet">
        <div class="modal-title">消息操作</div>
        <div class="msg-preview">{{ bodyOf(longPress).slice(0, 90) }}{{ bodyOf(longPress).length > 90 ? '…' : '' }}</div>
        <div style="display:flex; gap:8px; flex-wrap:wrap">
          <button v-if="longPress.role === 'assistant'" class="btn btn-primary" style="flex:1" @click="regenerateHere">
            <Icon name="refresh" :size="14" /> 重新生成
          </button>
          <button class="btn btn-soft" style="flex:1" @click="startEditMsg"><Icon name="pencil" :size="14" /> 编辑</button>
          <button class="btn btn-ghost" style="flex:1" @click="copyMsg"><Icon name="doc" :size="14" /> 复制</button>
        </div>
      </div>
    </div>

    <!-- 消息编辑弹层 -->
    <div v-if="editMsgOpen" class="modal-mask" @click.self="editMsgOpen = false">
      <div class="modal-sheet">
        <div class="modal-title">编辑消息</div>
        <div class="field">
          <textarea v-model="editMsgText" rows="7"></textarea>
        </div>
        <div style="display:flex; gap:10px">
          <button class="btn btn-ghost" style="flex:1" @click="editMsgOpen = false">取消</button>
          <button class="btn btn-primary" style="flex:2" @click="saveEditMsg">保存</button>
        </div>
      </div>
    </div>

    <!-- 角色详情弹层（开局向导内编辑） -->
    <CharacterDetail
      v-if="charDetail"
      :character="charDetail"
      :schema="chat.attrSchema()"
      :bars="chat.barDefs()"
      @close="charDetail = null"
      @saved="saveCharDetail"
    />

    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>

<script lang="ts">
export default { name: 'ChatView' }
</script>
