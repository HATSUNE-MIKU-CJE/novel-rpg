<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { db } from '../db'
import { useDataStore } from '../stores/data'
import { useChatStore } from '../stores/chat'
import { formatSpecMarkdown, formatSpecSchema } from '../engine/specExport'
import { exportFile } from '../engine/exportFile'
import { CATEGORIES, type AttrSchema } from '../engine/extractor'
import RelationGraph from './RelationGraph.vue'
import CharacterDetail from './CharacterDetail.vue'
import type { Character, Relation, Worldbook, Entry } from '../types'

const ds = useDataStore()
const chat = useChatStore()

const tab = ref<'chars' | 'rels' | 'world' | 'config'>('chars')
const characters = ref<Character[]>([])
const relations = ref<Relation[]>([])
const showImportModal = ref(false)
const importText = ref('')
const importFileName = ref('')
const importFileInput = ref<HTMLInputElement>()

/** 选文件自动读入并填充 */
function onImportFile(ev: Event) {
  const f = (ev.target as HTMLInputElement).files?.[0]
  if (!f) return
  importFileName.value = f.name
  const reader = new FileReader()
  reader.onload = () => { importText.value = String(reader.result ?? '') }
  reader.readAsText(f)
}
const showBindPicker = ref(false)
const pendingBindWb = ref<Worldbook | null>(null)

const editEntry = ref<Entry | null>(null)
const editWb = ref<Worldbook | null>(null)
const showEntryEditor = ref(false)
const showWbEditor = ref(false)

// ---- 顶部：存档切换 ----
const showCampaigns = ref(false)
const campaignName = computed(() => chat.currentCampaign?.name || '未选择存档')
async function switchCampaign(id: number) {
  await chat.openCampaign(id)
  showCampaigns.value = false
  await refreshChars()
  await refreshPending()
  await refreshBindings()
}

onMounted(() => refreshChars())
watch(() => chat.currentCampaignId, () => refreshChars())
watch(() => ds.entries.length, () => refreshPending())

const schema = computed(() => chat.attrSchema())

async function refreshChars() {
  const cid = chat.currentCampaignId
  if (!cid) { characters.value = []; relations.value = []; return }
  characters.value = await db.characters.where('campaignId').equals(cid).toArray()
  relations.value = await db.relations.where('campaignId').equals(cid).toArray()
}

// ---- 自动笔记簿 ----
const notebook = computed<Worldbook | null>(() => {
  const id = chat.currentCampaign?.notebookWorldbookId
  return id ? ds.worldbooks.find((w) => w.id === id) ?? null : null
})

/** 当前生效的世界书条目（已接受/手动/导入，排除 AI pending 与 rejected） */
function activeWorldEntries(): Entry[] {
  const cid = chat.currentCampaignId
  if (!cid) return []
  const wbIds = [...bindings.value]
  if (notebook.value?.id) wbIds.push(notebook.value.id)
  const out: Entry[] = []
  for (const wbId of wbIds) {
    for (const e of ds.entriesOf(wbId)) {
      if (!e.enabled || !e.content.trim()) continue
      if (e.source === 'ai' && e.status !== 'accepted') continue
      out.push(e)
    }
  }
  return out
}

/** 世界 tab：AI 梳理总览 */
const overview = computed<import('../types').WorldOverview | null>(() => {
  const j = chat.currentCampaign?.worldOverviewJson
  if (!j) return null
  try {
    const o = JSON.parse(j)
    return o?.summary ? o : null
  } catch { return null }
})
/** 有新条目但还没重新梳理 */
const staleOverview = computed(() => {
  const c = chat.currentCampaign
  if (!c) return false
  const organ = c.lastOrganized ?? 0
  return !!overview.value && organ > overview.value.at
})
/** 按触发词找相关条目 */
function relatedEntriesOf(keys: string[]): Entry[] {
  const list = activeWorldEntries()
  const out: Entry[] = []
  for (const k of keys) {
    const hit = list.find((e) => (e.key || '').split(/[,，]/).some((s) => s.trim() === k.trim()))
    if (hit && !out.includes(hit)) out.push(hit)
  }
  return out
}
async function refreshWorld() {
  const r = await chat.syncFrom('game')
  showToast(r.skipped ? '世界书已是最新' : `已更新：角色 ${r.chars} · 关系 ${r.rels} · 事实 ${r.facts}（待确认）`)
}
async function doOverview() {
  const o = await chat.buildWorldOverview()
  showToast(o ? '✨ 已梳理世界观总览' : (chat.error || '梳理失败'))
}

