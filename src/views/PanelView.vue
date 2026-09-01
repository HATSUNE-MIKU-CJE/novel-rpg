<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { db } from '../db'
import { useDataStore } from '../stores/data'
import { useChatStore } from '../stores/chat'
import { formatSpecMarkdown, formatSpecSchema } from '../engine/specExport'
import { exportFile } from '../engine/exportFile'
import { CATEGORIES, type AttrSchema } from '../engine/extractor'
import { STATUS_CARD_TEMPLATE } from '../engine/cards'
import { entryToCharacterShape, parseCharacterPayload, parseLocationPayload, parseItemPayload, parseEventPayload, parseRulePayload, parseFactionPayload, parseTimelinePayload, cardDisplayName, kindLabel, entryDisplayText, locationPayloadJson, characterPayloadJson, itemPayloadJson, eventPayloadJson, rulePayloadJson, factionPayloadJson, timelinePayloadJson } from '../engine/cards-v3'
import { looksLikeSpecText } from '../engine/dreamParser'
import { opGroup, opGroupLabel, opTitle, type OpBlock } from '../engine/ops'
import RelationGraph from './RelationGraph.vue'
import CharacterDetail from './CharacterDetail.vue'
import Icon from '../components/Icon.vue'
import type { Character, Relation, Worldbook, Entry, Op, TrashItem , StatusCardDef } from '../types'

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
watch(() => ds.entries.length, () => { refreshPending(); refreshChars() })

const schema = computed(() => chat.attrSchema())

async function refreshChars() {
  const cid = chat.currentCampaignId
  if (!cid) { characters.value = []; relations.value = []; return }
  // v3.1：优先读世界书 kind=character 条目（唯一事实源）；老表只读兜底
  const entries = chat.characterEntries()
  if (entries.length) {
    characters.value = entries.map((e) => {
      const shape = entryToCharacterShape(e)
      shape.campaignId = cid
      return shape
    })
  } else {
    characters.value = await db.characters.where('campaignId').equals(cid).toArray()
  }
  relations.value = await db.relations.where('campaignId').equals(cid).toArray()
}

