<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { db } from '../db'
import { useDataStore } from '../stores/data'
import { useChatStore } from '../stores/chat'
import { formatSpecMarkdown, formatSpecSchema } from '../engine/specExport'
import { exportFile } from '../engine/exportFile'
import RelationGraph from './RelationGraph.vue'
import CharacterDetail from './CharacterDetail.vue'
import type { Character, Relation, Worldbook, Entry } from '../types'

const ds = useDataStore()
const chat = useChatStore()

const tab = ref<'chars' | 'rels' | 'worlds' | 'vars'>('chars')
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

onMounted(() => refreshChars())
watch(() => chat.currentCampaignId, () => refreshChars())
watch(() => ds.entries.length, () => refreshPending())

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
  })
  showEntryEditor.value = false
  editEntry.value = null
  await refreshPending()
  if (isNew) await refreshChars()
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

// ---- 角色详情弹层 ----
const charDetail = ref<Character | null>(null)
function openDetail(c: Character) { charDetail.value = c }
async function onCharSaved() { await refreshChars() }
</script>

<template>
  <div class="page">
    <div class="page-title">🎭 面板</div>

    <!-- 子导航 -->
    <div style="display:flex; gap:8px; margin-bottom:14px">
      <button class="btn btn-sm" :class="tab === 'chars' ? 'btn-primary' : 'btn-ghost'" @click="tab='chars'">👤 角色</button>
      <button class="btn btn-sm" :class="tab === 'rels' ? 'btn-primary' : 'btn-ghost'" @click="tab='rels'">🕸 关系</button>
      <button class="btn btn-sm" :class="tab === 'worlds' ? 'btn-primary' : 'btn-ghost'" @click="tab='worlds'">📚 世界书</button>
      <button class="btn btn-sm" :class="tab === 'vars' ? 'btn-primary' : 'btn-ghost'" @click="tab='vars'">🧬 变量</button>
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
          <div class="list-sub">{{ c.identity || '身份未知' }}</div>
          <div v-if="c.description" class="list-sub" style="margin-top:4px; max-height:44px; overflow:hidden">
            {{ c.description }}
          </div>
          <div class="entry-tag" :class="c.source === 'ai' ? 'tag-trigger' : 'tag-constant'" style="margin-top:6px">
            {{ c.source === 'ai' ? 'AI 提取' : '手动' }}
          </div>
        </div>
      </div>
      <div
        v-if="organizeStats"
        class="list-sub" style="margin-top:10px; text-align:center"
      >
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

    <!-- ===== 世界书 ===== -->
    <div v-if="tab === 'worlds'">
      <!-- 本存档绑定的世界书（会注入对话） -->
      <div class="card" style="margin-bottom:12px">
        <b style="margin-bottom:6px; display:block">🔗 本存档绑定的世界书（注入对话）</b>
        <div v-if="!campaignLevelBindings.length" class="list-sub">未绑定——只有下面「全部接受」的笔记簿内容会进入上下文</div>
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
      <div style="display:flex; gap:8px; margin-bottom:12px">
        <button class="btn btn-warm btn-sm" style="flex:1" @click="download('世界书格式规范.md', formatSpecMarkdown, 'text/markdown')">
          📄 导出格式规范.md
        </button>
        <button class="btn btn-warm btn-sm" style="flex:1" @click="download('worldbook-schema.json', formatSpecSchema)">
          📐 导出 Schema.json
        </button>
        <button class="btn btn-soft btn-sm" style="flex:1" @click="showImportModal = true">📥 导入世界书</button>
      </div>

      <!-- 待审阅区 -->
      <div v-if="pendingEntries.length" class="card" style="margin-bottom:12px; border:1px solid var(--warm)">
        <div style="display:flex; align-items:center; margin-bottom:8px">
          <b style="flex:1">📥 待审阅（AI 新提取 {{ pendingEntries.length }} 条）</b>
          <button class="btn btn-warm btn-sm" @click="acceptAll">全部接受</button>
        </div>
        <div class="list-sub" style="margin-bottom:6px">
          接受后进入对话上下文；不想要的直接拒绝。
        </div>
        <div v-for="e in pendingEntries" :key="e.id" class="entry-item">
          <span class="entry-tag" :class="e.key ? 'tag-trigger' : 'tag-constant'">
            {{ e.key ? e.key.split(/[,，]/)[0].slice(0, 10) : '常驻' }}
          </span>
          <div style="flex:1; min-width:0">
            <div class="list-sub" style="white-space:pre-wrap">{{ e.content.slice(0, 80) }}</div>
          </div>
          <button class="btn btn-warm btn-sm" @click="acceptEntry(e)">✓</button>
          <button class="btn btn-ghost btn-sm" @click="openEdit(e)">编</button>
          <button class="btn btn-danger btn-sm" @click="rejectEntry(e)">✗</button>
        </div>
      </div>

      <div v-if="!wbList.length" class="empty-hint">还没有世界书</div>
      <div v-for="wb in wbList" :key="wb.id" class="card" style="margin-bottom: 12px">
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
          <span class="entry-tag" :class="e.key ? 'tag-trigger' : 'tag-constant'">
            {{ e.status === 'pending' ? '待审' : (e.key ? '触发' : '常驻') }}
          </span>
          <div style="flex:1; min-width:0">
            <div class="list-title" style="font-size:13px">{{ e.key || '—' }}</div>
            <div class="list-sub" style="white-space:pre-wrap; overflow:hidden; text-overflow:ellipsis; max-height:34px">
              {{ e.content }}
            </div>
          </div>
          <button class="btn btn-ghost btn-sm" @click="openEdit(e)">编</button>
        </div>
        <button class="btn btn-soft btn-sm" style="margin-top: 8px"
          @click="openEdit({ worldbookId: wb.id!, source: 'manual', enabled: 1, createdAt: 0, updatedAt: 0, key: '', content: '' } as Entry)"
        >＋ 条目</button>
      </div>

      <button class="btn btn-soft btn-block" @click="editWb = { name: '新世界书', scope: 'global', createdAt: 0, updatedAt: 0 }; showWbEditor = true">
        ＋ 新建世界书
      </button>
    </div>

    <!-- ===== 会话变量 ===== -->
    <div v-if="tab === 'vars'">
      <div class="card" style="margin-bottom: 12px">
        <b style="margin-bottom:8px; display:block">🧬 会话变量（预设引擎内部状态）</b>
        <div class="list-sub" style="margin-bottom:8px">
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
      </div>
      <div class="card" v-if="varEditKey">
        <b style="margin-bottom:8px; display:block">编辑变量</b>
        <div class="field"><label>键</label><input v-model="varEditKey" /></div>
        <div class="field"><label>值</label><textarea v-model="varEditVal" rows="3"></textarea></div>
        <button class="btn btn-primary btn-block" @click="saveVar">保存</button>
      </div>
    </div>

    <!-- 角色详情弹层 -->
    <CharacterDetail
      v-if="charDetail"
      :character="charDetail"
      @close="charDetail = null"
      @saved="onCharSaved"
    />

    <!-- 条目编辑器 -->
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
        <div class="field" style="display:flex; align-items:center; gap:8px">
          <input type="checkbox" v-model="editEntry.enabled" style="width:auto" />
          <label style="margin:0">启用</label>
        </div>
        <div style="display:flex; gap:10px">
          <button class="btn btn-ghost" style="flex:1" @click="showEntryEditor = false">取消</button>
          <button class="btn btn-primary" style="flex:2" @click="saveEntry">
            {{ editEntry.status === 'pending' ? '保存并接受' : '保存' }}
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
          角色与关系会写入当前存档（{{ chat.currentCampaign?.name || '未打开存档则仅入库' }}）。
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
  </div>
</template>

<script lang="ts">
export default { name: 'PanelView' }
</script>