const pendingEntries = ref<Entry[]>([])
async function refreshPending() {
  const wb = notebook.value
  pendingEntries.value = wb?.id
    ? ds.entriesOf(wb.id).filter((e) => e.status === 'pending')
    : []
}
watch(notebook, refreshPending)

const organizeStats = computed(() => {
  const s = chat.currentCampaign?.organizeStats
  if (!s) return null
  try { return JSON.parse(s) } catch { return null }
})

async function organizeNow() {
  if (!chat.talkMessages.length && !chat.gameMessages.length) {
    alert('先聊几轮，让 AI 认识角色吧')
    return
  }
  await chat.organizeWorldbook()
  await refreshChars()
  await refreshPending()
}

async function acceptEntry(e: Entry) {
  await ds.saveEntry({ ...e, status: 'accepted', updatedAt: Date.now() })
  await refreshPending()
}
async function rejectEntry(e: Entry) {
  await ds.saveEntry({ ...e, status: 'rejected', updatedAt: Date.now() })
  await refreshPending()
}
async function acceptAll() {
  for (const e of pendingEntries.value) await acceptEntry(e)
}

// ---- 属性设定（存档级） ----
const schemaEdit = ref(false)
const schemaDraft = ref<AttrSchema>({ dims: [], realmLabel: '' })
const schemaLoading = ref(false)
function beginSchemaEdit() {
  const s = schema.value
  schemaDraft.value = JSON.parse(JSON.stringify(s))
  schemaEdit.value = true
}
function addDim() {
  schemaDraft.value.dims.push({ label: '' })
}
function delDim(i: number) {
  schemaDraft.value.dims.splice(i, 1)
}
async function saveSchema() {
  const s = schemaDraft.value
  await chat.saveAttrSchema({
    dims: s.dims.filter((d) => d.label.trim()).map((d) => ({ label: d.label.trim() })),
    realmLabel: (s.realmLabel ?? '').trim(),
  })
  schemaEdit.value = false
  showToast('属性体系已保存')
}
async function suggestSchema() {
  schemaLoading.value = true
  const s = await chat.suggestAttrSchema()
  schemaLoading.value = false
  if (s) {
    schemaDraft.value = s
    schemaEdit.value = true
    showToast('已按交流内容生成建议，确认后保存')
  } else {
    showToast(chat.error || '生成失败')
  }
}

// ---- 配置 tab 折叠 ----
const showWbSection = ref(false)
const showVarsSection = ref(false)

// ---- 世界书管理 ----
const wbList = computed(() => ds.worldbooks)

async function saveEntry() {
  if (!editEntry.value) return
  const e = editEntry.value
  const isNew = !e.id
  await ds.saveEntry({
    ...e,
    createdAt: e.createdAt || Date.now(),
    updatedAt: Date.now(),
    enabled: e.enabled ? 1 : 0,
    source: e.source || 'manual',
    category: (e.category || '其他'),
  })
  showEntryEditor.value = false
  editEntry.value = null
  await refreshPending()
  if (isNew) await refreshChars()
}

/** 快捷停用/启用条目 */
async function toggleEntryEnabled(e: Entry) {
  await ds.saveEntry({ ...e, enabled: e.enabled ? 0 : 1, updatedAt: Date.now() })
  await refreshPending()
}

/** 删除条目 */
async function removeEntry(e: Entry) {
  if (!e.id) return
  if (!confirm(`删除条目「${e.key || '常驻'}」？删除后不可恢复。`)) return
  await ds.deleteEntry(e.id)
  await refreshPending()
}