/** v3.2：该角色是否主角（人物卡条目 isMain=1） */
function charIsMain(c: Character): boolean {
  const e = chat.characterEntries().find((x) => x.id === (c as any).entryId)
  return e?.isMain === 1
}
/** v3.2：条目展示文本（按 kind 显示结构化字段） */
function entryDisplay(e: Entry): string {
  return entryDisplayText(e)
}
/** v3.1：该角色的时期标签 */
function charTimelineOf(c: Character): string {
  const e = chat.characterEntries().find((x) => x.id === (c as any).entryId)
  return e?.timeline ?? ''
}
/** v3.2：人物卡条目 id（无绑定为 undefined） */
function entryIdOf(c: Character): number | undefined {
  return (c as any).entryId || undefined
}
/** v3.2：设为主角（清除其他主角标记） */
async function setMainChar(c: Character) {
  const id = entryIdOf(c)
  if (!id) return
  const entries = chat.characterEntries()
  for (const e of entries) {
    const want = e.id === id ? 1 : 0
    if (e.isMain !== want) {
      e.isMain = want
      await db.entries.put(JSON.parse(JSON.stringify(e)))
    }
  }
  await ds.loadAll()
  await refreshChars()
  showToast(`已设「${c.name}」为主角`)
}
/** v3.1：手动迁移老角色表 → 人物卡条目 */
async function migrateChars() {
  const n = await chat.migrateLegacyCharacters()
  showToast(n ? `已迁移 ${n} 个旧角色到人物卡` : '没有可迁移的旧角色（或已迁移）')
  await refreshChars()
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
// v2.0：就地确认（交流栏操作卡）后同步刷新面板待确认区
watch(() => chat.opsVersion, () => refreshOps())
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

/** v2.1.2：疑似「写作规范」条目（AI 会反复复述 → 建议停用/移出注入） */
const specLikeEntries = computed<Entry[]>(() => {
  const out: Entry[] = []
  for (const e of ds.entries) {
    if (e.source === 'ai' && e.status !== 'accepted') continue
    if (!e.enabled || !e.content.trim()) continue
    if (looksLikeSpecText(e.content)) out.push(e)
  }
  return out
})

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
// v2.0：清理预览（先看后删，可撤销）
const cleanPreview = ref(false)
/** 清理预览快照：[保留条目, 冗余列表] */
const cleanPlan = ref<Array<{ keep: Entry; drops: Entry[] }>>([])
function beginCleanPreview() {
  cleanPlan.value = dupGroups.value.map((g) => {
    const sorted = [...g].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    return { keep: sorted[0], drops: sorted.slice(1) }
  })
  cleanPreview.value = true
}
async function cleanDupes() {
  const total = cleanPlan.value.reduce((n, x) => n + x.drops.length, 0)
  if (!total) return
  let n = 0
  for (const x of cleanPlan.value) {
    for (const e of x.drops) if (e.id) { await ds.deleteEntry(e.id); n++ }
  }
  cleanPreview.value = false
  showToast(`已清理 ${n} 条重复设定（可撤销）`)
}
/** v2.0：回收站还原 */
async function doRestore(t: TrashItem) {
  const ok = await ds.restoreTrash(t.id!)
  showToast(ok ? '已还原' : '还原失败')
}
/** v2.0：清理全部回收站 */
async function clearTrash() {
  if (!confirm('永久清空回收站？此操作不可恢复。')) return
  for (const t of ds.trashed) if (t.id) await db.trash.delete(t.id)
  await ds.loadAll()
  showToast('回收站已清空')
}
/** v2.0：条目来源标签 */
function entrySourceLabel(e: Entry): string {
  if (e.source === 'ai') return 'AI 提取/写入'
  if (e.source === 'imported') return '导入'
  return '手动'
}
function fmtDate(t?: number): string {
  if (!t) return ''
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
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

// ---- v3.2 条目编辑器：kind + 各类卡 payload ----
const EDIT_KINDS = [
  { value: 'note', label: '备注（普通条目）' },
  { value: 'character', label: '人物卡' },
  { value: 'location', label: '地理卡' },
  { value: 'item', label: '物品卡' },
  { value: 'event', label: '事件卡' },
  { value: 'rule', label: '规则卡' },
  { value: 'faction', label: '势力卡' },
  { value: 'timeline', label: '时期卡' },
]
const editKindSel = ref('note')
const editLocPayload = ref<import('../types').LocationPayload>({ name: '', region: '', danger: undefined, features: '', residents: '' })
const editItemPayload = ref<import('../types').ItemPayload>({ name: '', category: '', effect: '', holder: '', state: '' })
const editEventPayload = ref<import('../types').EventPayload>({ name: '', time: '', place: '', detail: '' })
const editRulePayload = ref<import('../types').RulePayload>({ name: '', scope: '', clauses: '', consequence: '' })
const editFactionPayload = ref<import('../types').FactionPayload>({ name: '', members: '', goal: '', territory: '', relations: '' })
const editTimelinePayload = ref<import('../types').TimelinePayload>({ name: '', range: '', overview: '' })

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

// ---- v2.2 状态卡设定（存档级） ----
const statusDraft = ref<StatusCardDef>({ enabled: false, fields: [] })
function refreshStatusDraft() { statusDraft.value = JSON.parse(JSON.stringify(chat.statusCard())) }
watch(() => chat.currentCampaignId, refreshStatusDraft)
onMounted(refreshStatusDraft)
function addStatusField() {
  statusDraft.value.fields.push({ id: `f${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, label: '', type: 'text' })
}
function delStatusField(i: number) { statusDraft.value.fields.splice(i, 1) }
function useStatusTemplate() {
  statusDraft.value.enabled = true
  statusDraft.value.fields = STATUS_CARD_TEMPLATE.map((f) => ({ ...f }))
}
async function saveStatusCard() {
  const fields = statusDraft.value.fields.filter((f) => f.label.trim()).map((f) => ({ ...f, label: f.label.trim() }))
  if (statusDraft.value.enabled && !fields.length) { showToast('启用状态卡至少需要一个字段'); return }
  await chat.saveStatusCard({ enabled: statusDraft.value.enabled, fields })
  refreshStatusDraft()
  showToast('状态卡已保存')
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
  // v3.2：kind + payload（按类型写入结构化 payload）
  const kind = editKindSel.value as Entry['kind']
  let payloadJson = e.payloadJson
  switch (kind) {
    case 'location': payloadJson = locationPayloadJson(editLocPayload.value); break
    case 'item': payloadJson = itemPayloadJson(editItemPayload.value); break
    case 'event': payloadJson = eventPayloadJson(editEventPayload.value); break
    case 'rule': payloadJson = rulePayloadJson(editRulePayload.value); break
    case 'faction': payloadJson = factionPayloadJson(editFactionPayload.value); break
    case 'timeline': payloadJson = timelinePayloadJson(editTimelinePayload.value); break
    case 'character': if (!e.payloadJson) payloadJson = characterPayloadJson({ name: e.key.trim() }); break
  }
  await ds.saveEntry({
    ...e,
    kind,
    payloadJson: kind === 'note' ? undefined : payloadJson,
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
    const dist = r.kindDist as Record<string, number> | undefined
    const distText = dist
      ? ' · ' + Object.entries(dist).map(([k, v]) => `${kindLabel(k)} ${v}`).join(' / ')
      : ''
    alert(`导入成功：条目 ${r.entryCount}${distText}${r.charCount ? ` · 角色 ${r.charCount}` : ''}${r.relCount ? ` · 关系 ${r.relCount}` : ''}\n\n已按 emoji 前缀自动分类为「卡」类型，可在世界 tab 看到 kind 徽标。`)
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

// ---- v2.0 自动化与诊断 ----
const talkAutoSel = ref(chat.currentCampaign?.talkAutoInterval ?? 0)
async function saveTalkAuto() {
  const c = chat.currentCampaign
  if (!c) return
  c.talkAutoInterval = Number(talkAutoSel.value) || 0
  await ds.saveCampaign(c)
  showToast(talkAutoSel.value ? `交流栏每 ${talkAutoSel.value} 条消息自动整理` : '已关闭自动整理')
}

// ---- v3.2 时期与注入（存档级） ----
const timelineSel = ref('')
const timelineNew = ref('')
const p1BudgetSel = ref(8)
function refreshTimelineUi() {
  timelineSel.value = chat.currentTimeline()
  p1BudgetSel.value = chat.currentCampaign?.injectP1Budget ?? 8
}
watch(() => chat.currentCampaignId, refreshTimelineUi)
onMounted(refreshTimelineUi)
// 当前时期候选 = 存档条目已用的时期标签
const usedTimelines = computed(() => {
  const set = new Set<string>()
  for (const e of ds.entries) if (e.timeline?.trim()) set.add(e.timeline.trim())
  return [...set]
})
async function saveTimeline() {
  const c = chat.currentCampaign
  if (!c) return
  const v = timelineSel.value === '__new__' ? timelineNew.value.trim() : timelineSel.value
  c.currentTimeline = v.trim() || undefined
  await ds.saveCampaign(c)
  showToast(v.trim() ? `当前时期：${v.trim()}` : '已关闭时期封存')
  refreshTimelineUi()
}
async function saveP1Budget() {
  const c = chat.currentCampaign
  if (!c) return
  c.injectP1Budget = Math.max(0, Math.min(30, Math.round(p1BudgetSel.value)))
  await ds.saveCampaign(c)
  showToast(`常驻精要预算：${c.injectP1Budget} 条`)
}
/** v2.0：导出全量世界书数据（诊断/备份） */
async function exportDiagnostics() {
  const cid = chat.currentCampaignId
  const [entries, ops, trash, chars, rels, bindings] = await Promise.all([
    cid ? db.entries.toArray() : [],          // 全量（含其他存档，便于对照）
    cid ? db.ops.where('campaignId').equals(cid).toArray() : [],
    db.trash.toArray(),
    cid ? db.characters.where('campaignId').equals(cid).toArray() : [],
    cid ? db.relations.where('campaignId').equals(cid).toArray() : [],
    cid ? db.campaignBindings.where('campaignId').equals(cid).toArray() : [],
  ])
  const data = {
    app: '梦旅 NovelRPG',
    ver: 'v2.0',
    exportedAt: new Date().toISOString(),
    campaign: chat.currentCampaign ? { id: chat.currentCampaign.id, name: chat.currentCampaign.name } : null,
    worldbooks: ds.worldbooks,
    entries,
    ops,
    trash,
    characters: chars,
    relations: rels,
    bindings,
  }
  await download(`梦旅-世界书诊断-${Date.now()}.json`, JSON.stringify(data, null, 2))
  showToast('已导出世界书数据（JSON）')
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
  // v3.2：kind 与各类卡 payload
  editKindSel.value = e.kind && e.kind !== 'note' ? e.kind : 'note'
  editLocPayload.value = { ...parseLocationPayload(e.payloadJson) }
  editItemPayload.value = { ...parseItemPayload(e.payloadJson) }
  editEventPayload.value = { ...parseEventPayload(e.payloadJson) }
  editRulePayload.value = { ...parseRulePayload(e.payloadJson) }
  editFactionPayload.value = { ...parseFactionPayload(e.payloadJson) }
  editTimelinePayload.value = { ...parseTimelinePayload(e.payloadJson) }
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
        <div v-for="c in characters" :key="c.id ?? c.name" class="char-card" @click="openDetail(c)">
          <div class="char-avatar">{{ c.name.slice(0, 1) }}</div>
          <div class="list-title" style="display:flex; align-items:center; gap:6px">
            {{ c.name }}
            <span v-if="charIsMain(c)" class="entry-tag tag-constant" :data-main="'1'">主角</span>
          </div>
          <div class="list-sub">{{ c.identity || '身份未知' }}<template v-if="c.realm"> · {{ c.realm }}</template><template v-if="charTimelineOf(c)"> · {{ charTimelineOf(c) }}</template></div>
          <div v-if="c.description" class="list-sub" style="margin-top:4px; max-height:44px; overflow:hidden">
            {{ c.description }}
          </div>
          <div class="entry-tag" :class="c.source === 'ai' ? 'tag-trigger' : 'tag-constant'" style="margin-top:6px">
            {{ c.source === 'ai' ? 'AI 提取' : '手动' }}
          </div>
          <button
            v-if="entryIdOf(c) && !charIsMain(c)"
            class="btn btn-ghost btn-sm" style="margin-top:6px; width:100%"
            @click.stop="setMainChar(c)"
          >设为主角</button>
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
      <button
        class="btn btn-warm btn-block" style="margin-top: 8px"
        @click="migrateChars"
      >迁移旧角色卡为人物卡（新模型）</button>
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
      <!-- v2.1.2 疑似写作规范条目提示（根因引导：这类条目被 AI 反复复述） -->
      <div v-if="specLikeEntries.length" class="card" style="margin-bottom:12px; border:1px solid var(--danger); padding:10px 12px">
        <div style="display:flex; align-items:center; gap:8px">
          <Icon name="warn" :size="15" style="color:var(--danger)" />
          <b style="flex:1; font-size:13px">发现 {{ specLikeEntries.length }} 条疑似「写作规范」条目</b>
        </div>
        <div class="list-sub" style="margin-top:4px">
          这类内容被当作设定注入对话后，AI 会在回复里反复复述它（就是聊天里那些「二、辨视角…」乱码的来源）。
          建议：停用或删除（写作守则应放在预设开关里，而不是世界书条目）。点下面条目卡可直接操作。
        </div>
        <div v-for="e in specLikeEntries.slice(0, 3)" :key="e.id" class="entry-item" style="padding:6px 0">
          <span class="entry-tag tag-danger">{{ e.key ? e.key.split(/[,，]/)[0].slice(0, 8) : '常驻' }}</span>
          <div style="flex:1; min-width:0" class="list-sub">{{ e.content.slice(0, 50) }}</div>
          <button class="btn btn-ghost btn-sm" @click="openEdit(e)">编</button>
          <button class="btn btn-ghost btn-sm" @click="toggleEntryEnabled(e)">{{ e.enabled ? '停' : '启' }}</button>
        </div>
      </div>

      <!-- v2.0 回收站（删除可撤销） -->
      <div v-if="ds.trashed.length" class="card" style="margin-bottom:12px; border:1px solid var(--line)">
        <div style="display:flex; align-items:center; gap:8px">
          <b style="flex:1"><Icon name="archive" :size="15" /> 回收站（{{ ds.trashed.length }} 条待恢复）</b>
          <button class="btn btn-ghost btn-sm" @click="clearTrash">清空</button>
        </div>
        <div v-for="t in ds.trashed.slice(0, 3)" :key="t.id" class="entry-item" style="padding:8px 0">
          <div style="flex:1; min-width:0" class="list-sub">{{ t.title }}</div>
          <button class="btn btn-warm btn-sm" @click="doRestore(t)">还原</button>
        </div>
      </div>

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

      <!-- v2.2 状态卡设定（存档级） -->
      <div class="card" style="margin-bottom:12px">
        <b style="margin-bottom:6px; display:block"><Icon name="clipboard" :size="15" /> 状态卡设定（存档级）</b>
        <div class="list-sub" style="margin-bottom:8px">
          游戏流正文下方的状态卡：注册字段后 AI 每轮自动报数更新，无需手动同步；「清单」字段显示为列表并随剧情追加。
        </div>
        <label style="display:flex; align-items:center; gap:6px; font-size:13px; margin-bottom:8px">
          <input type="checkbox" v-model="statusDraft.enabled" style="width:auto" /> 启用状态卡（关闭时 AI 不报数、不显示）
        </label>
        <div v-for="(f, i) in statusDraft.fields" :key="f.id" class="attr-edit-row">
          <select v-model="f.type" style="width:70px; padding:4px">
            <option value="text">单行</option>
            <option value="list">清单</option>
          </select>
          <input v-model="f.label" placeholder="字段名（如：收集物资）" style="flex:1" />
          <button class="btn btn-danger btn-sm" @click="delStatusField(i)"><Icon name="xmark" :size="12" /></button>
        </div>
        <div style="display:flex; gap:8px; margin-top:6px">
          <button class="btn btn-soft btn-sm" style="flex:1" @click="useStatusTemplate"><Icon name="sparkle" :size="12" /> 示例模板</button>
          <button class="btn btn-soft btn-sm" style="flex:1" @click="addStatusField">＋ 字段</button>
          <button class="btn btn-primary btn-sm" style="flex:1" @click="saveStatusCard">保存</button>
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
            <div class="list-title" style="font-size:13px">
              {{ opView(op).title }}
              <span v-if="opView(op).group === 'mod' && opView(op).before !== undefined" class="entry-tag tag-warm" style="margin-left:4px">将覆盖</span>
              <span v-if="op.src === 'extract'" class="entry-tag tag-constant" style="margin-left:4px">整理提取</span>
            </div>
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
        <button class="btn btn-warm btn-sm" @click="beginCleanPreview">一键清理</button>
      </div>
      <div class="card" style="max-width:640px; margin:12px auto 0">
        <div v-if="!catEntries.length" class="empty-hint">这个类别还是空的 —— 点右上角新增</div>
        <div v-for="e in catEntries" :key="e.id" class="entry-item">
          <span class="entry-tag" :class="e.key ? 'tag-trigger' : 'tag-constant'" :style="!e.enabled ? 'opacity:.45' : ''">
            {{ !e.enabled ? '停用' : (e.key ? e.key.split(/[,，]/)[0].slice(0, 8) : '常驻') }}
          </span>
          <span v-if="e.kind && e.kind !== 'note'" class="entry-tag tag-kind" :data-kind="e.kind" :style="!e.enabled ? 'opacity:.45' : ''">{{ kindLabel(e.kind) }}</span>
          <div style="flex:1; min-width:0">
            <div class="list-sub" style="white-space:pre-wrap; font-size:13px; color:var(--ink)">{{ entryDisplay(e) }}</div>
            <div class="list-sub" style="margin-top:2px; color:var(--ink-soft); font-size:10.5px">
              {{ entrySourceLabel(e) }}<template v-if="e.timeline"> · 时期：{{ e.timeline }}</template><template v-if="e.updatedAt"> · {{ fmtDate(e.updatedAt) }}</template>
            </div>
          </div>
          <button class="btn btn-ghost btn-sm" :title="e.enabled ? '停用' : '启用'" @click="toggleEntryEnabled(e)">{{ e.enabled ? '停' : '启' }}</button>
          <button class="btn btn-ghost btn-sm" @click="openEdit(e)">编</button>
          <button class="btn btn-danger btn-sm" @click="removeEntry(e)">删</button>
        </div>
      </div>
      <div style="max-width:640px; margin:14px auto 0; text-align:center">
        <button class="btn btn-danger btn-sm" @click="deleteCategory(catDetail!)"><Icon name="trash" :size="12" /> 删除整个类别（{{ catEntries.length }} 条）</button>
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

    <!-- v2.0 重复清理预览（先看后删，删除进回收站可还原） -->
    <div v-if="cleanPreview" class="modal-mask" @click.self="cleanPreview = false">
      <div class="modal-sheet">
        <div class="modal-title">清理重复设定</div>
        <div class="list-sub" style="margin-bottom:8px">删除前对比：每组保留最新一条，其余进回收站（可还原）</div>
        <div v-for="(x, i) in cleanPlan" :key="i" style="border-top:1px solid var(--line); padding:8px 0">
          <div class="list-sub" style="font-weight:600; color:var(--ok)">第 {{ i + 1 }} 组 · 保留</div>
          <div class="list-sub" style="font-size:12.5px; color:var(--ink); margin-bottom:4px">{{ x.keep.content.slice(0, 70) }}</div>
          <div class="list-sub" style="color:var(--danger)">删除 {{ x.drops.length }} 条</div>
          <div v-for="d in x.drops" :key="d.id" class="list-sub" style="font-size:11.5px; color:var(--ink-soft)">{{ d.content.slice(0, 50) }}</div>
        </div>
        <div style="display:flex; gap:10px; margin-top:12px">
          <button class="btn btn-ghost" style="flex:1" @click="cleanPreview = false">取消</button>
          <button class="btn btn-warm" style="flex:2" @click="cleanDupes">确认清理（{{ dupCount }} 条）</button>
        </div>
      </div>
    </div>

    <!-- ===== 配置 ===== -->
    <div v-if="tab === 'config'">
      <div class="list-sub" style="margin-bottom:10px">
        绑定说明：世界书被存档「绑定」后，其已确认条目会注入该存档的对话。
      </div>

      <!-- v2.0 数据与自动化 -->
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex; align-items:center; margin-bottom:8px">
          <b style="flex:1"><Icon name="gear" :size="15" /> 自动化与数据</b>
        </div>
        <div class="field" style="margin-top:0">
          <label>交流栏自动整理（聊够 N 条用户消息后自动提取设定）</label>
          <select v-model.number="talkAutoSel" @change="saveTalkAuto">
            <option :value="0">关闭（手动点「整理设定」）</option>
            <option :value="4">每 4 条消息</option>
            <option :value="6">每 6 条消息</option>
            <option :value="8">每 8 条消息</option>
          </select>
        </div>
        <div class="list-sub">游戏栏自动整理在新建存档时设置（每 N 轮）</div>
        <button class="btn btn-soft btn-block" style="margin-top:10px" @click="exportDiagnostics">
          <Icon name="download" :size="13" /> 导出世界书数据（JSON · 含待确认/回收站/操作记录）
        </button>
      </div>

      <!-- v3.2 时期与注入（存档级） -->
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex; align-items:center; margin-bottom:8px">
          <b style="flex:1"><Icon name="clock" :size="15" /> 时期与注入</b>
        </div>
        <div class="field" style="margin-top:0">
          <label>当前时期（非当前时期的条目自动封存，不注入不触发）</label>
          <div style="display:flex; gap:8px">
            <select v-model="timelineSel" style="flex:1" @change="saveTimeline">
              <option value="">关闭（不按时期封存）</option>
              <option v-for="t in usedTimelines" :key="t" :value="t">{{ t }}</option>
              <option value="__new__">＋ 新建时期…</option>
            </select>
          </div>
          <input v-if="timelineSel === '__new__'" v-model="timelineNew" placeholder="新时期名，如：神界传说" style="margin-top:8px" />
          <template v-if="timelineSel === '__new__'">
            <button class="btn btn-warm btn-sm btn-block" style="margin-top:8px" @click="saveTimeline">设置新时期</button>
          </template>
        </div>
        <div class="field">
          <label>常驻精要预算（每轮最多带几条角色一句话，默认 8）</label>
          <input v-model.number="p1BudgetSel" type="number" min="0" max="30" @change="saveP1Budget" />
        </div>
        <div class="list-sub">时期卡的更详细配置（多卡时期管理）在后续版本提供；当前先支持封存开关与标签。</div>
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
          <label>卡类型（决定这条是什么卡）</label>
          <select v-model="editKindSel">
            <option v-for="k in EDIT_KINDS" :key="k.value" :value="k.value">{{ k.label }}</option>
          </select>
        </div>
        <div class="field">
          <label>触发词（留空 = 常驻条目，始终注入）</label>
          <input v-model="editEntry.key" placeholder="如：铁炉堡, 矮人" />
        </div>
        <div class="field">
          <label>常驻精要（一句话，每轮必读；可留空）</label>
          <input v-model="editEntry.hook" placeholder="如：艾莉丝：见习法师" />
        </div>
        <!-- 地理卡字段（kind=location） -->
        <template v-if="editKindSel === 'location'">
          <div class="field"><label>地名</label><input v-model="editLocPayload.name" placeholder="如：铁炉堡" /></div>
          <div class="field"><label>所属区域</label><input v-model="editLocPayload.region" placeholder="如：星斗大森林外围" /></div>
          <div class="field"><label>危险度（0-100）</label><input v-model.number="editLocPayload.danger" type="number" min="0" max="100" placeholder="0=安全" /></div>
          <div class="field"><label>地貌/特色</label><textarea v-model="editLocPayload.features" rows="2" placeholder="如：云雾缭绕的峡谷，盛产铁矿石"></textarea></div>
          <div class="field"><label>居民/势力</label><input v-model="editLocPayload.residents" placeholder="如：矮人铁匠公会" /></div>
        </template>
        <!-- 物品卡字段（kind=item） -->
        <template v-else-if="editKindSel === 'item'">
          <div class="field"><label>物品名</label><input v-model="editItemPayload.name" placeholder="如：玄天功玉简" /></div>
          <div class="field"><label>类别</label><input v-model="editItemPayload.category" placeholder="如：功法/武器/灵药" /></div>
          <div class="field"><label>效果/用途</label><textarea v-model="editItemPayload.effect" rows="2" placeholder="效果描述"></textarea></div>
          <div class="field"><label>持有者</label><input v-model="editItemPayload.holder" placeholder="如：唐三" /></div>
          <div class="field"><label>状态</label><input v-model="editItemPayload.state" placeholder="如：破损/封印/完整" /></div>
        </template>
        <!-- 事件卡字段（kind=event） -->
        <template v-else-if="editKindSel === 'event'">
          <div class="field"><label>事件名</label><input v-model="editEventPayload.name" placeholder="如：小舞献祭" /></div>
          <div class="field"><label>时间</label><input v-model="editEventPayload.time" placeholder="如：斗一第 4 年" /></div>
          <div class="field"><label>地点</label><input v-model="editEventPayload.place" placeholder="如：星斗大森林" /></div>
          <div class="field"><label>经过/影响</label><textarea v-model="editEventPayload.detail" rows="3" placeholder="事件经过与影响"></textarea></div>
        </template>
        <!-- 规则卡字段（kind=rule） -->
        <template v-else-if="editKindSel === 'rule'">
          <div class="field"><label>规则名</label><input v-model="editRulePayload.name" placeholder="如：武魂觉醒规则" /></div>
          <div class="field"><label>适用范围</label><input v-model="editRulePayload.scope" placeholder="如：所有魂师" /></div>
          <div class="field"><label>条款/内容</label><textarea v-model="editRulePayload.clauses" rows="3" placeholder="规则条款"></textarea></div>
          <div class="field"><label>违例后果</label><input v-model="editRulePayload.consequence" placeholder="如：魂力反噬" /></div>
        </template>
        <!-- 势力卡字段（kind=faction） -->
        <template v-else-if="editKindSel === 'faction'">
          <div class="field"><label>势力名</label><input v-model="editFactionPayload.name" placeholder="如：唐门" /></div>
          <div class="field"><label>成员/首脑</label><input v-model="editFactionPayload.members" placeholder="如：唐三、唐啸" /></div>
          <div class="field"><label>目标</label><textarea v-model="editFactionPayload.goal" rows="2" placeholder="势力目标"></textarea></div>
          <div class="field"><label>地盘</label><input v-model="editFactionPayload.territory" placeholder="如：唐门后山" /></div>
          <div class="field"><label>对外关系</label><input v-model="editFactionPayload.relations" placeholder="如：与武魂殿敌对" /></div>
        </template>
        <!-- 时期卡字段（kind=timeline） -->
        <template v-else-if="editKindSel === 'timeline'">
          <div class="field"><label>时期名</label><input v-model="editTimelinePayload.name" placeholder="如：神界传说" /></div>
          <div class="field"><label>起止</label><input v-model="editTimelinePayload.range" placeholder="如：斗三起始 ~ 斗三后期" /></div>
          <div class="field"><label>概览</label><textarea v-model="editTimelinePayload.overview" rows="3" placeholder="时期概览"></textarea></div>
        </template>
        <div class="field">
          <label>内容</label>
          <textarea v-model="editEntry.content" rows="5" placeholder="这条设定的正文（触发详情）…"></textarea>
        </div>
        <div class="field">
          <label>时期（留空 = 通用；非当前时期自动封存）</label>
          <input v-model="editEntry.timeline" placeholder="如：神界传说 / 斗二" />
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
