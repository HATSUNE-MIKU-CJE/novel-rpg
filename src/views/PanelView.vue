<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { db } from '../db'
import { useDataStore } from '../stores/data'
import { useChatStore } from '../stores/chat'
import { formatSpecMarkdown, formatSpecSchema } from '../engine/specExport'
import { exportFile } from '../engine/exportFile'
import { CATEGORIES, type AttrSchema } from '../engine/extractor'
import { opGroup, opGroupLabel, opTitle, type OpBlock } from '../engine/ops'
import RelationGraph from './RelationGraph.vue'
import CharacterDetail from './CharacterDetail.vue'
import Icon from '../components/Icon.vue'
import type { Character, Relation, Worldbook, Entry, Op } from '../types'

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
  showToast(o ? '已梳理世界观总览' : (chat.error || '梳理失败'))
}

// ---- v1.5 AI 操作审计（临时区） ----
const pendingOps = ref<Op[]>([])
async function refreshOps() {
  const cid = chat.currentCampaignId
  pendingOps.value = cid
    ? await db.ops.where('campaignId').equals(cid).and((o) => o.status === 'pending').toArray()
    : []
}
watch(() => chat.currentCampaignId, refreshOps)
// v-show 常驻下无重挂载：AI 提交操作（lastOpCount 变化）时刷新
watch(() => chat.lastOpCount, () => refreshOps())
onMounted(refreshOps)

function opPayload(op: Op): OpBlock {
  try { return JSON.parse(op.payload) as OpBlock } catch { return { op: op.kind } }
}
/** key 宽松匹配（与 store 一致：相等/互相包含） */
function eMatch(eKey: string, key?: string): boolean {
  const a = (eKey || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean)
  const b = (key || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean)
  return a.some((x) => b.includes(x) || b.some((y) => y.includes(x) || x.includes(y)))
}
/** 操作展示视图（标题/预览/diff） */
function opView(op: Op): { group: string; groupLabel: string; title: string; preview: string; before?: string; after?: string } {
  const p = opPayload(op)
  const g = opGroup(op.kind)
  const title = opTitle(p)
  let preview = ''
  let before: string | undefined
  let after: string | undefined
  if (op.kind === 'entry.upsert') {
    const exist = activeWorldEntries().find((e) => !e.key || eMatch(e.key, p.key))
    if (exist) { before = exist.content; after = p.content ?? '' }
    else if (p.content) preview = `新条目：${p.content.slice(0, 80)}`
  } else if (op.kind === 'entry.delete' || op.kind === 'entry.disable') {
    preview = activeWorldEntries().find((e) => !e.key || eMatch(e.key, p.key))?.content ?? '（在当前生效条目中未找到，确认后可能无效果）'
  } else if (op.kind === 'char.upsert') {
    preview = [p.identity, p.realm && schema.value.realmLabel ? `${schema.value.realmLabel}：${p.realm}` : '', p.description && p.description.slice(0, 60)].filter(Boolean).slice(0, 2).join(' · ')
    if ((p.attrs ?? []).length) preview += ` · 属性 ${(p.attrs ?? []).map((a) => `${a.label}${a.value}`).join('/')}`
  } else if (op.kind === 'schema.propose') {
    preview = (p.dims ?? []).map((d) => d.label).filter(Boolean).join('、') + (p.realmLabel ? `（${p.realmLabel}）` : '')
  } else if (op.kind === 'rel.upsert' || op.kind === 'rel.delete') {
    preview = p.label ?? ''
  }
  return { group: g, groupLabel: opGroupLabel(op.kind), title, preview, before, after }
}

async function confirmOp(op: Op) {
  const ok = await chat.executeOp(op.id!)
  showToast(ok ? '已执行' : (chat.error || '执行失败（目标不存在）'))
  await refreshOps()
  await refreshChars()
}
async function rejectOp(op: Op) {
  await chat.rejectOp(op.id!)
  await refreshOps()
}
async function confirmAllOps() {
  const n = await chat.acceptAllOps()
  showToast(`已执行 ${n} 项操作${pendingOps.value.some((o) => opGroup(o.kind) === 'del') ? '（删除类未包含，请逐条确认）' : ''}`)
  await refreshOps()
  await refreshChars()
}