async function saveWb() {
  if (!editWb.value) return
  await ds.saveWorldbook({
    ...editWb.value,
    scope: editWb.value.scope || 'global',
    createdAt: editWb.value.createdAt || Date.now(),
  })
  showWbEditor.value = false
  editWb.value = null
}

const entriesOfWb = (id: number) => ds.entriesOf(id)

/** 是否为当前存档的自动笔记簿 */
function nb(wb: Worldbook): boolean {
  return chat.currentCampaign?.notebookWorldbookId === wb.id
}

// ---- 绑定管理 ----
const bindings = ref<number[]>([])
async function refreshBindings() {
  const cid = chat.currentCampaignId
  if (!cid) { bindings.value = []; return }
  const bs = await db.campaignBindings.where('campaignId').equals(cid).toArray()
  bindings.value = bs.map((b) => b.worldbookId)
}
watch(() => chat.currentCampaignId, refreshBindings)
onMounted(refreshBindings)

async function toggleBind(wb: Worldbook) {
  const cid = chat.currentCampaignId
  if (!cid) return
  const exist = bindings.value.includes(wb.id!)
  if (exist) {
    await db.campaignBindings.where('campaignId').equals(cid).and((b) => b.worldbookId === wb.id).delete()
  } else {
    await db.campaignBindings.add({ campaignId: cid, worldbookId: wb.id!, mode: 'ref', createdAt: Date.now() })
  }
  await refreshBindings()
}

const campaignLevelBindings = computed(() => wbList.value.filter((w) => bindings.value.includes(w.id!)))
const globalAvailable = computed(() => wbList.value.filter((w) => w.scope === 'global' && !bindings.value.includes(w.id!)))

// ---- 导入 & 导出 ----
async function doImportWb() {
  if (!importText.value.trim()) return
  try {
    const r = await ds.importWorldbookJson(importText.value, undefined, chat.currentCampaignId || undefined)
    importText.value = ''
    showImportModal.value = false
    alert(`导入成功：条目 ${r.entryCount} · 角色 ${r.charCount} · 关系 ${r.relCount}`)
    await refreshBindings()
    await refreshChars()
  } catch (e: any) {
    alert('导入失败：' + (e?.message || 'JSON 格式不对'))
  }
}

async function download(name: string, content: string, mime = 'application/json') {
  try {
    await exportFile(name, content, mime)
  } catch (e: any) {
    alert('导出失败：' + (e?.message || '未知错误'))
  }
}

/** 导出某本世界书为规范 JSON */
async function exportWb(wb: Worldbook) {
  const entries = ds.entriesOf(wb.id!)
  const dump = {
    version: 1,
    worldbook: { name: wb.name, description: wb.description ?? '' },
    entries: entries.map((e) => ({ key: e.key ? e.key.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : undefined, content: e.content, enabled: !!e.enabled })),
  }
  await download(`worldbook-${wb.name}.json`, JSON.stringify(dump, null, 2))
}

// ---- 会话变量查看器 ----
const varsEntries = computed<Array<[string, string]>>(() => {
  const c = chat.currentCampaign
  if (!c?.varsJson) return []
  try { return Object.entries(JSON.parse(c.varsJson)) } catch { return [] }
})
const varEditKey = ref('')
const varEditVal = ref('')
async function saveVar() {
  const c = chat.currentCampaign!
  const vars: Record<string, string> = {}
  try { Object.assign(vars, JSON.parse(c.varsJson || '{}')) } catch { /* ignore */ }
  if (!varEditKey.value.trim()) return
  vars[varEditKey.value.trim()] = varEditVal.value
  c.varsJson = JSON.stringify(vars)
  await ds.saveCampaign(c)
  varEditKey.value = ''; varEditVal.value = ''
  await chat.openCampaign(c.id!)
}
async function deleteVar(k: string) {
  const c = chat.currentCampaign!
  const vars: Record<string, string> = {}
  try { Object.assign(vars, JSON.parse(c.varsJson || '{}')) } catch { /* ignore */ }
  delete vars[k]
  c.varsJson = JSON.stringify(vars)
  await ds.saveCampaign(c)
  await chat.openCampaign(c.id!)
}