const pendingEntries = ref<Entry[]>([])

/** 世界 tab：按类别分组的条目（候选类别在前，自定义类别在后） */
const worldGroups = computed(() => {
  const entries = activeWorldEntries()
  const groups = new Map<string, Entry[]>()
  for (const e of entries) {
    const cat = e.category || '其他'
    if (!groups.has(cat)) groups.set(cat, [])
    groups.get(cat)!.push(e)
  }
  const ordered = CATEGORIES.filter((c) => groups.has(c)).map((c) => ({ category: c as string, entries: groups.get(c)! }))
  for (const cat of groups.keys()) {
    if (!(CATEGORIES as readonly string[]).includes(cat)) ordered.push({ category: cat, entries: groups.get(cat)! })
  }
  return ordered
})

/** 类别卡概括：梳理过的 block 内容优先，否则首条截断 */
function catSummary(cat: string): string {
  const b = overview.value?.blocks.find((x) => x.category === cat)
  if (b?.content) return b.content
  const g = worldGroups.value.find((x) => x.category === cat)
  const first = g?.entries[0]
  return first ? `${first.content.slice(0, 70)}${first.content.length > 70 ? '…' : ''}` : ''
}

/** 类别卡详情（全屏） */
const catDetail = ref<string | null>(null)
const catEntries = computed(() =>
  catDetail.value ? worldGroups.value.find((x) => x.category === catDetail.value)?.entries ?? [] : [],
)

/**
 * v1.8.1：类别内重复组（触发词归一化后相同 且 正文完全一致）。
 * 来源：AI 提取是软去重（提示词），反复提取会写出内容一致的双胞胎。
 */
const dupGroups = computed(() => {
  const groups = new Map<string, Entry[]>()
  for (const e of catEntries.value) {
    const key = (e.key || '').split(/[,，]/).map((k) => k.trim()).filter(Boolean).sort().join('|')
    const sig = `${key}::${e.content.trim()}`
    if (!groups.has(sig)) groups.set(sig, [])
    groups.get(sig)!.push(e)
  }
  return Array.from(groups.values()).filter((g) => g.length > 1)
})
/** 重复条目总数（每组 -1 = 冗余条数） */
const dupCount = computed(() => dupGroups.value.reduce((n, g) => n + g.length - 1, 0))
async function cleanDupes() {
  const total = dupCount.value
  if (!total) return
  if (!confirm(`将删除 ${total} 条重复设定（每组保留最新一条），确定？`)) return
  let n = 0
  for (const g of dupGroups.value) {
    g.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    for (const e of g.slice(1)) if (e.id) { await ds.deleteEntry(e.id); n++ }
  }
  showToast(`已清理 ${n} 条重复设定`)
}
async function deleteCategory(cat: string) {
  const ents = worldGroups.value.find((x) => x.category === cat)?.entries ?? []
  if (!confirm(`删除「${cat}」卡将删除 ${ents.length} 条设定，确定？`)) return
  for (const e of ents) if (e.id) await ds.deleteEntry(e.id)
  catDetail.value = null
  showToast(`已删除「${cat}」`)
}
const editCat = ref(false)
const editCatName = ref('')
function beginRenameCat(cat: string) {
  editCatName.value = cat
  editCat.value = true
}
async function renameCategory(cat: string) {
  const name = editCatName.value.trim()
  editCat.value = false
  if (!name || name === cat) return
  const ents = worldGroups.value.find((x) => x.category === cat)?.entries ?? []
  for (const e of ents) await ds.saveEntry({ ...e, category: name, updatedAt: Date.now() })
  catDetail.value = null
  showToast(`「${cat}」已并入「${name}」`)
}
async function openNewEntryIn(cat: string) {
  const nbw = await chat.ensureNotebook()
  openEdit({ worldbookId: nbw.id!, source: 'manual', enabled: 1, createdAt: 0, updatedAt: 0, key: '', content: '', category: cat } as Entry)
}