/** 打开条目编辑器（复用） */
function openEdit(e: Entry) {
  editEntry.value = { ...e }
  showEntryEditor.value = true
}

// ---- 角色详情（全屏） ----
const charSheet = ref<Character | null>(null)
function openDetail(c: Character) { charSheet.value = c }
async function onCharSaved() { await refreshChars() }

// ---- 轻提示 ----
const toast = ref('')
let toastTimer: number | undefined
function showToast(msg: string) {
  toast.value = msg
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (toast.value = ''), 2600)
}
</script>

<template>
  <div class="page">
    <!-- 顶端栏：标题 + 存档切换 -->
    <header class="panel-header">
      <div class="page-title" style="margin:0">🎭 面板</div>
      <button class="btn btn-soft btn-sm" @click="showCampaigns = true">
        📖 {{ campaignName }} <span style="opacity:.7">▾</span>
      </button>
    </header>

    <!-- 选项栏 -->
    <div class="panel-tabs">
      <button class="btn btn-sm" :class="tab === 'chars' ? 'btn-primary' : 'btn-ghost'" @click="tab='chars'">👤 角色</button>
      <button class="btn btn-sm" :class="tab === 'rels' ? 'btn-primary' : 'btn-ghost'" @click="tab='rels'">🕸 关系</button>
      <button class="btn btn-sm" :class="tab === 'world' ? 'btn-primary' : 'btn-ghost'" @click="tab='world'">🌍 世界</button>
      <button class="btn btn-sm" :class="tab === 'config' ? 'btn-primary' : 'btn-ghost'" @click="tab='config'">⚙️ 配置</button>
    </div>

    <!-- ===== 角色 ===== -->
    <div v-if="tab === 'chars'">
      <div v-if="!characters.length" class="empty-hint">
        角色会在 AI 整理世界书时自动生长<br />（或用下方按钮手动整理）
      </div>
      <div class="char-card-grid">
        <div v-for="c in characters" :key="c.id" class="char-card" @click="openDetail(c)">
          <div class="char-avatar">{{ c.name.slice(0, 1) }}</div>
          <div class="list-title">{{ c.name }}</div>
          <div class="list-sub">{{ c.identity || '身份未知' }}<template v-if="c.realm"> · {{ c.realm }}</template></div>
          <div v-if="c.description" class="list-sub" style="margin-top:4px; max-height:44px; overflow:hidden">
            {{ c.description }}
          </div>
          <div class="entry-tag" :class="c.source === 'ai' ? 'tag-trigger' : 'tag-constant'" style="margin-top:6px">
            {{ c.source === 'ai' ? 'AI 提取' : '手动' }}
          </div>
        </div>
      </div>
      <div v-if="organizeStats" class="list-sub" style="margin-top:10px; text-align:center">
        🕐 上次整理：角色 {{ organizeStats.chars }} · 关系 {{ organizeStats.rels }} · 事实 {{ organizeStats.facts }}
        （{{ new Date(organizeStats.at).toLocaleTimeString() }}）
      </div>
      <button
        class="btn btn-soft btn-block" style="margin-top: 14px"
        :disabled="chat.organizing"
        @click="organizeNow"
      >{{ chat.organizing ? '📖 思客正在记录…' : '🔮 整理世界书（提取角色/事实）' }}</button>
    </div>

    <!-- ===== 关系 ===== -->
    <div v-if="tab === 'rels'">
      <div v-if="!relations.length" class="empty-hint">
        关系网络会在 AI 整理时自动生成<br />或用「角色」Tab 的整理按钮
      </div>
      <RelationGraph v-else :characters="characters" :relations="relations" @open="openDetail" />
      <div v-if="relations.length" class="list-sub" style="margin-top:10px">
        点击节点查看角色卡与关系详情
      </div>
    </div>

    <!-- ===== 世界 ===== -->
    <div v-if="tab === 'world'">
      <!-- 属性设定 -->
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex; align-items:center; margin-bottom:6px">
          <b style="flex:1">🎛 属性设定（存档级）</b>
          <button class="btn btn-warm btn-sm" :disabled="schemaLoading" style="margin-right:6px" @click="suggestSchema">
            {{ schemaLoading ? '生成中…' : '🤖 按交流建议' }}
          </button>
          <button class="btn btn-ghost btn-sm" @click="beginSchemaEdit">✏️ 编辑</button>
        </div>
        <div class="list-sub" style="margin-bottom:6px">
          本存档的属性维度：<span v-for="d in schema.dims" :key="d.label" class="entry-tag tag-constant" style="margin:2px 3px 0 0">{{ d.label }}</span>
          <template v-if="schema.realmLabel"> · {{ schema.realmLabel }}：{{ schema.realmLabel }}（角色单个标签，如：金丹期）</template>
        </div>

        <!-- 编辑/建议预览 -->
        <div v-if="schemaEdit" class="opt-detail" style="border-top:1px solid var(--line)">
          <label style="font-size:12.5px; color:var(--accent-deep); font-weight:600; display:block; margin-bottom:6px">维度（4~8 个，可改）</label>
          <div v-for="(d, i) in schemaDraft.dims" :key="i" class="attr-edit-row">
            <input v-model="d.label" placeholder="维度名" style="flex:1" />
            <button class="btn btn-danger btn-sm" @click="delDim(i)">✗</button>
          </div>
          <button class="btn btn-soft btn-sm" style="margin-top:6px" @click="addDim">＋ 维度</button>
          <div class="field" style="margin-top:10px">
            <label>境界标签（留空 = 不显示境界）</label>
            <input v-model="schemaDraft.realmLabel" placeholder="如：境界 / 段位" />
          </div>
          <div style="display:flex; gap:10px; margin-top:4px">
            <button class="btn btn-ghost" style="flex:1" @click="schemaEdit = false">取消</button>
            <button class="btn btn-primary" style="flex:2" @click="saveSchema">保存</button>
          </div>
        </div>
      </div>

      <!-- 临时区：AI 新展开的信息 -->
      <div v-if="pendingEntries.length" class="card" style="margin-bottom:12px; border:1px solid var(--warm)">
        <div style="display:flex; align-items:center; margin-bottom:8px">
          <b style="flex:1">🧺 临时区（AI 新展开 {{ pendingEntries.length }} 条）</b>
          <button class="btn btn-warm btn-sm" @click="acceptAll">全部确认</button>
        </div>
        <div class="list-sub" style="margin-bottom:6px">
          游戏进行中新展开的信息先进这里；确认后写入世界书（正式生效），不想要的直接丢弃。
        </div>
        <div v-for="e in pendingEntries" :key="e.id" class="entry-item">
          <span class="entry-tag" :class="e.key ? 'tag-trigger' : 'tag-constant'">
            {{ e.key ? e.key.split(/[,，]/)[0].slice(0, 10) : '常驻' }}
          </span>
          <div style="flex:1; min-width:0">
            <div class="list-sub" style="color:var(--accent-deep); font-size:11px">{{ e.category || '其他' }}</div>
            <div class="list-sub" style="white-space:pre-wrap">{{ e.content.slice(0, 80) }}</div>
          </div>
          <button class="btn btn-warm btn-sm" title="确认写入世界书" @click="acceptEntry(e)">✓</button>
          <button class="btn btn-ghost btn-sm" title="编辑" @click="openEdit(e)">编</button>
          <button class="btn btn-danger btn-sm" title="丢弃" @click="rejectEntry(e)">✗</button>
        </div>
      </div>

      <!-- 世界观总览（AI 梳理，非条目抄录） -->
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex; align-items:center; margin-bottom:6px">
          <b style="flex:1">🌍 世界观总览</b>
          <button class="btn btn-warm btn-sm" style="margin-right:6px" :disabled="chat.organizing" @click="refreshWorld">
            {{ chat.organizing ? '…' : '↻ 更新' }}
          </button>
          <button class="btn btn-soft btn-sm" :disabled="chat.organizing" @click="doOverview">
            {{ overview ? '🪄 重新梳理' : '🪄 梳理' }}
          </button>
        </div>
        <div v-if="staleOverview" class="list-sub" style="margin-bottom:6px; color:var(--warm)">
          🧺 有新内容未梳理 —— 点「重新梳理」更新总览
        </div>
        <template v-if="overview">
          <div class="detail-text">{{ overview.summary }}</div>
          <div v-for="b in overview.blocks" :key="b.category" class="world-block">
            <b>🌍 {{ b.category }}</b>
            <div class="detail-text" style="margin:2px 0">{{ b.content }}</div>
            <div v-if="relatedEntriesOf(b.related).length">
              <div v-for="(e, i) in relatedEntriesOf(b.related)" :key="i" class="list-sub">
                · {{ e.key || '常驻' }}：{{ e.content.slice(0, 50) }}{{ e.content.length > 50 ? '…' : '' }}
              </div>
            </div>
          </div>
        </template>
        <div v-else-if="activeWorldEntries().length" class="list-sub">
          点「🪄 梳理」—— AI 会把世界书提炼成世界观介绍（不是抄条目）
        </div>
        <div v-else class="list-sub">
          先把条目确认进世界书（见上方临时区），AI 就能为你梳理世界观
        </div>
      </div>
    </div>

    <!-- ===== 配置 ===== -->
    <div v-if="tab === 'config'">
      <!-- 本存档绑定的世界书 -->
      <div class="card" style="margin-bottom:12px">
        <b style="margin-bottom:6px; display:block">🔗 本存档绑定的世界书（注入对话）</b>
        <div v-if="!campaignLevelBindings.length" class="list-sub">未绑定——只有下面「全部确认」的笔记簿内容会进入上下文</div>
        <div v-for="wb in campaignLevelBindings" :key="'b' + wb.id" class="entry-item">
          <span class="entry-tag tag-constant">已绑</span>
          <div style="flex:1; font-size:13px; font-weight:600">{{ wb.name }}</div>
          <button class="btn btn-ghost btn-sm" @click="toggleBind(wb)">解绑</button>
        </div>
        <div v-if="globalAvailable.length" class="list-sub" style="margin-top:6px">
          全局库可绑定：<span v-for="w in globalAvailable" :key="'g' + w.id" style="display:inline-block; margin:4px 6px 0 0">
            <button class="btn btn-soft btn-sm" @click="toggleBind(w)">＋ {{ w.name }}</button>
          </span>
        </div>
      </div>

      <!-- 工具行：导出规范 / 导入 -->
      <div class="card" style="margin-bottom:12px">
        <div class="collapse-head" @click="showWbSection = !showWbSection">
          <b>📚 世界书（{{ wbList.length }} 本）</b>
          <span class="collapse-arrow">{{ showWbSection ? '▲ 收起' : '▼ 展开' }}</span>
        </div>
        <template v-if="showWbSection">
          <div style="display:flex; gap:8px; margin:8px 0 12px">
            <button class="btn btn-warm btn-sm" style="flex:1" @click="download('世界书格式规范.md', formatSpecMarkdown, 'text/markdown')">
              📄 规范.md
            </button>
            <button class="btn btn-warm btn-sm" style="flex:1" @click="download('worldbook-schema.json', formatSpecSchema)">
              📐 Schema.json
            </button>
            <button class="btn btn-soft btn-sm" style="flex:1" @click="showImportModal = true">📥 导入</button>
          </div>

          <!-- 世界书列表 -->
          <div v-if="!wbList.length" class="empty-hint">还没有世界书</div>
          <div v-for="wb in wbList" :key="wb.id" class="card" style="margin-bottom: 12px; box-shadow:none; border:1px solid var(--line)">
            <div style="display:flex; align-items:center; margin-bottom: 8px">
              <div style="flex:1">
                <b>{{ wb.name }}</b>
                <span class="list-sub"> · {{ wb.scope === 'global' ? '全局共享' : '存档专属' }}</span>
                <span v-if="nb(wb)" class="entry-tag tag-warm" style="margin-left:6px">AI 自动</span>
              </div>
              <button class="btn btn-ghost btn-sm" @click="exportWb(wb)">导出</button>
              <button class="btn btn-danger btn-sm" @click="ds.deleteWorldbook(wb.id!)">删</button>
            </div>
            <div v-if="!entriesOfWb(wb.id!).length" class="list-sub">空</div>
            <div v-for="e in entriesOfWb(wb.id!).filter(x => x.status !== 'rejected')" :key="e.id" class="entry-item">
              <span class="entry-tag" :class="e.key ? 'tag-trigger' : 'tag-constant'" :style="!e.enabled ? 'opacity:.45' : ''">
                {{ !e.enabled ? '停用' : (e.status === 'pending' ? '待审' : (e.key ? '触发' : '常驻')) }}
              </span>
              <div style="flex:1; min-width:0">
                <div class="list-title" style="font-size:13px">{{ e.key || '—' }}</div>
                <div class="list-sub" style="white-space:pre-wrap; overflow:hidden; text-overflow:ellipsis; max-height:34px">
                  {{ e.content }}
                </div>
              </div>
              <button class="btn btn-ghost btn-sm" :title="e.enabled ? '停用（不再注入）' : '重新启用'" @click="toggleEntryEnabled(e)">
                {{ e.enabled ? '停用' : '启用' }}
              </button>
              <button class="btn btn-ghost btn-sm" @click="openEdit(e)">编</button>
              <button class="btn btn-danger btn-sm" @click="removeEntry(e)">删</button>
            </div>
            <button class="btn btn-soft btn-sm" style="margin-top: 8px"
              @click="openEdit({ worldbookId: wb.id!, source: 'manual', enabled: 1, createdAt: 0, updatedAt: 0, key: '', content: '' } as Entry)"
            >＋ 条目</button>
          </div>

          <button class="btn btn-soft btn-block" @click="editWb = { name: '新世界书', scope: 'global', createdAt: 0, updatedAt: 0 }; showWbEditor = true">
            ＋ 新建世界书
          </button>
        </template>
      </div>

      <!-- 变量查看器（折叠） -->
      <div class="card">
        <div class="collapse-head" @click="showVarsSection = !showVarsSection">
          <b>🧬 会话变量（{{ varsEntries.length }}）</b>
          <span class="collapse-arrow">{{ showVarsSection ? '▲ 收起' : '▼ 展开' }}</span>
        </div>
        <template v-if="showVarsSection">
          <div class="list-sub" style="margin:8px 0">
            这里显示的是存档的宏变量（sleep_var_* 等）。高级用户可查看/修正。
          </div>
          <div v-if="!varsEntries.length" class="empty-hint" style="padding:16px 0">
            暂无变量（发过一轮对话后会出现）
          </div>
          <div v-for="[k, v] in varsEntries" :key="k" class="entry-item" style="padding:8px 2px">
            <div style="flex:1; min-width:0">
              <div class="list-title" style="font-size:12.5px; color: var(--accent-deep)">{{ k }}</div>
              <div class="list-sub" style="white-space:pre-wrap; word-break:break-all">{{ v.slice(0, 120) }}{{ v.length > 120 ? '…' : '' }}</div>
            </div>
            <button class="btn btn-ghost btn-sm" @click="varEditKey = k; varEditVal = v">改</button>
            <button class="btn btn-danger btn-sm" @click="deleteVar(k)">删</button>
          </div>
          <div class="card" v-if="varEditKey" style="box-shadow:none; border:1px solid var(--line); margin-top:10px">
            <b style="margin-bottom:8px; display:block">编辑变量</b>
            <div class="field"><label>键</label><input v-model="varEditKey" /></div>
            <div class="field"><label>值</label><textarea v-model="varEditVal" rows="3"></textarea></div>
            <button class="btn btn-primary btn-block" @click="saveVar">保存</button>
          </div>
        </template>
      </div>
    </div>

    <!-- 角色全屏详情 -->
    <CharacterDetail
      v-if="charSheet"
      :character="charSheet"
      :schema="schema"
      @close="charSheet = null"
      @saved="onCharSaved"
    />

    <!-- 存档切换弹层 -->
    <div v-if="showCampaigns" class="modal-mask" @click.self="showCampaigns = false">
      <div class="modal-sheet">
        <div class="modal-title">选择存档</div>
        <div v-if="!ds.campaigns.length" class="empty-hint">暂无存档</div>
        <div
          v-for="c in ds.campaigns"
          :key="c.id"
          class="list-row"
          @click="switchCampaign(c.id!)"
        >
          <div>
            <div class="list-title">{{ c.name }}</div>
            <div class="list-sub">
              {{ c.gameStarted ? '🎮 游戏中' : '💬 交流中' }} · 更新于 {{ new Date(c.lastActive).toLocaleString() }}
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 条目编辑器（带类别） -->
    <div v-if="showEntryEditor && editEntry" class="modal-mask" @click.self="showEntryEditor = false">
      <div class="modal-sheet">
        <div class="modal-title">编辑条目</div>
        <div class="field">
          <label>触发词（留空 = 常驻条目，始终注入）</label>
          <input v-model="editEntry.key" placeholder="如：铁炉堡, 矮人" />
        </div>
        <div class="field">
          <label>内容</label>
          <textarea v-model="editEntry.content" rows="5" placeholder="这条设定的正文…"></textarea>
        </div>
        <div class="field">
          <label>世界类别</label>
          <select v-model="editEntry.category">
            <option v-for="c in CATEGORIES" :key="c" :value="c">{{ c }}</option>
          </select>
        </div>
        <div class="field" style="display:flex; align-items:center; gap:8px">
          <input type="checkbox" v-model="editEntry.enabled" style="width:auto" />
          <label style="margin:0">启用</label>
        </div>
        <div style="display:flex; gap:10px">
          <button v-if="editEntry.id" class="btn btn-danger" style="flex:1" @click="removeEntry(editEntry); showEntryEditor = false; editEntry = null">删</button>
          <button class="btn btn-ghost" style="flex:1" @click="showEntryEditor = false">取消</button>
          <button class="btn btn-primary" style="flex:2" @click="saveEntry">
            {{ editEntry.status === 'pending' ? '确认并写入世界书' : '保存' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 导入世界书弹层 -->
    <div v-if="showImportModal" class="modal-mask" @click.self="showImportModal = false">
      <div class="modal-sheet">
        <div class="modal-title">导入世界书（JSON）</div>
        <div class="list-sub" style="margin-bottom:10px">
          支持本 App 规范（version/worldbook/entries/characters/relations）与 SillyTavern world_info 格式。
          角色与关系会写入当前存档（{{ campaignName }}）。
        </div>
        <div class="field">
          <label style="margin-bottom:8px">方式一：选择文件（自动识别填入）</label>
          <input ref="importFileInput" type="file" accept=".json,application/json" @change="onImportFile" />
          <div v-if="importFileName" class="list-sub" style="margin-top:4px">已读取：{{ importFileName }}（{{ importText.length }} 字符）</div>
        </div>
        <div class="field">
          <label>方式二：粘贴 JSON 文本</label>
          <textarea v-model="importText" rows="8" placeholder='{"version":1,"worldbook":{"name":"..."},...}'></textarea>
        </div>
        <button class="btn btn-primary btn-block" :disabled="!importText.trim()" @click="doImportWb">导入</button>
      </div>
    </div>

    <!-- 世界书编辑器 -->
    <div v-if="showWbEditor && editWb" class="modal-mask" @click.self="showWbEditor = false">
      <div class="modal-sheet">
        <div class="modal-title">新建世界书</div>
        <div class="field">
          <label>名称</label>
          <input v-model="editWb.name" />
        </div>
        <div class="field">
          <label>描述</label>
          <textarea v-model="editWb.description" rows="2"></textarea>
        </div>
        <div class="field">
          <label>范围</label>
          <select v-model="editWb.scope">
            <option value="global">全局共享（所有存档可用）</option>
            <option value="campaign">存档专属（新建后绑定到当前存档）</option>
          </select>
        </div>
        <button class="btn btn-primary btn-block" @click="saveWb">创建</button>
      </div>
    </div>

    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>

<script lang="ts">
export default { name: 'PanelView' }
</script>