/** 条目编辑器类别选择（支持新建类别） */
const catSel = ref('其他')
const catNewName = ref('')

// ---- v1.8 血条设定（存档级） ----
const barDraft = ref(chat.barSchema())
function refreshBarDraft() { barDraft.value = JSON.parse(JSON.stringify(chat.barSchema())) }
watch(() => chat.currentCampaignId, refreshBarDraft)
onMounted(refreshBarDraft)
function addBar() {
  barDraft.value.bars.push({ id: `b${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, name: '', color: '#98c379', max: 100, enabled: true })
}
function delBar(i: number) { barDraft.value.bars.splice(i, 1) }
async function saveBars() {
  const bars = barDraft.value.bars
    .filter((b) => b.name.trim())
    .map((b) => ({ ...b, name: b.name.trim(), max: Math.max(1, Number(b.max) || 100) }))
  if (!bars.length) { showToast('至少保留一条状态条'); return }
  await chat.saveBarSchema({ bars })
  refreshBarDraft()
  showToast('状态条已保存')
}

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
    maxValue: Math.max(1, Math.min(100, Math.round(Number(s.maxValue) || 10))),
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
  const category = catSel.value === '__new__' ? catNewName.value.trim() : (catSel.value || '其他')
  await ds.saveEntry({
    ...e,
    createdAt: e.createdAt || Date.now(),
    updatedAt: Date.now(),
    enabled: e.enabled ? 1 : 0,
    source: e.source || 'manual',
    category: category || '其他',
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

// ---- v1.7：世界书卡详情 + 多存档绑定 ----
const wbDetail = ref<Worldbook | null>(null)
const bindPickerOpen = ref(false)
const bindPickerWb = ref<Worldbook | null>(null)
const bindChecks = ref<Record<number, boolean>>({})

async function openBindPicker(wb: Worldbook) {
  bindPickerWb.value = wb
  const all = await db.campaignBindings.toArray()
  const map: Record<number, boolean> = {}
  for (const b of all) {
    if (b.worldbookId === wb.id!) map[b.campaignId] = true
  }
  bindChecks.value = map
  bindPickerOpen.value = true
}

async function toggleBindCampaign(cid: number) {
  const wb = bindPickerWb.value
  if (!wb?.id) return
  const exist = await db.campaignBindings.where('campaignId').equals(cid).and((b) => b.worldbookId === wb.id).first()
  if (exist) {
    await db.campaignBindings.delete(exist.id!)
  } else {
    await db.campaignBindings.add({ campaignId: cid, worldbookId: wb.id, mode: 'ref', createdAt: Date.now() })
  }
  bindChecks.value = { ...bindChecks.value, [cid]: !bindChecks.value[cid] }
  await refreshBindings()
}

function wbDetailEntries(wb: Worldbook): Entry[] {
  return entriesOfWb(wb.id!).filter((x) => x.status !== 'rejected')
}

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
  catNewName.value = ''
  catSel.value = e.category || '其他'
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
      <div class="page-title" style="margin:0; display:flex; align-items:center; gap:7px"><span style="color:var(--accent-deep); display:flex"><Icon name="panel" :size="18" /></span>面板</div>
      <button class="btn btn-soft btn-sm" @click="showCampaigns = true">
        <Icon name="book" :size="13" /> {{ campaignName }} <Icon name="chevronDown" :size="11" style="opacity:.7" />
      </button>
    </header>

    <!-- 选项栏 -->
    <div class="panel-tabs">
      <button class="btn btn-sm" :class="tab === 'chars' ? 'btn-primary' : 'btn-ghost'" @click="tab='chars'"><Icon name="user" :size="14" /> 角色</button>
      <button class="btn btn-sm" :class="tab === 'rels' ? 'btn-primary' : 'btn-ghost'" @click="tab='rels'"><Icon name="network" :size="14" /> 关系</button>
      <button class="btn btn-sm" :class="tab === 'world' ? 'btn-primary' : 'btn-ghost'" @click="tab='world'"><Icon name="globe" :size="14" /> 世界</button>
      <button class="btn btn-sm" :class="tab === 'config' ? 'btn-primary' : 'btn-ghost'" @click="tab='config'"><Icon name="gear" :size="14" /> 配置</button>
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
        上次整理：角色 {{ organizeStats.chars }} · 关系 {{ organizeStats.rels }} · 事实 {{ organizeStats.facts }}
        （{{ new Date(organizeStats.at).toLocaleTimeString() }}）
      </div>
      <button
        class="btn btn-soft btn-block" style="margin-top: 14px"
        :disabled="chat.organizing"
        @click="organizeNow"
      >{{ chat.organizing ? '思客正在记录…' : '整理世界书（提取角色/事实）' }}</button>
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
          <b style="flex:1"><Icon name="sliders" :size="15" /> 属性设定（存档级）</b>
          <button class="btn btn-warm btn-sm" :disabled="schemaLoading" style="margin-right:6px" @click="suggestSchema">
            {{ schemaLoading ? '生成中…' : '按交流建议' }}
          </button>
          <button class="btn btn-ghost btn-sm" @click="beginSchemaEdit"><Icon name="pencil" :size="13" /> 编辑</button>
        </div>
        <div class="list-sub" style="margin-bottom:6px">
          本存档的属性维度：<span v-for="d in schema.dims" :key="d.label" class="entry-tag tag-constant" style="margin:2px 3px 0 0">{{ d.label }}</span>
          <template v-if="schema.realmLabel"> · 境界标签：{{ schema.realmLabel }}（角色单个标签，如：金丹期）</template>
          · 属性上限 {{ schema.maxValue }}
        </div>

        <!-- 编辑/建议预览 -->
        <div v-if="schemaEdit" class="opt-detail" style="border-top:1px solid var(--line)">
          <label style="font-size:12.5px; color:var(--accent-deep); font-weight:600; display:block; margin-bottom:6px">维度（4~8 个，可改）</label>
          <div v-for="(d, i) in schemaDraft.dims" :key="i" class="attr-edit-row">
            <input v-model="d.label" placeholder="维度名" style="flex:1" />
            <button class="btn btn-danger btn-sm" @click="delDim(i)"><Icon name="xmark" :size="12" /></button>
          </div>
          <button class="btn btn-soft btn-sm" style="margin-top:6px" @click="addDim">＋ 维度</button>
          <div class="field" style="margin-top:10px">
            <label>境界标签（留空 = 不显示境界）</label>
            <input v-model="schemaDraft.realmLabel" placeholder="如：境界 / 段位" />
          </div>
          <div class="field" style="margin-top:10px">
            <label>属性上限（属性值最大多少，1~100）</label>
            <input v-model.number="schemaDraft.maxValue" type="number" min="1" max="100" placeholder="默认 10" />
          </div>
          <div style="display:flex; gap:10px; margin-top:4px">
            <button class="btn btn-ghost" style="flex:1" @click="schemaEdit = false">取消</button>
            <button class="btn btn-primary" style="flex:2" @click="saveSchema">保存</button>
          </div>
        </div>
      </div>

      <!-- 血条设定（存档级） -->
      <div class="card" style="margin-bottom:12px">
        <b style="margin-bottom:6px; display:block"><Icon name="sliders" :size="15" /> 血条设定（存档级）</b>
        <div class="list-sub" style="margin-bottom:8px">
          内置模板：血条（红）/ 蓝条（蓝）/ 经验（黄）。开启的条显示在角色页与游戏栏，AI 每轮自动报数更新；第一张角色卡为主角（状态条展示主角）。
        </div>
        <div v-for="(b, i) in barDraft.bars" :key="b.id" class="attr-edit-row">
          <input type="color" v-model="b.color" style="width:36px; height:34px; padding:2px; flex-shrink:0" />
          <input v-model="b.name" placeholder="条名" style="flex:1" />
          <input v-model.number="b.max" type="number" min="1" max="9999" style="width:72px" placeholder="上限" />
          <label style="display:flex; align-items:center; gap:3px; font-size:12px; white-space:nowrap">
            <input type="checkbox" v-model="b.enabled" style="width:auto" /> 开
          </label>
          <button class="btn btn-danger btn-sm" @click="delBar(i)"><Icon name="xmark" :size="11" /></button>
        </div>
        <div style="display:flex; gap:8px; margin-top:6px">
          <button class="btn btn-soft btn-sm" style="flex:1" @click="addBar">＋ 自定义条</button>
          <button class="btn btn-primary btn-sm" style="flex:1" @click="saveBars">应用</button>
        </div>
      </div>

      <!-- 临时区：AI 新展开的信息 -->
      <div v-if="pendingEntries.length" class="card" style="margin-bottom:12px; border:1px solid var(--warm)">
        <div style="display:flex; align-items:center; margin-bottom:8px">
          <b style="flex:1"><Icon name="archive" :size="15" /> 临时区（AI 新展开 {{ pendingEntries.length }} 条）</b>
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
          <button class="btn btn-warm btn-sm" title="确认写入世界书" @click="acceptEntry(e)"><Icon name="check" :size="13" /></button>
          <button class="btn btn-ghost btn-sm" title="编辑" @click="openEdit(e)">编</button>
          <button class="btn btn-danger btn-sm" title="丢弃" @click="rejectEntry(e)"><Icon name="xmark" :size="13" /></button>
        </div>
      </div>

      <!-- AI 操作审计（交流栏主持替玩家写世界书） -->
      <div v-if="pendingOps.length" class="card" style="margin-bottom:12px; border:1px solid var(--accent)">
        <div style="display:flex; align-items:center; margin-bottom:8px">
          <b style="flex:1"><Icon name="hand" :size="15" /> AI 操作（{{ pendingOps.length }} 项待确认）</b>
          <button class="btn btn-soft btn-sm" @click="confirmAllOps">全部确认（不含删除）</button>
        </div>
        <div class="list-sub" style="margin-bottom:6px">
          这是你让主持记录/修改/删除的设定；确认才执行，退回则不生效。
        </div>
        <div v-for="op in pendingOps" :key="op.id" class="entry-item">
          <span class="entry-tag" :class="{
            'tag-constant': opView(op).group === 'new',
            'tag-trigger': opView(op).group === 'mod' || opView(op).group === 'attr',
            'tag-warm': opView(op).group === 'rename',
            'tag-danger': opView(op).group === 'del',
          }">{{ opView(op).groupLabel }}</span>
          <div style="flex:1; min-width:0">
            <div class="list-title" style="font-size:13px">{{ opView(op).title }}</div>
            <div v-if="opView(op).before !== undefined" class="list-sub" style="white-space:pre-wrap">
              <span style="text-decoration:line-through; opacity:.6">{{ (opView(op).before || '').slice(0, 60) }}</span>
              <span style="color:var(--ok)"> → {{ (opView(op).after || '').slice(0, 60) }}</span>
            </div>
            <div v-else class="list-sub" style="white-space:pre-wrap">{{ opView(op).preview }}</div>
          </div>
          <button
            class="btn btn-sm" :class="opView(op).group === 'del' ? 'btn-danger' : 'btn-warm'"
            @click="confirmOp(op)"
          >{{ opView(op).group === 'del' ? '确认删除' : '确认' }}</button>
          <button class="btn btn-ghost btn-sm" @click="rejectOp(op)">退回</button>
        </div>
      </div>

      <!-- 总览条（一句话 + 更新/梳理） -->
      <div class="card" style="margin-bottom:12px; padding:10px 14px">
        <div style="display:flex; align-items:center; gap:8px">
          <span style="color:var(--accent-deep); display:flex"><Icon name="globe" :size="16" /></span>
          <div class="detail-text" style="flex:1; margin:0">
            {{ overview?.summary || '还没有世界观总览 —— 点「梳理」让 AI 提炼一卷' }}
          </div>
          <button class="btn btn-warm btn-sm" :disabled="chat.organizing" @click="refreshWorld" title="同步最新设定">
            <Icon name="refresh" :size="13" />
          </button>
          <button class="btn btn-soft btn-sm" :disabled="chat.organizing" @click="doOverview">
            {{ overview ? '梳理' : '梳理' }}
          </button>
        </div>
        <div v-if="staleOverview" class="list-sub" style="margin-top:6px; color:var(--warm)">
          有新内容未梳理 —— 点「梳理」更新总览
        </div>
      </div>

      <!-- 设定类别卡 -->
      <div v-if="!worldGroups.length" class="empty-hint">
        还没有已确认的设定<br />确认上方临时区的内容，或点卡进详情新增
      </div>
      <div v-for="g in worldGroups" :key="g.category" class="card world-cat-card" @click="catDetail = g.category">
        <div class="world-cat-head">
          <div style="flex:1; min-width:0">
            <b><Icon name="globe" :size="14" /> {{ g.category }}</b>
            <span class="list-sub" style="margin-left:8px">{{ g.entries.length }} 条</span>
          </div>
          <button class="btn btn-ghost btn-sm" @click.stop="beginRenameCat(g.category)" title="重命名类别">
            <Icon name="pencil" :size="13" />
          </button>
          <button class="btn btn-danger btn-sm" @click.stop="deleteCategory(g.category)" title="删除整卡">
            <Icon name="trash" :size="13" />
          </button>
          <span class="collapse-arrow"><Icon name="chevronDown" :size="12" /></span>
        </div>
        <div class="list-sub" style="margin-top:4px">{{ catSummary(g.category) }}</div>
      </div>
      <div class="list-sub" style="text-align:center; margin:4px 0 8px">点类别卡查看/编辑内容 · 想自建类别？到「配置 → 世界书 → ＋ 条目」里选「新建类别」</div>
    </div>

    <!-- 类别卡详情（全屏） -->
    <div v-if="catDetail" class="modal-full">
      <div style="display:flex; align-items:center; gap:8px; max-width:640px; margin:0 auto">
        <span style="color:var(--accent-deep); display:flex"><Icon name="globe" :size="18" /></span>
        <div style="flex:1">
          <div style="font-size:18px; font-weight:700">{{ catDetail }}</div>
          <div class="list-sub">{{ catEntries.length }} 条设定</div>
        </div>
        <button class="btn btn-warm btn-sm" @click="openNewEntryIn(catDetail)">＋ 新增条目</button>
        <button class="btn btn-ghost btn-sm" @click="catDetail = null"><Icon name="xmark" :size="14" /></button>
      </div>
      <div v-if="dupCount > 0" style="max-width:640px; margin:10px auto 0; padding:10px 12px; border:1px solid var(--warn); border-radius: var(--radius-sm); background: var(--warm-soft); display:flex; align-items:center; gap:8px">
        <Icon name="warn" :size="15" style="color:var(--warn)" />
        <span style="flex:1; font-size:12.5px; color:var(--ink)">
          检测到 {{ dupGroups.length }} 组重复设定（共 {{ dupCount }} 条冗余）——同触发词且内容一致，通常由 AI 反复提取产生
        </span>
        <button class="btn btn-warm btn-sm" @click="cleanDupes">一键清理</button>
      </div>
      <div class="card" style="max-width:640px; margin:12px auto 0">
        <div v-if="!catEntries.length" class="empty-hint">这个类别还是空的 —— 点右上角新增</div>
        <div v-for="e in catEntries" :key="e.id" class="entry-item">
          <span class="entry-tag" :class="e.key ? 'tag-trigger' : 'tag-constant'" :style="!e.enabled ? 'opacity:.45' : ''">
            {{ !e.enabled ? '停用' : (e.key ? e.key.split(/[,，]/)[0].slice(0, 8) : '常驻') }}
          </span>
          <div style="flex:1; min-width:0">
            <div class="list-sub" style="white-space:pre-wrap; font-size:13px; color:var(--ink)">{{ e.content }}</div>
          </div>
          <button class="btn btn-ghost btn-sm" :title="e.enabled ? '停用' : '启用'" @click="toggleEntryEnabled(e)">{{ e.enabled ? '停' : '启' }}</button>
          <button class="btn btn-ghost btn-sm" @click="openEdit(e)">编</button>
          <button class="btn btn-danger btn-sm" @click="removeEntry(e)">删</button>
        </div>
      </div>
    </div>

    <!-- 类别重命名弹层 -->
    <div v-if="editCat" class="modal-mask" @click.self="editCat = false">
      <div class="modal-sheet">
        <div class="modal-title">重命名类别</div>
        <div class="field">
          <label>新类别名（原有条目全部并入）</label>
          <input v-model="editCatName" placeholder="如：饮食文化" />
        </div>
        <div style="display:flex; gap:10px">
          <button class="btn btn-ghost" style="flex:1" @click="editCat = false">取消</button>
          <button class="btn btn-primary" style="flex:2" @click="catDetail ? renameCategory(catDetail) : (editCat = false)">保存</button>
        </div>
      </div>
    </div>

    <!-- ===== 配置 ===== -->
    <div v-if="tab === 'config'">
      <div class="list-sub" style="margin-bottom:10px">
        绑定说明：世界书被存档「绑定」后，其已确认条目会注入该存档的对话。
      </div>

      <!-- 世界书（书本卡） -->
      <div class="card" style="margin-bottom:12px">
        <div class="collapse-head" @click="showWbSection = !showWbSection">
          <b><Icon name="library" :size="15" /> 世界书（{{ wbList.length }} 本）</b>
          <span class="collapse-arrow">{{ showWbSection ? '收起' : '展开' }}</span>
        </div>
        <template v-if="showWbSection">
          <div style="display:flex; gap:8px; margin:8px 0 12px">
            <button class="btn btn-warm btn-sm" style="flex:1" @click="download('世界书格式规范.md', formatSpecMarkdown, 'text/markdown')">
              <Icon name="doc" :size="13" /> 规范.md
            </button>
            <button class="btn btn-warm btn-sm" style="flex:1" @click="download('worldbook-schema.json', formatSpecSchema)">
              <Icon name="braces" :size="13" /> Schema.json
            </button>
            <button class="btn btn-soft btn-sm" style="flex:1" @click="showImportModal = true"><Icon name="download" :size="13" /> 导入</button>
          </div>

          <!-- 书本卡网格 -->
          <div v-if="!wbList.length" class="empty-hint">还没有世界书</div>
          <div v-else class="wb-card-grid">
            <div v-for="wb in wbList" :key="wb.id" class="card wb-card" @click="wbDetail = wb">
              <div style="display:flex; align-items:flex-start; gap:8px">
                <span style="color:var(--accent-deep); display:flex; margin-top:2px"><Icon name="library" :size="18" /></span>
                <div style="flex:1; min-width:0">
                  <div class="wb-title" style="font-weight:700">{{ wb.name }}</div>
                  <div class="list-sub" style="margin-top:2px">
                    {{ entriesOfWb(wb.id!).filter(x => x.status !== 'rejected').length }} 条
                    <span v-if="nb(wb)" class="entry-tag tag-warm" style="margin-left:6px">AI 自动</span>
                  </div>
                  <div class="list-sub" style="overflow:hidden; max-height:34px">{{ wb.description || '（无描述）' }}</div>
                </div>
              </div>
              <div style="display:flex; gap:6px; margin-top:6px">
                <button class="btn btn-soft btn-sm" style="flex:1" @click.stop="wbDetail = wb">打开</button>
                <button class="btn btn-ghost btn-sm" style="flex:1" @click.stop="openBindPicker(wb)">
                  <Icon name="link" :size="12" /> 绑定
                </button>
              </div>
            </div>
          </div>

          <button class="btn btn-soft btn-block" style="margin-top:10px" @click="editWb = { name: '新世界书', scope: 'campaign', createdAt: 0, updatedAt: 0 }; showWbEditor = true">
            ＋ 新建世界书
          </button>
        </template>
      </div>

      <!-- 变量查看器（折叠） -->
      <div class="card">
        <div class="collapse-head" @click="showVarsSection = !showVarsSection">
          <b><Icon name="dna" :size="15" /> 会话变量（{{ varsEntries.length }}）</b>
          <span class="collapse-arrow">{{ showVarsSection ? '收起' : '展开' }}</span>
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
      :bars="chat.barDefs()"
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
              {{ c.gameStarted ? '游戏中' : '交流中' }} · 更新于 {{ new Date(c.lastActive).toLocaleString() }}
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
          <select v-model="catSel">
            <option v-for="c in CATEGORIES" :key="c" :value="c">{{ c }}</option>
            <option value="__new__">＋ 新建类别…</option>
          </select>
          <input v-if="catSel === '__new__'" v-model="catNewName" placeholder="新类别名，如：饮食文化" style="margin-top:6px" />
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

    <!-- 世界书详情（全屏） -->
    <div v-if="wbDetail" class="modal-full">
      <div style="display:flex; align-items:center; gap:8px; max-width:640px; margin:0 auto">
        <span style="color:var(--accent-deep); display:flex"><Icon name="library" :size="18" /></span>
        <div style="flex:1; min-width:0">
          <div style="font-size:18px; font-weight:700">{{ wbDetail.name }}</div>
          <div class="list-sub">{{ wbDetailEntries(wbDetail).length }} 条 · {{ wbDetail.description || '（无描述）' }}</div>
        </div>
        <button class="btn btn-warm btn-sm" @click="openBindPicker(wbDetail)"><Icon name="link" :size="12" /> 绑定</button>
        <button class="btn btn-ghost btn-sm" @click="exportWb(wbDetail)">导出</button>
        <button class="btn btn-danger btn-sm" @click="ds.deleteWorldbook(wbDetail.id!); wbDetail = null">删</button>
        <button class="btn btn-ghost btn-sm" @click="wbDetail = null"><Icon name="xmark" :size="14" /></button>
      </div>
      <div class="card" style="max-width:640px; margin:12px auto 0">
        <div v-if="!wbDetailEntries(wbDetail).length" class="empty-hint">这本世界书还是空的</div>
        <div v-for="e in wbDetailEntries(wbDetail)" :key="e.id" class="entry-item">
          <span class="entry-tag" :class="e.key ? 'tag-trigger' : 'tag-constant'" :style="!e.enabled ? 'opacity:.45' : ''">
            {{ !e.enabled ? '停用' : (e.status === 'pending' ? '待审' : (e.key ? e.key.split(/[,，]/)[0].slice(0, 8) : '常驻')) }}
          </span>
          <div style="flex:1; min-width:0">
            <div class="list-sub" style="white-space:pre-wrap; font-size:13px; color:var(--ink)">{{ e.content }}</div>
          </div>
          <button class="btn btn-ghost btn-sm" :title="e.enabled ? '停用' : '启用'" @click="toggleEntryEnabled(e)">{{ e.enabled ? '停' : '启' }}</button>
          <button class="btn btn-ghost btn-sm" @click="openEdit(e)">编</button>
          <button class="btn btn-danger btn-sm" @click="removeEntry(e)">删</button>
        </div>
        <button class="btn btn-soft btn-block" style="margin-top:10px"
          @click="openEdit({ worldbookId: wbDetail.id!, source: 'manual', enabled: 1, createdAt: 0, updatedAt: 0, key: '', content: '' } as Entry)"
        >＋ 条目</button>
      </div>
    </div>

    <!-- 绑定存档弹层 -->
    <div v-if="bindPickerOpen" class="modal-mask" @click.self="bindPickerOpen = false">
      <div class="modal-sheet">
        <div class="modal-title">绑定存档 —— {{ bindPickerWb?.name }}</div>
        <div class="list-sub" style="margin-bottom:8px">
          被勾选的存档，其对话会注入这本书的已确认条目。
        </div>
        <div v-if="!ds.campaigns.length" class="empty-hint">还没有存档</div>
        <div v-for="c in ds.campaigns" :key="c.id" class="list-row">
          <div class="list-title">{{ c.name }}</div>
          <input
            type="checkbox"
            style="width:auto"
            :checked="!!bindChecks[c.id!]"
            @change="toggleBindCampaign(c.id!)"
          />
        </div>
        <button class="btn btn-ghost btn-block" style="margin-top:12px" @click="bindPickerOpen = false">完成</button>
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
        <button class="btn btn-primary btn-block" @click="saveWb">创建</button>
      </div>
    </div>

    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>

<script lang="ts">
export default { name: 'PanelView' }
</script>
